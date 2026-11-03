// jiyoungcut 프론트엔드 (빌드 없이 동작하는 단일 ES 모듈)
import { effectiveSegments, tightenSummary, TIGHTEN_DEFAULTS } from './cuts.js';
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
let config = { templates: {} };
let pollTimer = null;
let cleanup = null; // 현재 화면 정리 함수

const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const fmtP = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const parseT = (v) => { const m = String(v).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN; };
const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = () => { clearTimeout(t); }; return d; };

function toast(msg, isErr) {
  $toast.textContent = msg;
  $toast.className = 'toast' + (isErr ? ' err' : '');
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.hidden = true), isErr ? 6000 : 2500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function titleLines(t) {
  t = String(t || '').trim();
  if (!t) return [];
  if (t.includes('\n')) return t.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 2);
  if (t.length <= 14 || !t.includes(' ')) return [t];
  let best = -1;
  for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - t.length / 2) < Math.abs(best - t.length / 2))) best = i;
  return [t.slice(0, best).trim(), t.slice(best + 1).trim()];
}

/** CSS font-family 스택: 한글 글리프가 없는 폰트는 폴백 폰트를 뒤에 붙인다 */
const fontStack = (id) => {
  const f = (config.fonts || []).find((x) => x.id === id);
  return `'jy-${id}'${f?.fallback ? `, 'jy-${f.fallback}'` : ''}, sans-serif`;
};

// 영상 프레임(서버 server/layout.js 와 같은 규칙): 템플릿 레이아웃의 기본값 위에 쇼츠별 조정(clip.frame)을 덮는다
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const defaultFrame = (tpl) => {
  const d = config.frameDefaults?.[tpl.layout === 'framed' ? 'framed' : 'full'] || { w: 1, h: 1, cy: 0.5 };
  return { w: tpl.frameW ?? d.w, h: tpl.frameH ?? d.h, cy: tpl.frameCy ?? d.cy, bg: tpl.bgColor ?? '#000000' };
};
const frameKey = (tpl) => { const f = defaultFrame(tpl); return `${f.w}|${f.h}|${f.cy}`; };
function resolveFrame(tpl, clip = {}) {
  const d = defaultFrame(tpl); const f = clip.frame || {};
  const w = clampN(f.w ?? d.w, 0.3, 1, d.w);
  const h = clampN(f.h ?? d.h, 0.2, 1, d.h);
  return { w, h, cy: clampN(f.cy ?? d.cy, h / 2, 1 - h / 2, d.cy), bg: d.bg };
}

const sliderHTML = (id, label, min, max, step, val, unit = '') => `<div class="slider"><label>${label}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output id="${id}o">${val}${unit}</output></div>`;

/** 템플릿에 쓰인 폰트를 미리 내려받아, 템플릿을 바꿀 때 글꼴이 늦게 바뀌지 않게 한다 */
function preloadFonts(list) {
  const ids = new Set();
  for (const t of list) for (const k of ['titleFont', 'subFont', 'accountFont']) {
    ids.add(t[k]);
    const f = (config.fonts || []).find((x) => x.id === t[k]);
    if (f?.fallback) ids.add(f.fallback);
  }
  for (const id of ids) document.fonts?.load(`40px 'jy-${id}'`, '가나다ABC').catch(() => {});
}

const PHONE_HTML = '<div class="vwrap"></div><div class="ov ov-title"></div><div class="ov ov-sub"></div><div class="ov ov-acc"></div><div class="gv"></div><div class="gh"></div>';

/**
 * 템플릿(레이아웃·폰트·색·위치·계정명)을 9:16 미리보기 박스에 반영 — 편집기와 템플릿 설정 화면이 공용.
 * 좌표는 캔버스 비율(요소 중심), 크기는 1080x1920 기준 px를 cqw로 환산해 실제 렌더링과 같은 비율을 유지한다.
 */
function paintPhone(phone, tpl, { title = [], sub = '', accountPlaceholder = '', frame = null } = {}) {
  const fr = frame || defaultFrame(tpl);
  phone.style.background = fr.bg;
  const vw = phone.querySelector('.vwrap');
  vw.style.left = `${((1 - fr.w) / 2) * 100}%`; vw.style.width = `${fr.w * 100}%`;
  vw.style.top = `${(fr.cy - fr.h / 2) * 100}%`; vw.style.height = `${fr.h * 100}%`;
  const rgba = (hex, op) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${op / 100})`; };
  // 위치·폰트·크기·테두리를 요소에 반영하고, 배경이 켜져 있으면 글자를 박스 span으로 감싼다
  const put = (el, pre, x, y, font, size, color, html) => {
    el.style.left = `${x * 100}%`; el.style.top = `${y * 100}%`;
    el.style.fontFamily = fontStack(font); el.style.fontSize = `${size / 10.8}cqw`;
    el.style.color = color;
    // ASS 테두리는 글자 바깥으로 두께만큼 퍼지므로, 가운데 기준 CSS 선은 두 배로 그린다
    const w = tpl[`${pre}OutlineOn`] ? tpl[`${pre}OutlineWidth`] : 0;
    el.style.setProperty('-webkit-text-stroke', w > 0 ? `${(2 * w) / 10.8}cqw ${tpl[`${pre}OutlineColor`]}` : '0');
    el.innerHTML = tpl[`${pre}BgOn`]
      ? `<span class="tx" style="background:${rgba(tpl[`${pre}BgColor`], tpl[`${pre}BgOpacity`])};padding:${tpl[`${pre}BgPad`] / 10.8}cqw">${html}</span>`
      : html;
  };
  const t = phone.querySelector('.ov-title');
  t.hidden = !title.length;
  put(t, 'title', tpl.titleX, tpl.titleY, tpl.titleFont, tpl.titleSize, tpl.titleColor1,
    !title.length ? '' : title.length === 1 ? esc(title[0]) : `${esc(title[0])}\n<b style="color:${esc(tpl.titleColor2)}">${esc(title[1])}</b>`);
  const s = phone.querySelector('.ov-sub');
  s.hidden = !sub;
  put(s, 'sub', tpl.subX, tpl.subY, tpl.subFont, tpl.subSize, tpl.subColor, sub ? esc(sub) : '');
  const a = phone.querySelector('.ov-acc');
  const accText = tpl.account || accountPlaceholder;
  a.hidden = !accText;
  put(a, 'account', tpl.accountX, tpl.accountY, tpl.accountFont, tpl.accountSize, tpl.accountColor, esc(accText));
  a.classList.toggle('ph', !tpl.account && !!accountPlaceholder);
}

// ───────────────────────── 라우터 ─────────────────────────

async function route() {
  clearTimeout(pollTimer);
  cleanup?.(); cleanup = null;
  const h = location.hash.replace(/^#/, '') || '/';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', (a.dataset.nav === 'new' && h === '/') || (a.dataset.nav === 'list' && h === '/projects') || (a.dataset.nav === 'tpl' && h === '/templates')));
  const m = h.match(/^\/p\/([a-f0-9]+)/);
  try {
    if (m) await projectPage(m[1]);
    else if (h === '/projects') await listPage();
    else if (h === '/templates') await templatesPage();
    else homePage();
  } catch (e) {
    $app.innerHTML = `<div class="page"><div class="err-box">${esc(e.message)}</div><a class="btn" href="#/">홈으로</a></div>`;
  }
}
window.addEventListener('hashchange', route);

async function init() {
  config = await api('/api/config').catch(() => config);
  const dot = (cls) => `<span class="dot ${cls}"></span>`;
  document.getElementById('ai-status').innerHTML = config.mock
    ? `<span class="chip">${dot('mid')}데모 모드 (MOCK_AI)</span>`
    : `<span class="chip">${dot(config.transcription ? 'on' : '')}음성 인식 (${config.sttProvider === 'local' ? '내 맥 Whisper' : config.sttProvider === 'openai' ? 'OpenAI' : '미설정'})</span>
       <span class="chip">${dot(config.highlights ? 'on' : 'mid')}하이라이트 (Claude)</span>`;
  route();
}

// ───────────────────────── 홈 / 업로드 ─────────────────────────

function homePage() {
  $app.innerHTML = '';
  const page = el(`<div class="page">
    <h1>하이라이트 쇼츠 편집 프로젝트</h1>
    <p class="sub">롱폼을 올리면 AI가 바이럴 구간을 잡아 9:16 쇼츠로 만듭니다.</p>
    <div class="drop" id="drop"><div class="big">⬆</div><p><b>영상 파일을 끌어다 놓거나 클릭해서 선택</b></p><p>MP4 · MOV · MKV · WEBM · 최대 ${config.maxDurationMin || 180}분</p>
      <input type="file" id="file" accept="video/*,.mkv" hidden></div>
    <div id="up" hidden class="box" style="margin-top:16px"><div id="upname" style="margin-bottom:8px"></div><div class="progress"><i id="upbar"></i></div><div class="meta" style="margin-top:6px"><span id="uppct"></span></div></div>
    ${!config.transcription ? `<div class="err-box">음성 인식이 설정되지 않았습니다. 터미널에서 <code>npm run setup:stt</code>로 무료 로컬 음성 인식을 설치하거나, <code>.env</code>에 <code>OPENAI_API_KEY</code>를 넣으세요. (README 참고)</div>` : ''}
    <h2>최근 프로젝트</h2><div id="recent" class="grid"></div></div>`);
  $app.append(page);
  const drop = page.querySelector('#drop');
  const input = page.querySelector('#file');
  drop.onclick = () => input.click();
  input.onchange = () => input.files[0] && upload(input.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]); };
  loadCards(page.querySelector('#recent'), 6);

  function upload(file) {
    const up = page.querySelector('#up');
    up.hidden = false; drop.hidden = true;
    page.querySelector('#upname').textContent = file.name;
    const fd = new FormData();
    fd.append('video', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/projects');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      page.querySelector('#upbar').style.width = pct + '%';
      page.querySelector('#uppct').textContent = pct < 100 ? `업로드 중 ${pct}%` : '영상 확인 중…';
    };
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}');
      if (xhr.status === 201) location.hash = `#/p/${data.id}`;
      else { toast(data.error || '업로드 실패', true); up.hidden = true; drop.hidden = false; input.value = ''; }
    };
    xhr.onerror = () => { toast('업로드 중 네트워크 오류가 발생했습니다.', true); up.hidden = true; drop.hidden = false; };
    xhr.send(fd);
  }
}

async function listPage() {
  $app.innerHTML = `<div class="page"><h1>내 프로젝트</h1><p class="sub">&nbsp;</p><div id="all" class="grid"></div></div>`;
  await loadCards($app.querySelector('#all'));
}

const STATUS = { uploaded: ['분석 대기', ''], analyzing: ['분석 중', 'warn'], ready: ['완료', 'ok'], error: ['오류', 'err'] };

async function loadCards(box, limit) {
  let list = await api('/api/projects');
  if (limit) list = list.slice(0, limit);
  if (!list.length) { box.outerHTML = '<p class="sub" style="text-align:left">아직 프로젝트가 없습니다.</p>'; return; }
  box.innerHTML = '';
  for (const p of list) {
    const [label, cls] = STATUS[p.status] || ['', ''];
    const c = el(`<a class="card" href="#/p/${p.id}">
      <div class="thumb" style="background-image:url(/media/${p.id}/thumb)"><span class="dur">${fmt(p.video.duration)}</span></div>
      <div class="body"><div class="name">${esc(p.name)}</div>
        <div class="meta"><span class="badge ${cls}">${label}</span><span>${p.clips.length ? `쇼츠 ${p.clips.length}개` : ''}</span></div>
        <div class="meta"><span>${new Date(p.createdAt).toLocaleDateString('ko-KR')}</span><button class="btn sm danger">삭제</button></div></div></a>`);
    c.querySelector('button').onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm(`"${p.name}" 프로젝트를 삭제할까요? 원본과 결과 영상이 모두 삭제됩니다.`)) return;
      try { await api(`/api/projects/${p.id}`, { method: 'DELETE' }); c.remove(); } catch (err) { toast(err.message, true); }
    };
    box.append(c);
  }
}

// ───────────────────────── 프로젝트 ─────────────────────────

async function projectPage(id) {
  const p = await api(`/api/projects/${id}`);
  if (p.status === 'analyzing') return analyzingPage(p);
  const templates = await api('/api/templates');
  if (p.status === 'ready' && p.clips.length) return editorPage(p, templates);
  return setupPage(p, templates);
}

function setupPage(p, templates) {
  const hasErr = p.status === 'error' && p.error;
  $app.innerHTML = '';
  const page = el(`<div class="page"><a class="back" href="#/">← 프로젝트</a>
    <h1>${esc(p.name)}</h1><p class="sub">${fmt(p.video.duration)} · ${p.video.width}×${p.video.height}</p>
    ${hasErr ? `<div class="err-box">${esc(p.error)}</div>` : ''}
    <div class="box"><div class="row">
      <div class="field"><label>쇼츠 길이</label><select id="len">
        <option value="15-30">15~30초</option><option value="30-60" selected>30~60초</option><option value="60-90">60~90초</option><option value="45-120">45~120초</option></select></div>
      <div class="field"><label>후보 개수</label><select id="count"><option>3</option><option selected>5</option><option>8</option><option>10</option></select></div>
      <div class="field"><label>편집 방식</label><select id="mode"><option value="context" selected>맥락 편집 (후킹·군더더기 제거)</option><option value="single">단순 구간 (연속 한 구간)</option></select></div>
      <div class="field"><label>템플릿</label><select id="tplsel">${templates.map((t) => `<option value="${t.id}">${esc(t.name)}${t.account ? ' · ' + esc(t.account) : ''}</option>`).join('')}</select></div>
      <div class="field"><label>영상 언어</label><select id="lang"><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="auto">자동 감지</option></select></div>
      <button class="btn primary big" id="go" style="margin-left:auto">AI로 쇼츠 찾기 →</button></div></div></div>`);
  $app.append(page);
  page.querySelector('#go').onclick = async (e) => {
    e.target.disabled = true;
    const [minLen, maxLen] = page.querySelector('#len').value.split('-').map(Number);
    try {
      await api(`/api/projects/${p.id}/analyze`, { method: 'POST', body: { minLen, maxLen, count: +page.querySelector('#count').value, language: page.querySelector('#lang').value, templateId: page.querySelector('#tplsel').value, mode: page.querySelector('#mode').value } });
      route();
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
}

function analyzingPage(p) {
  $app.innerHTML = `<div class="page"><div class="box analyzing"><div class="spin"></div><h2 style="margin:0" id="msg"></h2>
    <div class="progress"><i id="bar"></i></div><div class="meta" style="justify-content:center">영상 길이에 따라 몇 분 걸릴 수 있습니다. 이 창을 닫아도 분석은 계속됩니다.</div></div></div>`;
  const tick = async () => {
    const q = await api(`/api/projects/${p.id}?subs=0`);
    if (q.status !== 'analyzing') return route();
    $app.querySelector('#msg').textContent = q.progress?.message || '분석 중';
    $app.querySelector('#bar').style.width = (q.progress?.pct || 0) + '%';
    pollTimer = setTimeout(tick, 1000);
  };
  tick();
}

// ───────────────────────── 에디터 ─────────────────────────

function editorPage(p, templates) {
  const S = { p, sel: p.clips[0].id, seg: 0, cur: 0, t: 0, playing: false, styEl: 'title' };
  preloadFonts(templates);
  const clip = () => S.p.clips.find((c) => c.id === S.sel);
  const src = p.video.proxy ? `/media/${p.id}/proxy` : `/media/${p.id}/source`;
  // 재생/렌더 기준 구간 = 원본 구간에서 무음·군말을 걷어낸 결과 (서버 렌더링과 같은 계산: cuts.js)
  let effCache = { key: '', val: [] };
  const eff = (c) => {
    const key = c.id + JSON.stringify(c.segments) + JSON.stringify(c.tighten) + (S.p.cuts ? `${S.p.cuts.silences.length}:${S.p.cuts.fillers.length}` : '0');
    if (effCache.key !== key) effCache = { key, val: effectiveSegments(c.segments, S.p.cuts, c.tighten) };
    return effCache.val;
  };
  const curOf = (c, srcIdx) => Math.max(0, eff(c).findIndex((e) => e.src === srcIdx)); // 원본 구간 번호 → 재생 구간 번호
  const subsIn = (c) => S.p.subtitles.filter((s) => eff(c).some((g) => s.end > g.start && s.start < g.end));
  const segTotal = (c) => eff(c).reduce((n, g) => n + g.end - g.start, 0);
  const segOffset = (c, i) => eff(c).slice(0, i).reduce((n, g) => n + g.end - g.start, 0);
  const segIdxOf = (c, t) => eff(c).findIndex((g) => t >= g.start - 0.001 && t < g.end);
  const syncBounds = (c) => { c.start = Math.min(...c.segments.map((g) => g.start)); c.end = Math.max(...c.segments.map((g) => g.end)); };
  const outStart = (c, s) => { const E = eff(c); const i = E.findIndex((g) => s.end > g.start && s.start < g.end); return i < 0 ? Infinity : segOffset(c, i) + Math.max(0, s.start - E[i].start); };
  const ROLE = { hook: '후킹', body: '본론', ending: '마무리' };
  const tplOf = (c) => templates.find((t) => t.id === c.templateId) || templates[0];
  // 쇼츠별 덮어쓰기(크기/테두리)를 반영한 실제 적용 템플릿
  const effTpl = (c) => ({ ...tplOf(c), ...(c.overrides || {}) });
  const EL_STY = { title: { label: '제목', min: 40, max: 130 }, sub: { label: '자막', min: 36, max: 110 }, account: { label: '계정명', min: 24, max: 110 } };

  $app.innerHTML = '';
  const root = el(`<div class="editor">
    <div class="col left"><a class="back" href="#/">← 프로젝트</a><h3>AI 추천 쇼츠 <span class="meta" style="display:inline">(${p.clips.length})</span></h3>
      <div class="cliplist" id="list"></div>
      <div style="display:grid;gap:8px;margin-top:14px"><button class="btn" id="addclip">＋ 현재 위치에서 새 쇼츠 추가</button><button class="btn" id="reanalyze">다시 분석</button></div></div>
    <div class="col center">
      <div class="topbar"><span class="name">${esc(p.name)}</span></div>
      <div class="phone" id="phone"><video id="vid" src="${src}" preload="auto" playsinline></video></div>
      <div class="hint">미리보기를 좌우로 드래그해 크롭 위치를 조정하세요</div>
      <div class="transport"><button class="btn" id="play">▶ 재생</button><span id="time" class="meta"></span></div>
      <div class="timeline"><div class="tl" id="tl"></div><div class="tl-labels"><span id="tl0"></span><span id="tl1"></span></div>
        <div class="times"><div class="field"><label>선택 구간 시작</label><input type="text" id="tin"></div><div class="field"><label>선택 구간 종료</label><input type="text" id="tout"></div><div class="field"><label>선택 구간 길이</label><input type="text" id="tlen" disabled></div></div></div>
      <div class="segs" id="segs"></div>
      <div class="segs tighten" id="tighten"></div>
    </div>
    <div class="col right" id="right"></div></div>`);
  $app.append(root);
  const $ = (s) => root.querySelector(s);
  const phone = $('#phone');
  const vidEl = $('#vid');
  phone.innerHTML = PHONE_HTML;
  phone.querySelector('.vwrap').append(vidEl);
  const vid = vidEl;
  const aspect = p.video.width / p.video.height;
  let win = [0, p.video.duration]; // 타임라인 표시 구간

  // ── 저장 (디바운스) ──
  const pending = new Map();
  async function reloadClips() {
    try {
      const q = await api(`/api/projects/${p.id}?subs=0`);
      for (const qc of q.clips) { const c = S.p.clips.find((x) => x.id === qc.id); if (c) Object.assign(c, qc); }
      S.seg = Math.min(S.seg, clip().segments.length - 1); S.cur = Math.min(S.cur, eff(clip()).length - 1);
      computeWin(); renderAllCenter(); renderRight();
    } catch {}
  }
  const flushClip = debounce(async () => {
    for (const [id, patch] of [...pending]) {
      pending.delete(id);
      try {
        const resp = await api(`/api/projects/${p.id}/clips/${id}`, { method: 'PATCH', body: patch });
        // 편집 중인 값은 화면(로컬)이 기준이라 덮어쓰지 않고, 서버가 계산한 값(구간 범위, 렌더 상태 등)만 반영
        const target = S.p.clips.find((x) => x.id === id);
        for (const [k, v] of Object.entries(resp)) if (!(k in patch) || k === 'start' || k === 'end') target[k] = v;
      }
      catch (e) { toast(e.message, true); await reloadClips(); }
    }
    renderList(); renderRender(); renderSegs();
  }, 500);
  function patchClip(patch) {
    const c = clip();
    Object.assign(c, patch);
    if (patch.segments) { syncBounds(c); patch = { segments: c.segments }; }
    if (c.render?.status === 'done') c.render.stale = true;
    pending.set(c.id, { ...(pending.get(c.id) || {}), ...patch });
    renderList(); // '수정됨' 표시는 저장을 기다리지 않고 바로
    flushClip();
  }

  // ── 목록 ──
  function renderList() {
    const box = $('#list'); box.innerHTML = '';
    S.p.clips.forEach((c, i) => {
      const n = c.segments.length;
      const it = el(`<div class="clipitem ${c.id === S.sel ? 'sel' : ''}"><div class="meta"><span class="score">${c.score ? `★ ${c.score}` : '직접 추가'}</span><span>${Math.round(segTotal(c))}초${n > 1 ? ` · ${n}개 구간 편집` : ''}</span></div>
        <div class="t">${esc(c.title || `쇼츠 ${i + 1}`)}</div>${c.summary ? `<div class="meta flow">${esc(c.summary)}</div>` : c.reason ? `<div class="meta">${esc(c.reason)}</div>` : ''}
        ${c.render?.status === 'done' ? `<span class="badge ${c.render.stale ? 'warn' : 'ok'}">${c.render.stale ? '수정됨' : '렌더 완료'}</span>` : ''}</div>`);
      it.onclick = () => select(c.id);
      box.append(it);
    });
  }
  function select(id) { S.sel = id; S.seg = 0; S.cur = 0; renderList(); renderRight(); computeWin(); renderAllCenter(); seek(eff(clip())[0].start); updatePreview(); }
  function renderAllCenter() { renderTimeline(); renderSegs(); renderTighten(); }

  // ── 미리보기 ──
  function seek(t) { vid.currentTime = t; S.t = t; }
  // 영상(video)을 프레임 안에 cover로 채우고 확대/이동을 적용. 서버 cropBox()와 같은 기하
  function placeVideo(c, fr) {
    const a = (fr.w * 9) / (fr.h * 16); // 프레임 가로세로비 (캔버스가 9:16이라 환산)
    const r = aspect / a; const z = c.zoom || 1;
    const wPct = (r >= 1 ? r : 1) * 100 * z; const hPct = (r >= 1 ? 1 : 1 / r) * 100 * z;
    vid.style.width = `${wPct}%`; vid.style.height = `${hPct}%`;
    vid.style.left = `${-(wPct - 100) * c.cropX}%`; vid.style.top = `${-(hPct - 100) * (c.cropY ?? 0.5)}%`;
    return { wPct, hPct };
  }
  function updatePreview() {
    const c = clip(); const tpl = effTpl(c); const fr = resolveFrame(tpl, c);
    placeVideo(c, fr);
    const s = c.subtitleOn ? subsIn(c).find((x) => S.t >= x.start && S.t < x.end) : null;
    paintPhone(phone, tpl, { title: c.titleOn ? titleLines(c.title) : [], sub: s?.text || '', frame: fr });
    const E = eff(c);
    const idx = Math.min(E.length - 1, S.playing ? S.cur : Math.max(0, segIdxOf(c, S.t)));
    const g = E[idx];
    const out = segOffset(c, idx) + Math.min(Math.max(0, S.t - g.start), g.end - g.start);
    $('#time').textContent = `${fmtP(out)} / ${fmtP(segTotal(c))}`;
    root.querySelectorAll('.subrow').forEach((r) => r.classList.toggle('active', r.dataset.id === s?.id));
    root.querySelectorAll('.segrow').forEach((r) => r.classList.toggle('playing', S.playing && +r.dataset.i === E[S.cur]?.src));
    renderHead();
  }
  // 재생 중에는 구간 경계를 프레임 단위로 감시해 다음 구간으로 건너뛴다 (실제 렌더 결과와 같은 흐름)
  function loop() {
    if (!S.playing) return;
    const c = clip();
    S.t = vid.currentTime;
    const E = eff(c);
    if (S.cur >= E.length) S.cur = 0;
    const g = E[S.cur];
    if (S.t >= g.end - 0.03 || S.t < g.start - 0.5) {
      S.cur = (S.cur + 1) % E.length;
      seek(E[S.cur].start);
    }
    updatePreview();
    requestAnimationFrame(loop);
  }
  vid.addEventListener('timeupdate', () => { if (!S.playing) { S.t = vid.currentTime; updatePreview(); } });
  vid.addEventListener('error', () => toast('브라우저에서 이 영상을 재생할 수 없습니다. 잠시 후 다시 시도하세요(미리보기 변환 중일 수 있음).', true));
  function stop() { vid.pause(); S.playing = false; $('#play').textContent = '▶ 재생'; }
  $('#play').onclick = () => {
    const c = clip();
    if (S.playing) { stop(); return; }
    const i = segIdxOf(c, S.t);
    if (i < 0) { S.cur = 0; seek(eff(c)[0].start); } else S.cur = i;
    S.playing = true; vid.play(); $('#play').textContent = '⏸ 일시정지';
    requestAnimationFrame(loop);
  };

  // 영상 이동(드래그): 확대했거나 프레임보다 영상이 클 때 가로/세로로 움직인다
  let drag = null;
  phone.addEventListener('pointerdown', (e) => { const c = clip(); drag = { x: e.clientX, y: e.clientY, cx: c.cropX, cy: c.cropY ?? 0.5 }; phone.setPointerCapture(e.pointerId); });
  phone.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = clip(); const fr = resolveFrame(effTpl(c), c);
    const { wPct, hPct } = placeVideo(c, fr);
    const slackX = ((wPct - 100) / 100) * fr.w * phone.clientWidth; // 움직일 수 있는 여유(px)
    const slackY = ((hPct - 100) / 100) * fr.h * phone.clientHeight;
    if (slackX > 1) c.cropX = clampN(drag.cx - (e.clientX - drag.x) / slackX, 0, 1, 0.5);
    if (slackY > 1) c.cropY = clampN(drag.cy - (e.clientY - drag.y) / slackY, 0, 1, 0.5);
    updatePreview(); syncFrameInputs();
  });
  const endDrag = () => { if (drag) { drag = null; patchClip({ cropX: clip().cropX, cropY: clip().cropY ?? 0.5 }); } };
  phone.addEventListener('pointerup', endDrag); phone.addEventListener('pointercancel', endDrag);

  // ── 타임라인 (선택한 구간 중심) ──
  const selSeg = () => clip().segments[S.seg];
  function computeWin() {
    const g = selSeg(); const len = g.end - g.start; const pad = Math.max(20, len * 0.8);
    win = [Math.max(0, g.start - pad), Math.min(p.video.duration, g.end + pad)];
  }
  const pos = (t) => ((t - win[0]) / (win[1] - win[0])) * 100;
  const block = (cls, a, b, extra = '') => { const l = pos(Math.max(a, win[0])); return `<div class="${cls}" style="left:${l}%;width:${pos(Math.min(b, win[1])) - l}%">${extra}</div>`; };
  // 무음·군말 제거로 걷어내는 범위 (타임라인에 빗금으로 표시)
  function removedRanges(c) {
    const E = eff(c); const out = [];
    c.segments.forEach((g, i) => {
      let cur = g.start;
      for (const k of E.filter((e) => e.src === i)) { if (k.start > cur + 0.01) out.push([cur, k.start]); cur = k.end; }
      if (g.end > cur + 0.01) out.push([cur, g.end]);
    });
    return out.filter(([a, b]) => b - a > 0.01);
  }
  function renderTimeline() {
    const c = clip(); const g = selSeg(); const tl = $('#tl');
    tl.innerHTML = '';
    for (const o of S.p.clips) if (o !== c) for (const og of o.segments) if (og.end > win[0] && og.start < win[1]) tl.insertAdjacentHTML('beforeend', block('other', og.start, og.end));
    for (const [a, b] of removedRanges(c)) if (b > win[0] && a < win[1]) tl.insertAdjacentHTML('beforeend', block('cut', a, b));
    c.segments.forEach((sg, i) => { if (i !== S.seg && sg.end > win[0] && sg.start < win[1]) tl.insertAdjacentHTML('beforeend', block('sib', sg.start, sg.end, `<i>${i + 1}</i>`)); });
    tl.insertAdjacentHTML('beforeend', block('sel', g.start, g.end, `<i>${S.seg + 1}</i>`));
    tl.insertAdjacentHTML('beforeend', `<div class="handle" data-h="start" style="left:${pos(g.start)}%"></div><div class="handle" data-h="end" style="left:${pos(g.end)}%"></div><div class="head" id="head"></div>`);
    $('#tl0').textContent = fmt(win[0]); $('#tl1').textContent = fmt(win[1]);
    $('#tin').value = fmtP(g.start); $('#tout').value = fmtP(g.end); $('#tlen').value = `${(g.end - g.start).toFixed(1)}초`;
    renderHead();
  }
  function renderHead() { const h = root.querySelector('#head'); if (h) h.style.left = `${Math.min(100, Math.max(0, pos(S.t)))}%`; }
  // 다른 구간과 겹치지 않는 범위
  function bounds(c, i) {
    const g = c.segments[i]; let lo = 0, hi = p.video.duration;
    c.segments.forEach((o, j) => { if (j === i) return; if (o.end <= g.start + 1e-6) lo = Math.max(lo, o.end); if (o.start >= g.end - 1e-6) hi = Math.min(hi, o.start); });
    return [lo, hi];
  }
  const tlEl = $('#tl');
  let th = null;
  tlEl.addEventListener('pointerdown', (e) => {
    const h = e.target.dataset?.h;
    if (!h) { const r = tlEl.getBoundingClientRect(); stop(); seek(win[0] + ((e.clientX - r.left) / r.width) * (win[1] - win[0])); return; }
    th = { h, lim: bounds(clip(), S.seg) }; tlEl.setPointerCapture(e.pointerId);
  });
  tlEl.addEventListener('pointermove', (e) => {
    if (!th) return;
    const r = tlEl.getBoundingClientRect(); const g = selSeg();
    let t = win[0] + (Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))) * (win[1] - win[0]);
    t = Math.round(t * 10) / 10;
    if (th.h === 'start') g.start = Math.max(th.lim[0], Math.min(t, g.end - 1)); else g.end = Math.min(th.lim[1], Math.max(t, g.start + 1));
    syncBounds(clip()); renderTimeline(); updatePreview();
  });
  const endTl = () => {
    if (!th) return; const h = th.h; th = null; const c = clip(); const g = selSeg();
    stop(); patchClip({ segments: c.segments }); seek(h === 'start' ? g.start : Math.max(g.start, g.end - 2)); S.cur = curOf(clip(), S.seg); computeWin(); renderAllCenter(); renderRight();
  };
  tlEl.addEventListener('pointerup', endTl); tlEl.addEventListener('pointercancel', endTl);
  const timeInput = (id, key) => $(id).addEventListener('change', (e) => {
    const v = parseT(e.target.value); const c = clip(); const g = selSeg(); const [lo, hi] = bounds(c, S.seg);
    const ns = key === 'start' ? v : g.start, ne = key === 'end' ? v : g.end;
    if (!(ns >= lo && ne <= hi && ne - ns >= 1)) { toast(`올바른 시간을 입력하세요 (이 구간은 ${fmtP(lo)} ~ ${fmtP(hi)} 사이, 최소 1초). 예) 1:23.5`, true); renderTimeline(); return; }
    stop(); g.start = ns; g.end = ne; patchClip({ segments: c.segments }); computeWin(); renderAllCenter(); renderRight(); seek(ns); S.cur = curOf(clip(), S.seg);
  });
  timeInput('#tin', 'start'); timeInput('#tout', 'end');

  // ── 무음·군말 제거 ──
  function renderTighten() {
    const c = clip(); const box = $('#tighten'); if (!box) return;
    const cuts = S.p.cuts;
    if (!cuts) {
      box.innerHTML = `<div class="segs-head"><b>무음·군말 제거</b><span class="meta">이 프로젝트는 무음 정보가 없어요. 소리만 분석하므로 금방 끝납니다.</span><button class="btn sm" id="detect">무음 분석하기</button></div>`;
      box.querySelector('#detect').onclick = async (e) => {
        e.target.disabled = true; e.target.textContent = '분석 중…';
        try { S.p.cuts = await api(`/api/projects/${p.id}/detect-cuts`, { method: 'POST' }); renderTighten(); toast('무음 구간을 분석했습니다'); } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = '무음 분석하기'; }
      };
      return;
    }
    const t = c.tighten || { silence: false, minSilence: TIGHTEN_DEFAULTS.minSilence, pad: TIGHTEN_DEFAULTS.pad, filler: false };
    const sm = tightenSummary(c.segments, cuts, t);
    box.innerHTML = `<div class="segs-head"><b>무음·군말 제거</b><span class="meta" id="tsum"></span></div>
      <div class="tgrid">
        <label class="toggle"><span>무음 제거</span><input type="checkbox" id="tSil" ${t.silence ? 'checked' : ''}></label>
        <label class="toggle"><span>군말 제거 <small class="meta">(음·어 등)</small></span><input type="checkbox" id="tFil" ${t.filler ? 'checked' : ''}></label>
        ${sliderHTML('tMin', '무음 기준', 0.3, 2, 0.1, t.minSilence, '초')}
        ${sliderHTML('tPad', '남길 여백', 0, 0.5, 0.05, t.pad, '초')}
      </div>
      <div class="meta">켜면 말 사이의 긴 침묵과 군말을 잘라 템포를 빠르게 만들어요. 타임라인의 빗금 영역이 제거되고, 렌더링과 미리보기에 같은 규칙이 적용됩니다.</div>`;
    const summary = () => {
      const s2 = tightenSummary(c.segments, cuts, c.tighten || t);
      box.querySelector('#tsum').textContent = (c.tighten?.silence || c.tighten?.filler)
        ? `무음 ${s2.silences}곳 · 군말 ${s2.fillers}곳 제거 · ${s2.saved.toFixed(1)}초 줄어듦 (총 ${s2.after.toFixed(1)}초)`
        : `감지된 무음 ${cuts.silences.length}곳 · 군말 ${cuts.fillers.length}곳`;
    };
    summary();
    const set = (patch) => {
      stop();
      c.tighten = { silence: false, minSilence: TIGHTEN_DEFAULTS.minSilence, pad: TIGHTEN_DEFAULTS.pad, filler: false, ...(c.tighten || {}), ...patch };
      patchClip({ tighten: c.tighten });
      S.cur = Math.min(S.cur, eff(c).length - 1);
      summary(); renderTimeline(); renderSegs(); renderSubRows(); renderList(); updatePreview();
    };
    box.querySelector('#tSil').onchange = (e) => set({ silence: e.target.checked });
    box.querySelector('#tFil').onchange = (e) => set({ filler: e.target.checked });
    box.querySelector('#tMin').addEventListener('input', (e) => { box.querySelector('#tMino').textContent = e.target.value + '초'; set({ minSilence: +e.target.value }); });
    box.querySelector('#tPad').addEventListener('input', (e) => { box.querySelector('#tPado').textContent = e.target.value + '초'; set({ pad: +e.target.value }); });
  }

  // ── 영상 구성 (이어 붙일 구간 목록) ──
  function excerpt(g) { const s = S.p.subtitles.find((x) => x.end > g.start && x.start < g.end && x.text); return s ? s.text : ''; }
  function renderSegs() {
    const c = clip(); const box = $('#segs'); const n = c.segments.length;
    box.innerHTML = `<div class="segs-head"><b>영상 구성</b><span class="meta">${n}개 구간 · 총 ${segTotal(c).toFixed(1)}초 · 위에서 아래 순서로 이어 붙여 재생됩니다</span><button class="btn sm" id="addseg">＋ 구간 추가</button></div>`;
    c.segments.forEach((g, i) => {
      const row = el(`<div class="segrow ${i === S.seg ? 'sel' : ''}" data-i="${i}">
        <span class="no">${i + 1}</span>
        <select class="role ${g.role || 'body'}">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${(g.role || 'body') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <span class="rng">${fmtP(g.start)}–${fmtP(g.end)} <em>${(g.end - g.start).toFixed(1)}초</em></span>
        <span class="ex">${esc(excerpt(g))}</span>
        <button class="x" data-a="up" title="위로" ${i === 0 ? 'disabled' : ''}>▲</button><button class="x" data-a="down" title="아래로" ${i === n - 1 ? 'disabled' : ''}>▼</button><button class="x" data-a="del" title="삭제" ${n === 1 ? 'disabled' : ''}>✕</button></div>`);
      row.onclick = (e) => {
        const a = e.target.dataset?.a;
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
        if (a) {
          stop();
          if (a === 'del') { c.segments.splice(i, 1); S.seg = Math.min(S.seg, c.segments.length - 1); }
          else { const j = a === 'up' ? i - 1 : i + 1; [c.segments[i], c.segments[j]] = [c.segments[j], c.segments[i]]; S.seg = j; }
          S.cur = curOf(clip(), S.seg); patchClip({ segments: c.segments }); computeWin(); renderAllCenter(); renderRight(); seek(selSeg().start); updatePreview(); renderList();
          return;
        }
        stop(); S.seg = i; S.cur = curOf(c, i); computeWin(); renderAllCenter(); seek(g.start); updatePreview();
      };
      row.querySelector('select').onchange = (e) => { g.role = e.target.value; e.target.className = `role ${g.role}`; patchClip({ segments: c.segments }); };
      box.append(row);
    });
    $('#addseg').onclick = () => {
      stop();
      let start = Math.min(S.t, p.video.duration - 1);
      const inside = c.segments.find((g) => start >= g.start && start < g.end);
      if (inside) start = inside.end;
      let end = Math.min(p.video.duration, start + 8);
      for (const g of c.segments) if (g.start >= start && g.start < end) end = g.start;
      if (end - start < 1) { toast('현재 위치에 구간을 추가할 공간이 없습니다. 재생 위치를 옮겨 보세요.', true); return; }
      c.segments.push({ start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, role: 'body' });
      S.seg = c.segments.length - 1; S.cur = curOf(clip(), S.seg);
      patchClip({ segments: c.segments }); computeWin(); renderAllCenter(); renderRight(); renderList(); seek(selSeg().start); updatePreview();
    };
  }

  // ── 오른쪽 패널 ──
  const subSave = { updates: new Map(), deletes: new Set() };
  const flushSubs = debounce(async () => {
    const body = { updates: [...subSave.updates].map(([id, text]) => ({ id, text })), deletes: [...subSave.deletes] };
    subSave.updates.clear(); subSave.deletes.clear();
    try { await api(`/api/projects/${p.id}/subtitles`, { method: 'PATCH', body }); renderList(); renderRender(); } catch (e) { toast(e.message, true); }
  }, 600);

  // 영상 화면 슬라이더 값을 현재 상태에 맞춰 갱신 (드래그/초기화/템플릿 변경 후)
  function syncFrameInputs() {
    const c = clip(); const fr = resolveFrame(effTpl(c), c);
    const set = (id, v, unit = '%') => { const i = root.querySelector('#' + id); if (!i) return; i.value = v; root.querySelector(`#${id}o`).textContent = v + unit; };
    set('fw', Math.round(fr.w * 100)); set('fh', Math.round(fr.h * 100)); set('fcy', Math.round(fr.cy * 100));
    set('zoom', Math.round((c.zoom || 1) * 100)); set('cx', Math.round(c.cropX * 100)); set('cy2', Math.round((c.cropY ?? 0.5) * 100));
  }

  function renderRight() {
    const c = clip(); const eff = effTpl(c); const fr = resolveFrame(eff, c);
    const r = $('#right');
    r.innerHTML = `
      <div class="sect"><h4>제목</h4>
        <div class="field"><textarea id="title" rows="2" placeholder="쇼츠 제목 (줄바꿈으로 2줄)">${esc(c.title)}</textarea></div>
        <label class="toggle"><span>제목 표시</span><input type="checkbox" id="titleOn" ${c.titleOn ? 'checked' : ''}></label></div>
      <div class="sect"><h4>템플릿 <a href="#/templates" style="color:var(--accent);font-weight:400">편집 →</a></h4>
        <div class="tplchips" id="tplchips">${templates.map((t) => `<button class="tplchip ${t.id === tplOf(c).id ? 'on' : ''}" data-id="${t.id}"><span class="sw" style="background:${t.layout === 'framed' ? t.bgColor : '#000'}"></span><b>${esc(t.name)}</b><small>${t.account ? esc(t.account) + ' · ' : ''}${t.layout === 'framed' ? '프레임' : '전체화면'}</small></button>`).join('')}</div>
        <button class="btn sm" id="applyall">모든 쇼츠에 이 템플릿 적용</button>
        <div class="meta">누르면 바로 미리보기에 반영돼요. 이 영상만 조정한 텍스트 스타일은 유지되고, 영상 크기 조정은 템플릿 기본 크기가 다르면 초기화돼요.</div></div>
      <div class="sect"><h4>영상 화면 <button class="btn sm" id="frameReset">초기화</button></h4>
        ${sliderHTML('fw', '영상 너비', 30, 100, 1, Math.round(fr.w * 100), '%')}
        ${sliderHTML('fh', '영상 높이', 20, 100, 1, Math.round(fr.h * 100), '%')}
        ${sliderHTML('fcy', '세로 위치', 0, 100, 1, Math.round(fr.cy * 100), '%')}
        ${sliderHTML('zoom', '확대', 100, 300, 1, Math.round((c.zoom || 1) * 100), '%')}
        ${sliderHTML('cx', '가로 이동', 0, 100, 1, Math.round(c.cropX * 100), '%')}
        ${sliderHTML('cy2', '세로 이동', 0, 100, 1, Math.round((c.cropY ?? 0.5) * 100), '%')}
        <div class="meta">영상의 너비·높이·위치와 확대/이동을 조정해요. 미리보기를 끌어서 옮길 수도 있어요.</div></div>
      <div class="sect"><h4>텍스트 스타일 <span class="meta">(이 영상만)</span> <button class="btn sm" id="styReset">초기화</button></h4>
        <div class="eltabs" id="styTabs">${Object.entries(EL_STY).map(([k, m]) => `<button data-k="${k}" class="${k === S.styEl ? 'on' : ''}">${m.label}</button>`).join('')}</div>
        <div id="stypanel" class="formgrid"></div></div>
      <div class="sect"><h4>자막</h4>
        <label class="toggle"><span>자막 표시</span><input type="checkbox" id="subOn" ${c.subtitleOn ? 'checked' : ''}></label>
        <div class="subrows" id="subrows"></div><button class="btn sm" id="addsub">＋ 현재 위치에 자막 추가</button></div>
      <div class="sect"><h4>게시글 정보 <button class="btn sm" id="copy">복사</button></h4>
        <div class="field"><textarea id="desc" rows="3" placeholder="설명">${esc(c.description)}</textarea></div>
        <div class="field"><input type="text" id="tags" placeholder="해시태그 (공백으로 구분)" value="${esc(c.hashtags.map((h) => '#' + h).join(' '))}"></div></div>
      <div class="sect" id="renderbox"></div>
      <div class="sect"><button class="btn danger" id="del">이 쇼츠 삭제</button></div>`;
    const q = (s) => r.querySelector(s);
    q('#title').oninput = (e) => { patchClip({ title: e.target.value }); updatePreview(); };
    q('#titleOn').onchange = (e) => { patchClip({ titleOn: e.target.checked }); updatePreview(); };
    q('#subOn').onchange = (e) => { patchClip({ subtitleOn: e.target.checked }); updatePreview(); };

    // 템플릿: 누르는 즉시 미리보기·목록·패널에 반영하고 저장은 뒤에서
    q('#tplchips').onclick = (e) => {
      const chip = e.target.closest('.tplchip'); if (!chip || chip.dataset.id === c.templateId) return;
      const next = templates.find((t) => t.id === chip.dataset.id);
      if (frameKey(tplOf(c)) !== frameKey(next)) c.frame = null; // 쇼츠별 영상 크기 조정은 템플릿 기본 프레임 기준이라, 기본 프레임이 다르면 초기화
      patchClip({ templateId: next.id, frame: c.frame ?? null });
      updatePreview(); renderRight();
    };
    q('#applyall').onclick = async () => {
      try {
        const res = await api(`/api/projects/${p.id}/apply-template`, { method: 'POST', body: { templateId: tplOf(c).id } });
        for (const u of res) Object.assign(S.p.clips.find((x) => x.id === u.id), u);
        renderList(); updatePreview(); toast(`모든 쇼츠(${res.length}개)에 적용했습니다`);
      } catch (err) { toast(err.message, true); }
    };

    // 영상 화면 (너비·높이·세로 위치·확대·이동) — 슬라이더를 움직이는 동안 바로 반영
    const bind = (id, fn, unit = '%') => q('#' + id).addEventListener('input', (e) => { q(`#${id}o`).textContent = e.target.value + unit; fn(+e.target.value / 100); });
    const setFrame = (patch) => {
      const cur = resolveFrame(effTpl(c), c);
      const f = { w: cur.w, h: cur.h, cy: cur.cy, ...patch };
      f.cy = clampN(f.cy, f.h / 2, 1 - f.h / 2, 0.5);
      c.frame = f; patchClip({ frame: f }); updatePreview(); syncFrameInputs();
    };
    bind('fw', (v) => setFrame({ w: v })); bind('fh', (v) => setFrame({ h: v })); bind('fcy', (v) => setFrame({ cy: v }));
    bind('zoom', (v) => { c.zoom = v; patchClip({ zoom: v }); updatePreview(); });
    bind('cx', (v) => { c.cropX = v; patchClip({ cropX: v }); updatePreview(); });
    bind('cy2', (v) => { c.cropY = v; patchClip({ cropY: v }); updatePreview(); });
    q('#frameReset').onclick = () => {
      Object.assign(c, { frame: null, zoom: 1, cropX: 0.5, cropY: 0.5 });
      patchClip({ frame: null, zoom: 1, cropX: 0.5, cropY: 0.5 }); updatePreview(); syncFrameInputs();
    };

    // 텍스트 스타일(이 영상만): 요소별 크기·테두리
    q('#styTabs').onclick = (e) => { const k = e.target.dataset.k; if (!k) return; S.styEl = k; q('#styTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === k)); renderStyPanel(); };
    q('#styReset').onclick = () => { c.overrides = {}; patchClip({ overrides: {} }); updatePreview(); renderStyPanel(); };
    renderStyPanel();
    q('#desc').oninput = (e) => patchClip({ description: e.target.value });
    q('#tags').onchange = (e) => patchClip({ hashtags: e.target.value.split(/[\s,]+/).map((h) => h.replace(/^#/, '')).filter(Boolean) });
    q('#copy').onclick = () => navigator.clipboard?.writeText(`${clip().title.replace(/\n/g, ' ')}\n\n${q('#desc').value}\n\n${q('#tags').value}`).then(() => toast('복사했습니다'));
    q('#del').onclick = async () => {
      if (!confirm('이 쇼츠를 삭제할까요?')) return;
      try { await api(`/api/projects/${p.id}/clips/${c.id}`, { method: 'DELETE' }); } catch (e) { return toast(e.message, true); }
      S.p.clips = S.p.clips.filter((x) => x.id !== c.id);
      if (!S.p.clips.length) return route();
      select(S.p.clips[0].id);
    };
    q('#addsub').onclick = async () => {
      const cg = eff(c)[Math.max(0, segIdxOf(c, S.t))];
      const t = Math.min(Math.max(S.t, cg.start), cg.end - 0.5);
      try {
        const res = await api(`/api/projects/${p.id}/subtitles`, { method: 'PATCH', body: { adds: [{ start: t, end: Math.min(cg.end, t + 2), text: '새 자막' }] } });
        S.p.subtitles.push(...res.created); S.p.subtitles.sort((a, b) => a.start - b.start); renderSubRows(); updatePreview(); renderList(); renderRender();
      } catch (e) { toast(e.message, true); }
    };
    renderSubRows(); renderRender();
  }

  function renderStyPanel() {
    const c = clip(); const eff = effTpl(c); const k = S.styEl; const m = EL_STY[k];
    const box = root.querySelector('#stypanel'); if (!box) return;
    const mine = () => Object.keys(c.overrides || {}).some((x) => x.startsWith(k));
    box.innerHTML = `
      ${sliderHTML('sSize', '크기', m.min, m.max, 1, eff[k + 'Size'], 'px')}
      <div class="decor ${eff[k + 'OutlineOn'] ? '' : 'off'}" id="sd"><label class="toggle"><span>테두리</span><input type="checkbox" id="sOn" ${eff[k + 'OutlineOn'] ? 'checked' : ''}></label>
        <div class="opts"><div class="colorrow"><input type="color" id="sCol" value="${eff[k + 'OutlineColor']}"><span class="meta">테두리 색</span></div>${sliderHTML('sW', '두께', 1, 24, 1, eff[k + 'OutlineWidth'], 'px')}</div></div>
      <div class="meta ovnote" id="ovnote" ${mine() ? '' : 'hidden'} style="color:#a5b4fc">${m.label}: 이 영상만 따로 조정됨 (템플릿 값과 다름)</div>`;
    const set = (key, v) => { c.overrides = { ...(c.overrides || {}), [key]: v }; patchClip({ overrides: c.overrides }); updatePreview(); box.querySelector('#ovnote').hidden = false; };
    box.querySelector('#sSize').addEventListener('input', (e) => { box.querySelector('#sSizeo').textContent = e.target.value + 'px'; set(k + 'Size', +e.target.value); });
    box.querySelector('#sOn').onchange = (e) => { box.querySelector('#sd').classList.toggle('off', !e.target.checked); set(k + 'OutlineOn', e.target.checked); };
    box.querySelector('#sCol').addEventListener('input', (e) => set(k + 'OutlineColor', e.target.value));
    box.querySelector('#sW').addEventListener('input', (e) => { box.querySelector('#sWo').textContent = e.target.value + 'px'; set(k + 'OutlineWidth', +e.target.value); });
  }

  function renderSubRows() {
    const c = clip(); const box = root.querySelector('#subrows'); if (!box) return;
    const subs = subsIn(c).sort((x, y) => outStart(c, x) - outStart(c, y));
    box.innerHTML = subs.length ? '' : '<div class="meta">이 구간에는 자막이 없습니다.</div>';
    for (const s of subs) {
      const si = eff(c).findIndex((g) => s.end > g.start && s.start < g.end);
      const sg = eff(c)[si];
      const row = el(`<div class="subrow" data-id="${s.id}"><span class="tm">${fmtP(outStart(c, s))}</span><input type="text" value="${esc(s.text)}"><button class="x" title="삭제">✕</button></div>`);
      row.querySelector('.tm').onclick = () => { stop(); S.cur = si; seek(Math.max(sg.start, s.start)); };
      row.querySelector('input').oninput = (e) => { s.text = e.target.value; subSave.updates.set(s.id, s.text); flushSubs(); updatePreview(); };
      row.querySelector('.x').onclick = () => { S.p.subtitles = S.p.subtitles.filter((x) => x !== s); subSave.deletes.add(s.id); subSave.updates.delete(s.id); flushSubs(); renderSubRows(); updatePreview(); };
      box.append(row);
    }
  }

  // ── 렌더링 ──
  function renderRender() {
    const box = root.querySelector('#renderbox'); if (!box) return;
    const c = clip(); const r = c.render || {};
    const busy = r.status === 'queued' || r.status === 'rendering';
    box.innerHTML = `<h4>내보내기 (1080×1920 MP4)</h4>
      ${busy ? `<div class="progress"><i style="width:${r.pct || 0}%"></i></div><div class="meta">${r.status === 'queued' ? '대기 중…' : `렌더링 중 ${r.pct || 0}%`}</div>` : ''}
      ${r.status === 'error' ? `<div class="err-box" style="margin:0">${esc(r.error)}</div>` : ''}
      ${r.status === 'done' ? `<div class="meta"><span class="badge ${r.stale ? 'warn' : 'ok'}">${r.stale ? '수정 사항이 반영되지 않았습니다' : '렌더링 완료'}</span><span>${(r.size / 1048576).toFixed(1)}MB</span></div>` : ''}
      <button class="btn primary" id="render" ${busy ? 'disabled' : ''}>${r.status === 'done' ? '다시 렌더링' : '쇼츠 만들기'}</button>
      ${r.status === 'done' ? `<div class="row" style="gap:8px"><a class="btn" id="dl" href="/api/projects/${p.id}/clips/${c.id}/download">⬇ MP4 다운로드</a><button class="btn" id="view">결과 보기</button></div>` : ''}`;
    box.querySelector('#render').onclick = async () => {
      flushClip.flush(); await flushPendingNow();
      try { const res = await api(`/api/projects/${p.id}/clips/${c.id}/render`, { method: 'POST' }); c.render = res.render; renderRender(); schedulePoll(); } catch (e) { toast(e.message, true); }
    };
    box.querySelector('#view')?.addEventListener('click', () => {
      const m = el(`<div class="modal"><video src="/api/projects/${p.id}/clips/${c.id}/download?inline=1&v=${r.at}" controls autoplay></video></div>`);
      m.onclick = (e) => { if (e.target === m) m.remove(); };
      document.body.append(m);
    });
  }
  async function flushPendingNow() {
    for (const [id, patch] of [...pending]) { pending.delete(id); try { await api(`/api/projects/${p.id}/clips/${id}`, { method: 'PATCH', body: patch }); } catch (e) { toast(e.message, true); } }
    if (subSave.updates.size || subSave.deletes.size) {
      const body = { updates: [...subSave.updates].map(([id, text]) => ({ id, text })), deletes: [...subSave.deletes] };
      subSave.updates.clear(); subSave.deletes.clear();
      await api(`/api/projects/${p.id}/subtitles`, { method: 'PATCH', body }).catch((e) => toast(e.message, true));
    }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!S.p.clips.some((c) => ['queued', 'rendering'].includes(c.render?.status))) return;
    pollTimer = setTimeout(async () => {
      try {
        const q = await api(`/api/projects/${p.id}?subs=0`);
        for (const qc of q.clips) { const c = S.p.clips.find((x) => x.id === qc.id); if (c) c.render = qc.render; }
        renderRender(); renderList();
      } catch {}
      schedulePoll();
    }, 1000);
  }

  $('#addclip').onclick = async () => {
    const c = clip(); const start = Math.min(S.t, p.video.duration - 5);
    try { const n = await api(`/api/projects/${p.id}/clips`, { method: 'POST', body: { start, end: Math.min(p.video.duration, start + 30) } }); S.p.clips.push(n); select(n.id); } catch (e) { toast(e.message, true); }
  };
  $('#reanalyze').onclick = async () => {
    if (!confirm('다시 분석하면 현재 쇼츠 후보와 편집 내용이 모두 사라집니다. 계속할까요?')) return;
    try { await api(`/api/projects/${p.id}/reset`, { method: 'POST' }); route(); } catch (e) { toast(e.message, true); }
  };

  cleanup = () => { S.playing = false; vid.pause(); };
  renderList(); renderRight(); computeWin(); renderAllCenter();
  vid.addEventListener('loadedmetadata', () => { seek(eff(clip())[0].start); updatePreview(); }, { once: true });
  updatePreview(); schedulePoll();
}

// ───────────────────────── 템플릿 설정 ─────────────────────────

const EL_META = {
  title: { pre: 'title', label: '제목', node: '.ov-title', x: 'titleX', y: 'titleY', font: 'titleFont', size: 'titleSize', min: 40, max: 130 },
  sub: { pre: 'sub', label: '자막', node: '.ov-sub', x: 'subX', y: 'subY', font: 'subFont', size: 'subSize', min: 36, max: 110 },
  account: { pre: 'account', label: '계정명', node: '.ov-acc', x: 'accountX', y: 'accountY', font: 'accountFont', size: 'accountSize', min: 24, max: 110 },
};

async function templatesPage() {
  let list = await api('/api/templates');
  let selId = list[0].id;
  let d = { ...list[0] };
  let dirty = false;
  let selEl = 'title';
  $app.innerHTML = '';
  const page = el(`<div class="page" style="max-width:1300px"><h1>템플릿 설정</h1>
    <p class="sub">미리보기에서 제목·자막·계정명을 <b>끌어서 위치를 바꾸고</b>, 오른쪽에서 폰트·크기·색을 고르세요. 만든 템플릿은 쇼츠마다 골라 쓸 수 있습니다.</p>
    <div class="tplpage"><div><div class="tpllist" id="tl"></div><button class="btn" id="new" style="margin-top:10px;width:100%">＋ 새 템플릿</button></div>
      <div class="box formgrid" id="form"></div>
      <div class="phonecol"><div class="phone static edit" id="ph">${PHONE_HTML}</div><div class="hint2">제목·자막·계정명을 끌어서 이동 · 가운데에 가까워지면 자동 정렬</div></div></div></div>`);
  $app.append(page);
  const $ = (q) => page.querySelector(q);
  const ph = $('#ph');
  ph.querySelector('.vwrap').innerHTML = '<div class="sample"></div>';

  const repaint = () => {
    paintPhone(ph, d, { title: ['쇼츠 제목 첫번째 줄', '쇼츠 제목 마지막 줄'], sub: '자막은 이렇게 보입니다', accountPlaceholder: '@계정명' });
    for (const [k, m] of Object.entries(EL_META)) ph.querySelector(m.node).classList.toggle('sel', k === selEl);
  };
  const touch = () => { dirty = true; repaint(); };

  function renderList() {
    $('#tl').innerHTML = '';
    for (const t of list) {
      const it = el(`<div class="tplitem ${t.id === selId ? 'sel' : ''}"><div><div>${esc(t.name)}</div><div class="meta">${t.account ? esc(t.account) : '계정명 없음'} · ${t.layout === 'framed' ? '프레임' : '전체화면'}</div></div></div>`);
      it.onclick = () => { if (t.id === selId) return; if (dirty && !confirm('저장하지 않은 변경 사항이 사라집니다. 계속할까요?')) return; select(t.id); };
      $('#tl').append(it);
    }
  }
  function select(id) { selId = id; d = { ...list.find((t) => t.id === id) }; dirty = false; renderList(); renderForm(); }

  function renderForm() {
    const f = $('#form');
    f.innerHTML = `
      <div class="two"><div class="field"><label>템플릿 이름</label><input type="text" id="name" maxlength="30" value="${esc(d.name)}"></div>
        <div class="field"><label>계정명 (모든 쇼츠에 표시)</label><input type="text" id="account" maxlength="40" placeholder="@내채널" value="${esc(d.account)}"></div></div>
      <div class="field"><label>레이아웃</label><div class="seg" id="layout"><button data-k="full" class="${d.layout === 'full' ? 'on' : ''}">전체화면</button><button data-k="framed" class="${d.layout === 'framed' ? 'on' : ''}">프레임 (배경색 + 정사각 영상)</button></div>
        <div class="hint2">레이아웃을 바꾸면 요소 위치와 영상 크기가 그 레이아웃의 기본값으로 돌아갑니다.</div></div>
      <div class="decor" id="framebox"><label class="toggle"><span>영상 크기</span><button class="btn sm" id="frameDef" type="button">기본값</button></label>
        <div class="opts">
          ${sliderHTML('tfw', '영상 너비', 30, 100, 1, Math.round(d.frameW * 100), '%')}
          ${sliderHTML('tfh', '영상 높이', 20, 100, 1, Math.round(d.frameH * 100), '%')}
          ${sliderHTML('tfcy', '세로 위치', 0, 100, 1, Math.round(d.frameCy * 100), '%')}
          <div class="colorrow"><input type="color" id="bgColor" value="${d.bgColor}"><span class="meta">배경색 (영상 밖 영역)</span></div>
          <div class="hint2">미리보기에서 영상(보라색 배경) 영역을 위아래로 끌어 위치를 바꿀 수도 있어요. 쇼츠마다 편집기에서 다시 조정할 수 있습니다.</div></div></div>
      <div class="field"><label>편집할 요소 (미리보기에서 눌러도 선택돼요)</label><div class="eltabs" id="eltabs">${Object.entries(EL_META).map(([k, m]) => `<button data-k="${k}" class="${k === selEl ? 'on' : ''}">${m.label}</button>`).join('')}</div></div>
      <div id="elpanel" class="formgrid"></div>
      <div class="row" style="margin-top:6px"><button class="btn primary" id="save">저장</button><button class="btn" id="dup">복제</button><button class="btn danger" id="del" style="margin-left:auto">삭제</button></div>`;
    f.querySelector('#name').oninput = (e) => { d.name = e.target.value; touch(); };
    f.querySelector('#account').oninput = (e) => { d.account = e.target.value; touch(); };
    f.querySelector('#bgColor').oninput = (e) => { d.bgColor = e.target.value; touch(); };
    f.querySelector('#layout').onclick = (e) => {
      const v = e.target.dataset.k; if (!v || v === d.layout) return;
      d.layout = v;
      const pd = config.positionDefaults[v];
      [d.titleX, d.titleY] = pd.title; [d.subX, d.subY] = pd.sub; [d.accountX, d.accountY] = pd.account;
      d.accountOutlineOn = v === 'full';
      const fdef = config.frameDefaults[v];
      [d.frameW, d.frameH, d.frameCy] = [fdef.w, fdef.h, fdef.cy];
      f.querySelectorAll('#layout button').forEach((b) => b.classList.toggle('on', b.dataset.k === v));
      syncFrame();
      touch(); renderPanel();
    };
    // 영상 크기 (템플릿 기본값): 슬라이더를 움직이는 동안 미리보기에 바로 반영
    const fbind = (id, fn) => f.querySelector('#' + id).addEventListener('input', (e) => { f.querySelector(`#${id}o`).textContent = e.target.value + '%'; fn(+e.target.value / 100); touch(); });
    fbind('tfw', (v) => { d.frameW = v; }); fbind('tfh', (v) => { d.frameH = v; clampCy(); syncFrame(); }); fbind('tfcy', (v) => { d.frameCy = v; clampCy(); syncFrame(); });
    f.querySelector('#frameDef').onclick = () => { const fdef = config.frameDefaults[d.layout]; [d.frameW, d.frameH, d.frameCy] = [fdef.w, fdef.h, fdef.cy]; syncFrame(); touch(); };
    f.querySelector('#eltabs').onclick = (e) => { const k = e.target.dataset.k; if (k) chooseEl(k); };
    f.querySelector('#save').onclick = async () => {
      try {
        const t = await api(`/api/templates/${selId}`, { method: 'PUT', body: d });
        list = list.map((x) => (x.id === t.id ? t : x)); d = { ...t }; dirty = false; renderList(); toast('저장했습니다');
      } catch (e) { toast(e.message, true); }
    };
    f.querySelector('#dup').onclick = async () => {
      try { const t = await api('/api/templates', { method: 'POST', body: { ...d, name: d.name + ' 복사' } }); list.push(t); select(t.id); toast('복제했습니다'); } catch (e) { toast(e.message, true); }
    };
    f.querySelector('#del').onclick = async () => {
      if (!confirm(`"${d.name}" 템플릿을 삭제할까요? 이 템플릿을 쓰던 쇼츠는 첫 번째 템플릿으로 바뀝니다.`)) return;
      try { await api(`/api/templates/${selId}`, { method: 'DELETE' }); list = list.filter((x) => x.id !== selId); select(list[0].id); } catch (e) { toast(e.message, true); }
    };
    renderPanel(); repaint();
  }

  // 프레임이 캔버스 밖으로 나가지 않도록 세로 위치 제한, 슬라이더 값 동기화
  function clampCy() { d.frameCy = Math.min(1 - d.frameH / 2, Math.max(d.frameH / 2, d.frameCy)); }
  function syncFrame() {
    const f = $('#form'); if (!f) return;
    const set = (id, v) => { const i = f.querySelector('#' + id); if (!i) return; i.value = v; f.querySelector(`#${id}o`).textContent = v + '%'; };
    set('tfw', Math.round(d.frameW * 100)); set('tfh', Math.round(d.frameH * 100)); set('tfcy', Math.round(d.frameCy * 100));
    const bg = f.querySelector('#bgColor'); if (bg) bg.value = d.bgColor;
  }

  function chooseEl(k) {
    selEl = k;
    page.querySelectorAll('#eltabs button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
    renderPanel(); repaint();
  }

  // 선택한 요소의 속성 패널
  function renderPanel() {
    const m = EL_META[selEl]; const pre = m.pre; const box = $('#elpanel');
    const slider = (id, label, min, max, step, val, unit = '') => `<div class="slider"><label>${label}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output id="${id}o">${val}${unit}</output></div>`;
    const color = (id, label, val) => `<div class="colorrow"><input type="color" id="${id}" value="${val}"><span class="meta">${label}</span></div>`;
    const fonts = config.fonts || [];
    box.innerHTML = `
      <div class="field"><label>${m.label} 폰트</label><div class="fontgrid" id="fonts">${fonts.map((f) => `<button class="fontchip ${d[m.font] === f.id ? 'on' : ''}" data-id="${f.id}" style="font-family:${fontStack(f.id)}"><span>가나다 쇼츠 Abc</span><small>${esc(f.label)}</small></button>`).join('')}</div></div>
      ${slider('size', '크기', m.min, m.max, 1, d[m.size])}
      ${selEl === 'title' ? `<div class="two">${color('c1', '첫째 줄 색', d.titleColor1)}${color('c2', '둘째 줄 색', d.titleColor2)}</div>` : ''}
      ${selEl === 'sub' ? `${color('c4', '글자 색', d.subColor)}<div class="field"><label>빠른 선택</label><div class="presets" id="presets">${Object.entries(config.subPresets || {}).map(([k, v]) => `<button class="btn sm" data-k="${k}">${esc(v.label)}</button>`).join('')}</div></div>` : ''}
      ${selEl === 'account' ? color('c3', '글자 색', d.accountColor) : ''}
      <div class="decor ${d[pre + 'OutlineOn'] ? '' : 'off'}" id="d-outline"><label class="toggle"><span>테두리</span><input type="checkbox" id="olOn" ${d[pre + 'OutlineOn'] ? 'checked' : ''}></label>
        <div class="opts">${color('olColor', '테두리 색', d[pre + 'OutlineColor'])}${slider('olWidth', '두께', 1, 24, 1, d[pre + 'OutlineWidth'], 'px')}</div></div>
      <div class="decor ${d[pre + 'BgOn'] ? '' : 'off'}" id="d-bg"><label class="toggle"><span>배경 박스</span><input type="checkbox" id="bgOn" ${d[pre + 'BgOn'] ? 'checked' : ''}></label>
        <div class="opts">${color('bgColor2', '배경 색', d[pre + 'BgColor'])}${slider('bgOpacity', '불투명도', 0, 100, 1, d[pre + 'BgOpacity'], '%')}${slider('bgPad', '여백', 0, 60, 1, d[pre + 'BgPad'], 'px')}</div></div>
      <div class="field"><label>위치 (미리보기에서 끌어도 돼요)</label>
        ${slider('px', '가로', 0, 100, 0.5, Math.round(d[m.x] * 200) / 2, '%')}
        ${slider('py', '세로', 0, 100, 0.5, Math.round(d[m.y] * 200) / 2, '%')}
        <div class="row" style="gap:8px"><button class="btn sm" id="center">가운데 맞춤</button><button class="btn sm" id="resetpos">위치 초기화</button></div></div>`;
    box.querySelector('#fonts').onclick = (e) => {
      const chip = e.target.closest('.fontchip'); if (!chip) return;
      d[m.font] = chip.dataset.id; box.querySelectorAll('.fontchip').forEach((c) => c.classList.toggle('on', c === chip)); touch();
    };
    box.querySelector('#size').oninput = (e) => { d[m.size] = +e.target.value; box.querySelector('#sizeo').textContent = e.target.value; touch(); };
    box.querySelector('#c1')?.addEventListener('input', (e) => { d.titleColor1 = e.target.value; touch(); });
    box.querySelector('#c2')?.addEventListener('input', (e) => { d.titleColor2 = e.target.value; touch(); });
    box.querySelector('#c3')?.addEventListener('input', (e) => { d.accountColor = e.target.value; touch(); });
    box.querySelector('#c4')?.addEventListener('input', (e) => { d.subColor = e.target.value; touch(); });
    // 테두리 / 배경
    const bind = (id, key, fmt) => box.querySelector('#' + id).addEventListener('input', (e) => {
      d[pre + key] = e.target.type === 'range' ? +e.target.value : e.target.value;
      const o = box.querySelector(`#${id}o`); if (o) o.textContent = e.target.value + fmt;
      touch();
    });
    bind('olColor', 'OutlineColor', ''); bind('olWidth', 'OutlineWidth', 'px');
    bind('bgColor2', 'BgColor', ''); bind('bgOpacity', 'BgOpacity', '%'); bind('bgPad', 'BgPad', 'px');
    box.querySelector('#olOn').onchange = (e) => { d[pre + 'OutlineOn'] = e.target.checked; box.querySelector('#d-outline').classList.toggle('off', !e.target.checked); touch(); };
    box.querySelector('#bgOn').onchange = (e) => { d[pre + 'BgOn'] = e.target.checked; box.querySelector('#d-bg').classList.toggle('off', !e.target.checked); touch(); };
    box.querySelector('#presets')?.addEventListener('click', (e) => {
      const p = config.subPresets?.[e.target.dataset?.k]; if (!p) return;
      Object.assign(d, { subColor: p.color, subOutlineOn: p.outlineOn, subOutlineColor: p.outlineColor, subOutlineWidth: p.outlineWidth, subBgOn: p.bgOn, subBgColor: p.bgColor, subBgOpacity: p.bgOpacity, subBgPad: p.bgPad });
      renderPanel(); touch();
    });
    box.querySelector('#px').oninput = (e) => { d[m.x] = e.target.value / 100; box.querySelector('#pxo').textContent = `${e.target.value}%`; touch(); };
    box.querySelector('#py').oninput = (e) => { d[m.y] = e.target.value / 100; box.querySelector('#pyo').textContent = `${e.target.value}%`; touch(); };
    box.querySelector('#center').onclick = () => { d[m.x] = 0.5; syncPos(); touch(); };
    box.querySelector('#resetpos').onclick = () => {
      const pd = config.positionDefaults[d.layout][selEl];
      [d[m.x], d[m.y]] = pd; syncPos(); touch();
    };
  }
  function syncPos() {
    const m = EL_META[selEl]; const box = $('#elpanel');
    const x = Math.round(d[m.x] * 200) / 2; const y = Math.round(d[m.y] * 200) / 2;
    box.querySelector('#px').value = x; box.querySelector('#pxo').textContent = `${x}%`;
    box.querySelector('#py').value = y; box.querySelector('#pyo').textContent = `${y}%`;
  }

  // 미리보기에서 요소 드래그
  let drag = null;
  let fdrag = null;
  ph.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.ov') && e.target.closest('.vwrap')) { // 영상 영역: 위아래로 끌어 세로 위치 조정
      fdrag = { r: ph.getBoundingClientRect(), y: e.clientY, cy: d.frameCy }; ph.setPointerCapture(e.pointerId); return;
    }
    const node = e.target.closest('.ov'); if (!node) return;
    const key = Object.keys(EL_META).find((k) => node.matches(EL_META[k].node)); if (!key) return;
    if (key !== selEl) chooseEl(key);
    const m = EL_META[key]; const r = ph.getBoundingClientRect();
    drag = { m, r, px: (e.clientX - r.left) / r.width, py: (e.clientY - r.top) / r.height, x: d[m.x], y: d[m.y] };
    ph.setPointerCapture(e.pointerId);
  });
  ph.addEventListener('pointermove', (e) => {
    if (fdrag) { d.frameCy = fdrag.cy + (e.clientY - fdrag.y) / fdrag.r.height; clampCy(); d.frameCy = Math.round(d.frameCy * 1000) / 1000; syncFrame(); touch(); return; }
    if (!drag) return;
    const { m, r } = drag;
    let nx = drag.x + ((e.clientX - r.left) / r.width - drag.px);
    let ny = drag.y + ((e.clientY - r.top) / r.height - drag.py);
    nx = Math.min(0.98, Math.max(0.02, nx)); ny = Math.min(0.98, Math.max(0.02, ny));
    const sx = Math.abs(nx - 0.5) < 0.015; const sy = Math.abs(ny - 0.5) < 0.012;
    if (sx) nx = 0.5; if (sy) ny = 0.5;
    ph.querySelector('.gv').style.display = sx ? 'block' : 'none';
    ph.querySelector('.gh').style.display = sy ? 'block' : 'none';
    d[m.x] = Math.round(nx * 1000) / 1000; d[m.y] = Math.round(ny * 1000) / 1000;
    syncPos(); touch();
  });
  const endDrag = () => { drag = null; fdrag = null; ph.querySelector('.gv').style.display = 'none'; ph.querySelector('.gh').style.display = 'none'; };
  ph.addEventListener('pointerup', endDrag); ph.addEventListener('pointercancel', endDrag);

  $('#new').onclick = async () => {
    if (dirty && !confirm('저장하지 않은 변경 사항이 사라집니다. 계속할까요?')) return;
    try { const t = await api('/api/templates', { method: 'POST', body: {} }); list.push(t); select(t.id); } catch (e) { toast(e.message, true); }
  };
  cleanup = () => {};
  renderList(); renderForm();
}

init();
