import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, ROOT, FONTS_DIR, MAX_UPLOAD_BYTES, MAX_DURATION_SEC, MOCK_AI } from './config.js';
import { availableFonts, fontsCss } from './fonts.js';
import * as store from './store.js';
import * as ff from './ffmpeg.js';
import * as ai from './ai.js';
import { chunkSegments } from './subtitles.js';
import { buildAss, segmentsOf, totalDuration } from './ass.js';
import * as tpls from './templates.js';
import { detectSilences, buildCuts, mockCuts } from './cuts.js';
import { effectiveSegments, sanitizeTighten, TIGHTEN_DEFAULTS } from '../public/cuts.js';
import { resolveFrame, framePixels, sanitizeFrame, defaultFrame, FRAME_LIMITS, FRAME_DEFAULTS } from './layout.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/fonts', express.static(FONTS_DIR, { maxAge: '7d' }));
app.get('/fonts.css', (req, res) => res.type('text/css').send(fontsCss()));
app.use(express.static(path.join(ROOT, 'public')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpError = (status, message) => Object.assign(new Error(message), { status });

function getProject(req) {
  const p = store.get(req.params.id);
  if (!p) throw httpError(404, '프로젝트를 찾을 수 없습니다.');
  return p;
}
function getClip(p, cid) {
  const c = p.clips.find((x) => x.id === cid);
  if (!c) throw httpError(404, '쇼츠를 찾을 수 없습니다.');
  return c;
}

// ───────────────────────── 설정 / 목록 ─────────────────────────

app.get('/api/config', (req, res) => {
  res.json({ ...ai.capabilities(), fonts: availableFonts().map(({ id, label, hangulFallback }) => ({ id, label, fallback: hangulFallback || null })), positionDefaults: tpls.POSITION_DEFAULTS, frameDefaults: FRAME_DEFAULTS, subPresets: tpls.SUB_PRESETS, maxDurationMin: MAX_DURATION_SEC / 60 });
});

// ───────────────────────── 템플릿 ─────────────────────────

const markStale = (templateId) => {
  for (const pr of store.list()) {
    let changed = false;
    for (const c of pr.clips) {
      if (c.render?.status === 'done' && tpls.resolve(c.templateId).id === templateId) { c.render.stale = true; changed = true; }
    }
    if (changed) store.save(pr);
  }
};

app.get('/api/templates', (req, res) => res.json(tpls.all()));
app.post('/api/templates', (req, res) => res.status(201).json(tpls.create(req.body || {})));
app.put('/api/templates/:tid', (req, res) => {
  const t = tpls.update(req.params.tid, req.body || {});
  if (!t) throw httpError(404, '템플릿을 찾을 수 없습니다.');
  markStale(t.id);
  res.json(t);
});
app.delete('/api/templates/:tid', (req, res) => {
  const id = req.params.tid;
  if (!tpls.find(id)) throw httpError(404, '템플릿을 찾을 수 없습니다.');
  if (!tpls.remove(id)) throw httpError(400, '마지막 템플릿은 삭제할 수 없습니다.');
  res.json({ ok: true });
});

app.get('/api/projects', (req, res) => {
  res.json(store.list().map((p) => store.publicView(p, { withSubtitles: false })));
});

app.get('/api/projects/:id', (req, res) => {
  res.json(store.publicView(getProject(req), { withSubtitles: req.query.subs !== '0' }));
});

app.delete('/api/projects/:id', wrap(async (req, res) => {
  const p = getProject(req);
  if (p.status === 'analyzing') throw httpError(409, '분석 중인 프로젝트는 삭제할 수 없습니다.');
  store.remove(p.id);
  res.json({ ok: true });
}));

// ───────────────────────── 업로드 ─────────────────────────

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      req.projectId = store.newId();
      const dir = store.projectDir(req.projectId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'source' + (path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4')),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('video/') || /\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(file.originalname);
    cb(ok ? null : httpError(400, '동영상 파일(MP4, MOV, MKV, WEBM 등)만 업로드할 수 있습니다.'), ok);
  },
});

app.post('/api/projects', upload.single('video'), wrap(async (req, res) => {
  const id = req.projectId;
  const cleanup = () => store.remove(id);
  if (!req.file) { if (id) cleanup(); throw httpError(400, '영상 파일이 없습니다.'); }
  const dir = store.projectDir(id);
  let info;
  try {
    info = await ff.probe(req.file.path);
    if (!info.duration || info.duration < 5) throw httpError(400, '영상 길이를 확인할 수 없거나 너무 짧습니다.');
    if (info.duration > MAX_DURATION_SEC) throw httpError(400, `영상이 너무 깁니다. 최대 ${MAX_DURATION_SEC / 60}분까지 지원합니다.`);
    await ff.makeThumbnail(req.file.path, path.join(dir, 'thumb.jpg'), Math.min(info.duration / 4, 30));
  } catch (e) {
    cleanup();
    throw e.status ? e : httpError(400, `영상을 읽을 수 없습니다: ${e.message.split('\n')[0]}`);
  }
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const name = (req.body?.name || originalName.replace(/\.[^.]+$/, '')).slice(0, 80);
  const p = store.create({
    id, name, createdAt: Date.now(), status: 'uploaded', progress: null, error: null,
    video: { file: req.file.filename, ...info, proxy: false },
    subtitles: [], transcript: [], clips: [], analysis: null,
  });
  res.status(201).json(store.publicView(p));
  // 미리보기용 프록시를 백그라운드에서 생성
  ff.makeProxy(req.file.path, path.join(dir, 'proxy.mp4'))
    .then(() => { p.video.proxy = true; store.save(p); })
    .catch((e) => console.error('proxy 생성 실패:', e.message));
}));

app.get('/media/:id/:kind', (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.sendStatus(404);
  const dir = store.projectDir(p.id);
  const map = { source: p.video.file, proxy: 'proxy.mp4', thumb: 'thumb.jpg' };
  const f = map[req.params.kind];
  if (!f) return res.sendStatus(404);
  const full = path.join(dir, f);
  if (!fs.existsSync(full)) return res.sendStatus(404);
  res.sendFile(full);
});

// ───────────────────────── AI 분석 ─────────────────────────

app.post('/api/projects/:id/analyze', wrap(async (req, res) => {
  const p = getProject(req);
  if (p.status === 'analyzing') throw httpError(409, '이미 분석 중입니다.');
  const cap = ai.capabilities();
  if (!cap.transcription) throw httpError(400, '음성 인식이 설정되지 않았습니다. 터미널에서 `npm run setup:stt`로 로컬 음성 인식을 설치하거나 .env에 OPENAI_API_KEY를 넣으세요.');
  if (!p.video.hasAudio && !MOCK_AI) throw httpError(400, '오디오 트랙이 없는 영상은 분석할 수 없습니다.');
  const b = req.body || {};
  const minLen = clampInt(b.minLen, 10, 120, 30);
  const maxLen = Math.max(minLen + 5, clampInt(b.maxLen, 15, 180, 60));
  const opts = { minLen, maxLen, count: clampInt(b.count, 1, 10, 5), language: ['ko', 'en', 'ja', 'auto'].includes(b.language) ? b.language : 'ko', templateId: tpls.resolve(b.templateId).id, mode: b.mode === 'single' ? 'single' : 'context' };
  p.status = 'analyzing';
  p.error = null;
  p.progress = { step: 'audio', pct: 0, message: '오디오 추출 중' };
  p.analysis = opts;
  store.save(p);
  res.status(202).json(store.publicView(p));
  runAnalysis(p, opts).catch((e) => {
    console.error('분석 실패:', e);
    p.status = 'error';
    p.error = e.message;
    store.save(p);
  });
}));

const clampInt = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

async function runAnalysis(p, opts) {
  const dir = store.projectDir(p.id);
  const src = path.join(dir, p.video.file);
  const set = (step, pct, message) => { p.progress = { step, pct: Math.round(pct), message }; };

  let transcript;
  let words = [];
  if (MOCK_AI) {
    set('stt', 40, '데모 자막 생성 중');
    transcript = ai.mockTranscript(p.video.duration);
  } else {
    set('audio', 3, '오디오 추출 중');
    const chunks = await ff.extractAudioChunks(src, path.join(dir, 'audio'));
    set('stt', 10, '음성 인식(STT) 중');
    const r = await ai.transcribeChunks(chunks, {
      language: opts.language,
      onProgress: (f) => set('stt', 10 + f * 55, `음성 인식(STT) 중 ${Math.round(f * 100)}%`),
    });
    transcript = r.segments; words = r.words;
    fs.rmSync(path.join(dir, 'audio'), { recursive: true, force: true });
  }
  if (!transcript.length) throw new Error('영상에서 인식된 음성이 없습니다.');
  transcript.sort((a, b) => a.start - b.start);
  p.transcript = transcript;
  p.subtitles = chunkSegments(transcript, { maxChars: 16 });

  // 무음·군말 구간 (쇼츠에서 '무음·군말 제거'를 켤 때 사용). 실패해도 분석은 계속한다
  set('silence', 67, '무음·군말 구간 분석 중');
  try {
    p.cuts = buildCuts({ silences: MOCK_AI ? mockCuts(p.video.duration).silences : await detectSilences(src, p.video.duration), words, segments: transcript });
    if (MOCK_AI) p.cuts.fillers = mockCuts(p.video.duration).fillers;
  } catch (e) { console.error('무음 분석 실패:', e.message); p.cuts = null; }

  // 1단계: 영상 전체 맥락 → 소주제, 2단계: 소주제마다 쇼츠 1개를 컷편집 (구성 이유·피드백 포함)
  set('topics', 70, 'AI가 영상 전체 맥락을 읽고 소주제를 나누는 중');
  let topics = []; let chosen = null; let rawClips;
  if (MOCK_AI) {
    topics = ai.mockTopics(p.video.duration, opts.count);
    chosen = topics;
    rawClips = ai.mockHighlights({ topics, ...opts });
  } else {
    const r = await ai.pickHighlights({
      transcript, duration: p.video.duration, title: p.name, ...opts,
      onStage: (stage, info) => { if (stage === 'compose') set('compose', 80, `소주제 ${info.topics}개 확인 · ${info.shorts}개 소주제를 컷편집하는 중`); },
    });
    ({ topics, chosen } = r); rawClips = r.clips;
  }
  const picked = ai.normalizeClips(rawClips, { transcript, duration: p.video.duration, topics: chosen, ...opts });
  if (!picked.length) throw new Error('쇼츠로 만들 구간을 찾지 못했습니다. 길이 범위를 조정해 다시 시도해 보세요.');
  p.topics = topics.map((t) => ({ ...t, used: picked.some((c) => c.topicId === t.id) }));

  p.clips = picked.map((c) => ({
    id: store.newId(4), ...c, cropX: 0.5, cropY: 0.5, zoom: 1, frame: null, overrides: {}, tighten: p.cuts ? { ...TIGHTEN_DEFAULTS } : null, templateId: opts.templateId, subtitleOn: true, titleOn: true, render: { status: 'idle' },
  }));
  p.status = 'ready';
  p.progress = { step: 'done', pct: 100, message: '완료' };
  store.save(p);
}

// 이전에 분석한 프로젝트(무음 정보 없음)에서 무음·군말 구간만 따로 분석
app.post('/api/projects/:id/detect-cuts', wrap(async (req, res) => {
  const p = getProject(req);
  if (p.status === 'analyzing') throw httpError(409, '분석 중입니다.');
  const src = path.join(store.projectDir(p.id), p.video.file);
  const silences = MOCK_AI ? mockCuts(p.video.duration).silences : await detectSilences(src, p.video.duration);
  p.cuts = buildCuts({ silences, words: [], segments: p.transcript || [] });
  if (MOCK_AI) p.cuts.fillers = mockCuts(p.video.duration).fillers;
  store.save(p);
  res.json(p.cuts);
}));

app.post('/api/projects/:id/apply-template', wrap(async (req, res) => {
  const p = getProject(req);
  const t = tpls.find(req.body?.templateId);
  if (!t) throw httpError(400, '알 수 없는 템플릿입니다.');
  for (const c of p.clips) {
    if (['queued', 'rendering'].includes(c.render?.status)) continue;
    // 쇼츠별 영상 프레임 조정은 템플릿 기본 프레임 기준이라, 기본 프레임이 다른 템플릿으로 바꾸면 초기화
    const k = (tp) => { const f = defaultFrame(tp); return `${f.w}|${f.h}|${f.cy}`; };
    if (k(tpls.resolve(c.templateId)) !== k(t)) c.frame = null;
    c.templateId = t.id;
    if (c.render?.status === 'done') c.render.stale = true;
  }
  store.save(p);
  res.json(p.clips.map((c) => ({ id: c.id, templateId: c.templateId, frame: c.frame, render: c.render })));
}));

app.post('/api/projects/:id/reset', wrap(async (req, res) => {
  const p = getProject(req);
  if (p.status === 'analyzing' || p.clips.some((c) => ['queued', 'rendering'].includes(c.render?.status))) throw httpError(409, '작업이 진행 중입니다.');
  fs.rmSync(path.join(store.projectDir(p.id), 'out'), { recursive: true, force: true });
  Object.assign(p, { status: 'uploaded', clips: [], topics: [], subtitles: [], transcript: [], error: null, progress: null });
  store.save(p);
  res.json({ ok: true });
}));

// ───────────────────────── 쇼츠 편집 ─────────────────────────

function validateSegments(input, duration) {
  if (!Array.isArray(input) || !input.length) throw httpError(400, '구간이 올바르지 않습니다.');
  if (input.length > 8) throw httpError(400, '구간은 쇼츠당 최대 8개까지 지원합니다.');
  const segs = input.map((x) => ({
    start: Math.round(Number(x.start) * 100) / 100,
    end: Math.min(duration, Math.round(Number(x.end) * 100) / 100),
    role: ['hook', 'body', 'ending'].includes(x.role) ? x.role : 'body',
    ...(x.note ? { note: String(x.note).slice(0, 80) } : {}),
  }));
  if (!segs.every((x) => x.start >= 0 && x.end - x.start >= 0.5)) throw httpError(400, '구간이 올바르지 않습니다. (구간당 최소 0.5초, 영상 길이 이내)');
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end - 1e-6) throw httpError(400, '구간끼리 겹칠 수 없습니다.');
  const total = totalDuration(segs);
  if (total < 1) throw httpError(400, '쇼츠 전체 길이는 최소 1초입니다.');
  if (total > 180) throw httpError(400, '쇼츠는 최대 3분까지 지원합니다.');
  return segs;
}

app.patch('/api/projects/:id/clips/:cid', wrap(async (req, res) => {
  const p = getProject(req);
  const c = getClip(p, req.params.cid);
  if (c.render?.status === 'rendering' || c.render?.status === 'queued') throw httpError(409, '렌더링 중에는 수정할 수 없습니다.');
  const b = req.body || {};
  const next = { ...c };
  if ('segments' in b) {
    next.segments = validateSegments(b.segments, p.video.duration);
  } else if ('start' in b || 'end' in b) {
    // 구버전 호환: 구간이 하나일 때만 start/end로 수정
    if (c.segments.length !== 1) throw httpError(400, '여러 구간으로 구성된 쇼츠는 segments로 수정하세요.');
    next.segments = validateSegments([{ ...c.segments[0], ...('start' in b ? { start: Number(b.start) } : {}), ...('end' in b ? { end: Number(b.end) } : {}) }], p.video.duration);
  }
  next.start = Math.min(...next.segments.map((x) => x.start));
  next.end = Math.max(...next.segments.map((x) => x.end));
  if ('title' in b) next.title = String(b.title).slice(0, 80);
  if ('description' in b) next.description = String(b.description).slice(0, 2000);
  if ('hashtags' in b && Array.isArray(b.hashtags)) next.hashtags = b.hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 15);
  if ('cropX' in b) next.cropX = Math.min(1, Math.max(0, Number(b.cropX) || 0));
  if ('cropY' in b) next.cropY = Number.isFinite(Number(b.cropY)) ? Math.min(1, Math.max(0, Number(b.cropY))) : 0.5;
  if ('zoom' in b) next.zoom = Math.min(FRAME_LIMITS.zoom[1], Math.max(FRAME_LIMITS.zoom[0], Number(b.zoom) || 1));
  if ('frame' in b) next.frame = sanitizeFrame(b.frame);
  if ('overrides' in b) next.overrides = tpls.sanitizeOverrides(b.overrides);
  if ('tighten' in b) next.tighten = sanitizeTighten(b.tighten);
  if ('templateId' in b) {
    if (!tpls.find(b.templateId)) throw httpError(400, '알 수 없는 템플릿입니다.');
    next.templateId = b.templateId;
  }
  for (const k of ['subtitleOn', 'titleOn']) if (k in b) next[k] = !!b[k];
  if ('topic' in b) next.topic = String(b.topic ?? '').slice(0, 100);
  if ('rationale' in b) next.rationale = String(b.rationale ?? '').slice(0, 600);
  Object.assign(c, next);
  // 주제·컷편집 요약·설명·해시태그처럼 영상에 영향이 없는 값만 바꾼 경우는 '수정됨'으로 보지 않는다
  const VIDEO_KEYS = ['start', 'end', 'segments', 'title', 'cropX', 'cropY', 'zoom', 'frame', 'overrides', 'tighten', 'templateId', 'titleOn', 'subtitleOn'];
  if (c.render?.status === 'done' && VIDEO_KEYS.some((k) => k in b)) c.render.stale = true;
  store.save(p);
  res.json(c);
}));

app.post('/api/projects/:id/clips', wrap(async (req, res) => {
  const p = getProject(req);
  if (p.status === 'analyzing') throw httpError(409, '분석 중입니다.');
  const start = Math.max(0, Number(req.body?.start) || 0);
  const end = Math.min(p.video.duration, Number(req.body?.end) || start + 30);
  if (end - start < 1) throw httpError(400, '구간이 올바르지 않습니다.');
  const c = { id: store.newId(4), start, end, segments: [{ start, end, role: 'body' }], summary: '', title: '새 쇼츠', score: 0, reason: '직접 추가한 구간', description: '', hashtags: [], cropX: 0.5, cropY: 0.5, zoom: 1, frame: null, overrides: {}, templateId: p.clips[0]?.templateId || tpls.all()[0].id, subtitleOn: true, titleOn: true, render: { status: 'idle' } };
  p.clips.push(c);
  if (p.status === 'uploaded') p.status = 'ready';
  store.save(p);
  res.status(201).json(c);
}));

app.delete('/api/projects/:id/clips/:cid', wrap(async (req, res) => {
  const p = getProject(req);
  const c = getClip(p, req.params.cid);
  if (c.render?.status === 'rendering' || c.render?.status === 'queued') throw httpError(409, '렌더링 중에는 삭제할 수 없습니다.');
  p.clips = p.clips.filter((x) => x !== c);
  fs.rmSync(path.join(store.projectDir(p.id), 'out', `${c.id}.mp4`), { force: true });
  store.save(p);
  res.json({ ok: true });
}));

app.patch('/api/projects/:id/subtitles', wrap(async (req, res) => {
  const p = getProject(req);
  const { updates = [], deletes = [], adds = [] } = req.body || {};
  const byId = new Map(p.subtitles.map((s) => [s.id, s]));
  for (const u of updates) {
    const s = byId.get(u.id);
    if (!s) continue;
    if (typeof u.text === 'string') s.text = u.text.slice(0, 200);
    if (Number.isFinite(u.start)) s.start = u.start;
    if (Number.isFinite(u.end)) s.end = u.end;
  }
  if (deletes.length) {
    const del = new Set(deletes);
    p.subtitles = p.subtitles.filter((s) => !del.has(s.id));
  }
  const created = [];
  for (const a of adds) {
    if (!(a.end > a.start)) continue;
    const s = { id: 'u' + store.newId(4), start: Number(a.start), end: Number(a.end), text: String(a.text || '').slice(0, 200) };
    p.subtitles.push(s);
    created.push(s);
  }
  p.subtitles.sort((a, b) => a.start - b.start);
  for (const c of p.clips) if (c.render?.status === 'done') c.render.stale = true;
  store.save(p);
  res.json({ ok: true, created });
}));

// ───────────────────────── 렌더링 ─────────────────────────

let queue = Promise.resolve();

app.post('/api/projects/:id/clips/:cid/render', wrap(async (req, res) => {
  const p = getProject(req);
  const c = getClip(p, req.params.cid);
  if (c.render?.status === 'rendering' || c.render?.status === 'queued') return res.json(c);
  c.render = { status: 'queued', pct: 0 };
  store.save(p);
  queue = queue.then(() => renderOne(p, c)).catch(() => {});
  res.status(202).json(c);
}));

async function renderOne(p, c) {
  const dir = store.projectDir(p.id);
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${c.id}.mp4`);
  const tmpFile = path.join(outDir, `${c.id}.tmp.mp4`);
  try {
    c.render = { status: 'rendering', pct: 0 };
    // 무음·군말 제거를 반영한 실제 이어 붙일 구간 (자막 시간도 이 기준으로 다시 계산)
    const eff = effectiveSegments(segmentsOf(c), p.cuts, c.tighten);
    const subs = p.subtitles.filter((s) => eff.some((g) => s.end > g.start && s.start < g.end));
    const assFile = path.join(outDir, `${c.id}.ass`);
    const tpl = tpls.applyOverrides(tpls.resolve(c.templateId), c.overrides);
    const fr = resolveFrame(tpl, c);
    fs.writeFileSync(assFile, buildAss({ clip: { ...c, segments: eff }, subs, tpl }));
    await ff.renderClip({
      src: path.join(dir, p.video.file), eff,
      srcW: p.video.width, srcH: p.video.height, cropX: c.cropX, cropY: c.cropY ?? 0.5, zoom: c.zoom ?? 1, frame: { ...framePixels(fr), bg: fr.bg }, assFile,
      hasAudio: p.video.hasAudio, out: tmpFile,
      onProgress: (f) => { c.render.pct = Math.round(f * 100); },
    });
    fs.renameSync(tmpFile, outFile);
    c.render = { status: 'done', pct: 100, size: fs.statSync(outFile).size, at: Date.now() };
  } catch (e) {
    console.error('렌더 실패:', e.message);
    fs.rmSync(tmpFile, { force: true });
    c.render = { status: 'error', error: e.message.split('\n').slice(-4).join(' ').slice(0, 300) };
  }
  store.save(p);
}

app.get('/api/projects/:id/clips/:cid/download', wrap(async (req, res) => {
  const p = getProject(req);
  const c = getClip(p, req.params.cid);
  const file = path.join(store.projectDir(p.id), 'out', `${c.id}.mp4`);
  if (c.render?.status !== 'done' || !fs.existsSync(file)) throw httpError(404, '아직 렌더링된 파일이 없습니다.');
  if (req.query.inline) return res.sendFile(file);
  const safe = (c.title || 'shorts').replace(/\s+/g, ' ').replace(/[\\/:*?"<>|\n\r]/g, '').trim().slice(0, 50) || 'shorts';
  res.download(file, `${safe}.mp4`);
}));

// ───────────────────────── 에러 처리 ─────────────────────────

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `파일이 너무 큽니다. 최대 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB까지 지원합니다.` : err.message;
    return res.status(400).json({ error: msg });
  }
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : `서버 오류: ${err.message}` });
});

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  app.listen(PORT, () => {
    const cap = ai.capabilities();
    console.log(`jiyoungcut → http://localhost:${PORT}`);
    if (cap.mock) console.log('⚠ MOCK_AI=1: 데모 모드 (실제 음성 인식/AI 분석 없음)');
    else {
      if (!cap.transcription) console.log('⚠ 음성 인식 없음: `npm run setup:stt`(로컬, 무료) 또는 OPENAI_API_KEY 필요');
      else console.log(`음성 인식: ${cap.sttProvider === 'local' ? '로컬 whisper.cpp' : 'OpenAI'}`);
      if (cap.highlightsFallback) console.log('⚠ ANTHROPIC_API_KEY 없음: 하이라이트를 단순 규칙으로 선정');
    }
  });
}

export default app;
