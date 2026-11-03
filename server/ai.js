import fs from 'node:fs';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { OPENAI_API_KEY, ANTHROPIC_API_KEY, WHISPER_MODEL, CLAUDE_MODEL, MOCK_AI, STT_PROVIDER } from './config.js';
import { localAvailable, transcribeLocal } from './stt-local.js';

/** 음성 인식 방식 결정: 명시 설정 > OpenAI 키 > 설치된 로컬 whisper.cpp */
export function pickSttProvider({ explicit = STT_PROVIDER, openaiKey = OPENAI_API_KEY, localOk = localAvailable() } = {}) {
  if (explicit === 'openai') return openaiKey ? 'openai' : null;
  if (explicit === 'local') return localOk ? 'local' : null;
  if (openaiKey) return 'openai';
  if (localOk) return 'local';
  return null;
}

export const capabilities = () => {
  const stt = pickSttProvider();
  return {
    mock: MOCK_AI,
    sttProvider: MOCK_AI ? 'mock' : stt,
    transcription: MOCK_AI || !!stt,
    highlights: MOCK_AI || !!ANTHROPIC_API_KEY,
    highlightsFallback: !MOCK_AI && !ANTHROPIC_API_KEY,
  };
};

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ───────────────────────── 음성 인식 (STT) ─────────────────────────

/** 반환: { segments: 문장 단위, words: 단어 단위(가능한 경우만, 군말 찾기에 사용) } */
export async function transcribeChunks(chunks, opts) {
  const provider = pickSttProvider();
  if (provider === 'local') return { segments: await transcribeLocal(chunks, opts), words: [] };
  return transcribeOpenAI(chunks, opts);
}

async function transcribeOpenAI(chunks, { language, onProgress }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const results = new Array(chunks.length);
  const wordResults = new Array(chunks.length).fill(null).map(() => []);
  let wantWords = true; // 단어 타임스탬프를 지원하지 않는 응답이면 문장 단위로만 진행
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      const c = chunks[i];
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await client.audio.transcriptions.create({
            file: fs.createReadStream(c.file),
            model: WHISPER_MODEL,
            response_format: 'verbose_json',
            timestamp_granularities: wantWords ? ['word', 'segment'] : ['segment'],
            ...(language && language !== 'auto' ? { language } : {}),
          });
          break;
        } catch (e) {
          if (wantWords && e?.status === 400) { wantWords = false; continue; } // 단어 단위 요청이 거절되면 문장 단위로 재시도
          if (attempt >= 2) throw new Error(`음성 인식 실패: ${e.message}`);
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      results[i] = (res.segments || []).map((s) => ({
        start: c.offset + s.start,
        end: c.offset + s.end,
        text: String(s.text || '').trim(),
        noSpeech: s.no_speech_prob ?? 0,
      }));
      wordResults[i] = (res.words || []).map((w) => ({ start: c.offset + w.start, end: c.offset + w.end, text: String(w.word || '').trim() }));
      onProgress?.(++done / chunks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));
  return { segments: results.flat().filter((s) => s.text && s.noSpeech < 0.85), words: wordResults.flat() };
}

// ───────────────────────── 하이라이트 선정 ─────────────────────────

const TOOL = {
  name: 'submit_shorts',
  description: '롱폼 영상에서 구성한 쇼츠들을 제출한다. 각 쇼츠는 재생 순서대로 이어 붙일 구간(segments)의 목록이다.',
  input_schema: {
    type: 'object',
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            segments: {
              type: 'array',
              description: '재생 순서대로 이어 붙일 원본 구간들',
              items: {
                type: 'object',
                properties: {
                  start: { type: 'number', description: '원본 영상 기준 시작(초)' },
                  end: { type: 'number', description: '원본 영상 기준 종료(초)' },
                  role: { type: 'string', enum: ['hook', 'body', 'ending'], description: 'hook=시작 후킹, body=본론, ending=마무리' },
                },
                required: ['start', 'end', 'role'],
              },
            },
            title: { type: 'string', description: '쇼츠 제목. 최대 2줄, 줄당 14자 이내, 줄바꿈은 \\n' },
            score: { type: 'integer', description: '0~100 종합 점수' },
            reason: { type: 'string', description: '이 구성을 택한 이유 (한 문장)' },
            summary: { type: 'string', description: '쇼츠의 흐름 요약 (예: 결론 먼저 → 문제 상황 → 해결 방법)' },
            description: { type: 'string', description: 'SNS 게시물 설명 (2~3문장)' },
            hashtags: { type: 'array', items: { type: 'string' }, description: '해시태그 5~8개, # 제외' },
          },
          required: ['segments', 'title', 'score', 'reason', 'summary', 'description', 'hashtags'],
        },
      },
    },
    required: ['clips'],
  },
};

const RULES_CONTEXT = (minLen, maxLen) => `이 서비스의 쇼츠는 "구간 하나를 그대로 자른 것"이 아니라, 내용의 맥락을 이해해 여러 구간을 골라 재생 순서대로 이어 붙인 편집본입니다. 시청자가 끝까지 보게 만드는 구성을 설계하세요.

구성 원칙:
1. 후킹: 가장 흥미로운 한마디(결론, 핵심 주장, 반전, 강한 감정)를 3~8초 길이의 hook 구간으로 맨 앞에 둡니다. 원본에서 더 뒤에 나오는 장면이어도 앞으로 가져올 수 있습니다. 후킹으로 쓴 구간은 본론에서 중복해서 쓰지 마세요.
2. 본론(body): 후킹을 이해시키는 맥락과 핵심 내용을 원본의 시간 순서대로 이어 붙입니다. 잡담, 반복, 말 더듬기, 주제에서 벗어난 곁가지, 긴 침묵·공백 구간은 건너뛰세요.
3. 마무리(ending): 가능하면 결론/한 줄 정리로 끝나는 구간을 마지막에 둡니다.
4. 구간은 쇼츠당 최대 5개. 각 구간은 문장 경계에서 시작하고 끝나야 하며, 이어 붙였을 때 말이 자연스럽게 이어져야 합니다(문장 중간에서 끊지 말 것).
5. 한 쇼츠 안에서도, 서로 다른 쇼츠 사이에서도 구간이 겹치면 안 됩니다.
6. 구간 길이의 합계는 ${minLen}초 이상 ${maxLen}초 이하여야 합니다.
7. 후킹이 필요 없을 만큼 시작이 강하면 hook 없이 body로 시작해도 됩니다.`;

const RULES_SINGLE = (minLen, maxLen) => `각 쇼츠는 원본의 연속된 구간 하나(segments에 항목 1개, role은 body)로 구성하세요. 길이는 ${minLen}초 이상 ${maxLen}초 이하, 구간끼리 겹치지 않게 하세요.`;

export async function pickHighlights({ transcript, duration, minLen, maxLen, count, title, mode = 'context' }) {
  if (!ANTHROPIC_API_KEY) return heuristicHighlights({ transcript, duration, minLen, maxLen, count });
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const body = transcript.map((s) => `[${s.start.toFixed(1)}~${s.end.toFixed(1)}] ${s.text}`).join('\n');
  const prompt = `다음은 "${title}" 영상(총 ${mmss(duration)})의 타임스탬프 포함 전사본입니다. 각 줄 앞의 [시작~끝]은 해당 발화의 구간(초)입니다.

이 영상에서 유튜브 쇼츠/릴스/틱톡으로 만들 가치가 가장 높은 쇼츠 ${count}개를 구성해 submit_shorts 도구로 제출하세요.

${mode === 'single' ? RULES_SINGLE(minLen, maxLen) : RULES_CONTEXT(minLen, maxLen)}

선정 기준 (score에 반영):
- 첫 3초 안에 시청자의 관심을 끄는 정도(후킹)
- 그 쇼츠만 봐도 이해되는 정보/스토리 완결성
- 감정 변화, 몰입도, 웃음·놀라움·갈등 등 핵심 이벤트
- 이어 붙인 부분의 자연스러움과 군더더기 없는 밀도

공통 규칙:
- start/end는 전사본에 있는 발화의 경계(초)에 맞출 것
- 전사본에 없는 내용을 지어내지 말 것
- 제목은 호기심을 자극하는 한국어 문구. 최대 2줄, 줄당 14자 이내
- score 높은 순으로 정렬

전사본:
${body}`;
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 10000,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: prompt }],
  });
  const tu = res.content.find((b) => b.type === 'tool_use');
  if (!tu) throw new Error('AI가 하이라이트를 반환하지 않았습니다.');
  return tu.input.clips || [];
}

/** Claude 키가 없을 때: 발화 밀도가 높은 구간을 고르는 단순 대체 로직 */
export function heuristicHighlights({ transcript, duration, minLen, maxLen, count }) {
  const win = (minLen + maxLen) / 2;
  const step = Math.max(5, win / 4);
  const cands = [];
  for (let s = 0; s + minLen <= duration; s += step) {
    const e = Math.min(duration, s + win);
    const chars = transcript.filter((t) => t.start >= s && t.end <= e).reduce((n, t) => n + t.text.length, 0);
    cands.push({ start: s, end: e, density: chars / (e - s) });
  }
  cands.sort((a, b) => b.density - a.density);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue;
    picked.push(c);
  }
  const max = Math.max(1, ...picked.map((p) => p.density));
  return picked.map((p, i) => ({
    segments: [{ start: p.start, end: p.end, role: 'body' }],
    title: `하이라이트 ${i + 1}`,
    score: Math.round(40 + 40 * (p.density / max)),
    reason: '발화 밀도가 높은 구간 (ANTHROPIC_API_KEY가 없어 단순 규칙으로 선정)',
    summary: '',
    description: '',
    hashtags: [],
  }));
}

/**
 * 한 쇼츠의 구간 목록 보정: 발화 경계 스냅, 클립 내 겹침 제거, 인접 구간 병합, 총 길이 제한.
 * 반환 구간의 순서는 재생 순서(= 입력 순서)를 유지한다.
 */
export function normalizeSegments(rawSegs, { transcript, duration, maxLen, maxSegments = 5 }) {
  const snap = (t, key, tol) => {
    let best = t;
    let bd = tol + 1e-6;
    for (const s of transcript) {
      const d = Math.abs(s[key] - t);
      if (d < bd) { bd = d; best = s[key]; }
    }
    return best;
  };
  const out = [];
  let total = 0;
  for (const r of rawSegs || []) {
    if (out.length >= maxSegments) break;
    let start = Math.max(0, Number(r.start));
    let end = Math.min(duration, Number(r.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (transcript.length) { start = snap(start, 'start', 2); end = snap(end, 'end', 2); }
    if (end - start < 1) continue;
    if (out.some((o) => start < o.end && end > o.start)) continue; // 같은 쇼츠 안에서 겹침
    // 직전 구간과 원본에서 바로 이어지면 하나로 합친다
    const prev = out[out.length - 1];
    if (prev && start >= prev.end - 1e-6 && start - prev.end <= 0.6) {
      const add = end - prev.end;
      if (total + add > maxLen) { prev.end = round(Math.min(end, prev.end + (maxLen - total))); total = maxLen; break; }
      prev.end = round(end);
      total += add;
      continue;
    }
    if (total + (end - start) > maxLen) {
      const room = maxLen - total;
      if (room < 2) break;
      end = start + room;
    }
    out.push({ start: round(start), end: round(end), role: ['hook', 'body', 'ending'].includes(r.role) ? r.role : 'body' });
    total += end - start;
  }
  return out;
}

/** AI가 준 쇼츠 목록을 실제 발화 경계/길이/겹침 제약에 맞게 보정 */
export function normalizeClips(raw, { transcript, duration, minLen, maxLen }) {
  const out = [];
  for (const r of raw) {
    const rawSegs = Array.isArray(r.segments) && r.segments.length ? r.segments : [{ start: r.start, end: r.end, role: 'body' }];
    const segments = normalizeSegments(rawSegs, { transcript, duration, maxLen });
    if (!segments.length) continue;
    const total = segments.reduce((n, s) => n + (s.end - s.start), 0);
    if (total < Math.min(minLen * 0.6, 5)) continue;
    // 다른 쇼츠와 원본 구간이 겹치면 제외
    if (out.some((o) => o.segments.some((a) => segments.some((b) => b.start < a.end && b.end > a.start)))) continue;
    out.push({
      start: round(Math.min(...segments.map((s) => s.start))),
      end: round(Math.max(...segments.map((s) => s.end))),
      segments,
      title: String(r.title || '').slice(0, 60),
      score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
      reason: String(r.reason || ''),
      summary: String(r.summary || '').slice(0, 200),
      description: String(r.description || ''),
      hashtags: (r.hashtags || []).map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 10),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

const round = (n) => Math.round(n * 100) / 100;

// ───────────────────────── 데모 모드 ─────────────────────────

export function mockTranscript(duration) {
  const out = [];
  for (let t = 0, i = 1; t < duration - 2; t += 4.2, i++) {
    out.push({ start: t, end: Math.min(duration, t + 4), text: `데모 자막 ${i}번입니다. 실제 키를 설정하면 음성이 인식됩니다.` });
  }
  return out;
}

export function mockHighlights({ duration, minLen, maxLen, count, mode }) {
  const len = Math.min(maxLen, Math.max(minLen, 30));
  const n = Math.max(1, Math.min(count, Math.floor(duration / (len + 5))));
  return Array.from({ length: n }, (_, i) => {
    const s = Math.min(duration - len, i * (duration / n));
    const e = s + len;
    // 맥락 편집 데모: 구간 끝의 핵심 장면을 후킹으로 앞에 두고 본론을 이어 붙임
    const segments = mode === 'single'
      ? [{ start: s, end: e, role: 'body' }]
      : [{ start: e - 5, end: e, role: 'hook' }, { start: s, end: s + (len - 10), role: 'body' }];
    return {
      segments, title: `데모 하이라이트\n${i + 1}번 구간`, score: 95 - i * 7,
      reason: '데모 모드: 균등 분할 구간', summary: mode === 'single' ? '' : '후킹 → 본론 (데모)', description: '데모 설명입니다.', hashtags: ['데모', '쇼츠'],
    };
  });
}
