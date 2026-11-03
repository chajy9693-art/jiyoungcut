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

// ───────── 1단계: 영상 전체 맥락 → 소주제 ─────────

const TOPIC_TOOL = {
  name: 'submit_topics',
  description: '영상 전체를 시간 순서대로 겹치지 않는 소주제 구간으로 나눈 결과를 제출한다.',
  input_schema: {
    type: 'object',
    properties: {
      topics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '소주제 한 문장. 하나의 명확한 주제/주장/질문만 담을 것 (예: "노션 독서 노트 DB를 만드는 순서")' },
            summary: { type: 'string', description: '이 소주제에서 다루는 내용 요약 (1~2문장)' },
            start: { type: 'number', description: '시작(초)' },
            end: { type: 'number', description: '종료(초)' },
            score: { type: 'integer', description: '쇼츠로 만들 가치 0~100 (인사·잡담·광고성 구간은 낮게)' },
          },
          required: ['title', 'summary', 'start', 'end', 'score'],
        },
      },
    },
    required: ['topics'],
  },
};

const fmtLines = (list) => list.map((s) => `[${s.start.toFixed(1)}~${s.end.toFixed(1)}] ${s.text}`).join('\n');

export async function analyzeTopics({ transcript, duration, title }) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const prompt = `다음은 "${title}" 영상(총 ${mmss(duration)})의 타임스탬프 포함 전사본입니다. 각 줄 앞의 [시작~끝]은 발화 구간(초)입니다.

먼저 영상 전체의 맥락과 흐름을 파악한 뒤, 영상을 시간 순서대로 서로 겹치지 않는 "소주제" 구간으로 나누어 submit_topics 도구로 제출하세요.

규칙:
- 소주제 하나에는 하나의 명확한 주제(주장·질문·작업 단계)만 담으세요. 서로 다른 이야기를 한 소주제에 섞지 마세요.
- title은 구체적인 한 문장으로 쓰세요. "소개", "기타" 같은 모호한 제목은 피하세요.
- start/end는 전사본의 발화 경계(초)에 맞추고, 소주제 구간끼리 겹치지 않게 하세요. 영상 처음부터 끝까지 이어지는 순서대로 나열하세요.
- 인사·잡담·광고성 구간도 별도 소주제로 두되 score를 낮게 매기세요.
- score는 그 소주제가 독립된 쇼츠로 만들어졌을 때의 가치입니다(핵심 정보, 흥미, 완결성).
- 전사본에 없는 내용을 지어내지 마세요.

전사본:
${fmtLines(transcript)}`;
  const res = await client.messages.create({
    model: CLAUDE_MODEL, max_tokens: 6000, tools: [TOPIC_TOOL], tool_choice: { type: 'tool', name: TOPIC_TOOL.name },
    messages: [{ role: 'user', content: prompt }],
  });
  const tu = res.content.find((b) => b.type === 'tool_use');
  if (!tu) throw new Error('AI가 소주제를 반환하지 않았습니다.');
  return tu.input.topics || [];
}

/** AI가 나눈 소주제를 발화 경계에 맞추고 겹침·너무 짧은 구간을 정리 */
export function normalizeTopics(raw, { transcript, duration }) {
  const snap = (t, key) => {
    let best = t; let bd = 3 + 1e-6;
    for (const s of transcript) { const d = Math.abs(s[key] - t); if (d < bd) { bd = d; best = s[key]; } }
    return best;
  };
  const list = [];
  for (const r of [...raw].sort((a, b) => Number(a.start) - Number(b.start))) {
    let start = Math.max(0, Number(r.start)); let end = Math.min(duration, Number(r.end));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (transcript.length) { start = snap(start, 'start'); end = snap(end, 'end'); }
    const prev = list[list.length - 1];
    if (prev) start = Math.max(start, prev.end); // 앞 소주제와 겹치지 않게
    if (end - start < 8) continue;
    list.push({
      start: round(start), end: round(end),
      title: String(r.title || '').trim().slice(0, 80),
      summary: String(r.summary || '').trim().slice(0, 240),
      score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
    });
  }
  return list.filter((t) => t.title).map((t, i) => ({ id: i + 1, ...t }));
}

/** 쇼츠로 만들 소주제 고르기: 점수가 높고 쇼츠 하나를 만들 만큼 긴 것부터 count개 (시간 순서로 반환) */
export function pickTopics(topics, { count, minLen }) {
  const minDur = Math.max(10, minLen * 0.5);
  return topics.filter((t) => t.end - t.start >= minDur).sort((a, b) => b.score - a.score).slice(0, count).sort((a, b) => a.start - b.start);
}

// ───────── 2단계: 소주제별 컷편집 + 편집 의견 ─────────

const TOOL = {
  name: 'submit_shorts',
  description: '소주제별로 구성한 쇼츠들을 제출한다. 각 쇼츠는 하나의 소주제 안에서 고른 구간(segments)을 재생 순서대로 이어 붙인 것이다.',
  input_schema: {
    type: 'object',
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            topic_id: { type: 'integer', description: '이 쇼츠가 다루는 소주제 번호 (소주제 하나당 쇼츠 하나)' },
            segments: {
              type: 'array',
              description: '재생 순서대로 이어 붙일 원본 구간들 (모두 해당 소주제 시간 범위 안)',
              items: {
                type: 'object',
                properties: {
                  start: { type: 'number', description: '원본 영상 기준 시작(초)' },
                  end: { type: 'number', description: '원본 영상 기준 종료(초)' },
                  role: { type: 'string', enum: ['hook', 'body', 'ending'], description: 'hook=시작 후킹, body=본론, ending=마무리' },
                  note: { type: 'string', description: '이 구간을 고르고 이 자리에 둔 이유 (한 줄, 30자 이내)' },
                },
                required: ['start', 'end', 'role', 'note'],
              },
            },
            title: { type: 'string', description: '쇼츠 제목. 최대 2줄, 줄당 14자 이내, 줄바꿈은 \\n' },
            score: { type: 'integer', description: '0~100 종합 점수' },
            reason: { type: 'string', description: '이 소주제를 쇼츠로 고른 이유 (한 문장)' },
            summary: { type: 'string', description: '쇼츠의 흐름 요약 (예: 결론 먼저 → 문제 상황 → 해결 방법)' },
            rationale: { type: 'string', description: '왜 이렇게 컷편집했는지 (2~4문장). 무엇을 후킹으로 앞에 뒀는지, 무엇을 덜어냈는지, 어떤 순서로 이었는지를 구체적으로' },
            feedback: { type: 'string', description: '편집자로서의 솔직한 의견과 피드백 (2~4문장). 잘된 점 1가지와 아쉬운 점·개선 제안 1~2가지' },
            description: { type: 'string', description: 'SNS 게시물 설명 (2~3문장)' },
            hashtags: { type: 'array', items: { type: 'string' }, description: '해시태그 5~8개, # 제외' },
          },
          required: ['topic_id', 'segments', 'title', 'score', 'reason', 'summary', 'rationale', 'feedback', 'description', 'hashtags'],
        },
      },
    },
    required: ['clips'],
  },
};

const RULES_CONTEXT = (minLen, maxLen) => `이 서비스의 쇼츠는 "구간 하나를 그대로 자른 것"이 아니라, 소주제의 맥락을 이해해 여러 구간을 골라 재생 순서대로 이어 붙인 편집본입니다. 시청자가 끝까지 보게 만드는 구성을 설계하세요.

구성 원칙:
1. 후킹: 그 소주제에서 가장 흥미로운 한마디(결론, 핵심 주장, 반전, 강한 감정)를 3~8초 길이의 hook 구간으로 맨 앞에 둡니다. 소주제 안에서 더 뒤에 나오는 장면이어도 앞으로 가져올 수 있습니다. 후킹으로 쓴 구간은 본론에서 중복해서 쓰지 마세요.
2. 본론(body): 후킹을 이해시키는 맥락과 핵심 내용을 원본의 시간 순서대로 이어 붙입니다. 잡담, 반복, 말 더듬기, 주제에서 벗어난 곁가지, 긴 침묵·공백 구간은 건너뛰세요.
3. 마무리(ending): 가능하면 결론/한 줄 정리로 끝나는 구간을 마지막에 둡니다.
4. 구간은 쇼츠당 최대 5개. 각 구간은 문장 경계에서 시작하고 끝나야 하며, 이어 붙였을 때 말이 자연스럽게 이어져야 합니다(문장 중간에서 끊지 말 것).
5. 구간끼리 겹치면 안 됩니다.
6. 구간 길이의 합계는 ${minLen}초 이상 ${maxLen}초 이하여야 합니다. 소주제가 짧아 합계가 부족하면 있는 만큼만 쓰세요.
7. 후킹이 필요 없을 만큼 시작이 강하면 hook 없이 body로 시작해도 됩니다.`;

const RULES_SINGLE = (minLen, maxLen) => `각 쇼츠는 해당 소주제 안의 연속된 구간 하나(segments에 항목 1개, role은 body)로 구성하세요. 길이는 ${minLen}초 이상 ${maxLen}초 이하로 하세요.`;

export async function composeShorts({ transcript, topics, minLen, maxLen, title, mode = 'context' }) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const blocks = topics.map((t) => {
    const lines = transcript.filter((s) => s.end > t.start && s.start < t.end);
    return `## 소주제 ${t.id}: ${t.title}  (시간 범위 ${t.start.toFixed(1)}~${t.end.toFixed(1)}초)\n요약: ${t.summary}\n${fmtLines(lines)}`;
  }).join('\n\n');
  const prompt = `다음은 "${title}" 영상에서 이미 구분해 둔 소주제 ${topics.length}개와 소주제별 전사본입니다.

소주제마다 정확히 1개의 쇼츠를 만들어 submit_shorts 도구로 제출하세요. 쇼츠 1개 = 소주제 1개이며 topic_id로 연결합니다.
- 한 쇼츠의 모든 구간(후킹 포함)은 반드시 그 소주제의 시간 범위 안에서만 고르세요. 다른 소주제의 내용을 섞지 마세요.
- 그 쇼츠가 소주제 하나를 한 줄기로 분명하게 전달해야 합니다(보고 나면 "이 쇼츠는 ○○에 대한 것"이라고 한 문장으로 말할 수 있어야 함).

${mode === 'single' ? RULES_SINGLE(minLen, maxLen) : RULES_CONTEXT(minLen, maxLen)}

각 쇼츠에 쓸 글:
- rationale(왜 이렇게 컷편집했는지): 무엇을 후킹으로 앞에 뒀는지, 무엇을 덜어냈는지, 구간을 어떤 순서로 이었는지, 소주제를 어떻게 한 줄기로 만들었는지를 시간·내용을 들어 구체적으로 2~4문장.
- feedback(편집자 의견·피드백): 잘된 점 1가지와 아쉬운 점/개선 제안 1~2가지(예: 후킹 보강, 길이 조정, 더 넣으면 좋을 장면, 자막으로 강조할 부분). 과장하지 말고 솔직하게 2~4문장.
- segments[].note: 그 구간을 고르고 그 자리에 둔 이유를 한 줄로.

공통 규칙:
- start/end는 전사본에 있는 발화의 경계(초)에 맞출 것
- 전사본에 없는 내용을 지어내지 말 것
- 제목은 호기심을 자극하는 한국어 문구. 최대 2줄, 줄당 14자 이내
- score 높은 순으로 정렬

${blocks}`;
  const res = await client.messages.create({
    model: CLAUDE_MODEL, max_tokens: 12000, tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: prompt }],
  });
  const tu = res.content.find((b) => b.type === 'tool_use');
  if (!tu) throw new Error('AI가 쇼츠 구성을 반환하지 않았습니다.');
  return tu.input.clips || [];
}

/** 소주제 분석 → 소주제별 쇼츠 구성. 반환: { topics(전체), clips(원시 AI 결과) } */
export async function pickHighlights({ transcript, duration, minLen, maxLen, count, title, mode = 'context', onStage }) {
  if (!ANTHROPIC_API_KEY) return { topics: [], chosen: null, clips: heuristicHighlights({ transcript, duration, minLen, maxLen, count }) };
  onStage?.('topics');
  let topics = normalizeTopics(await analyzeTopics({ transcript, duration, title }), { transcript, duration });
  if (!topics.length) topics = [{ id: 1, title: String(title).slice(0, 80), summary: '', start: 0, end: duration, score: 50 }]; // 나눌 수 없으면 영상 전체를 한 소주제로
  const picked = pickTopics(topics, { count, minLen });
  const chosen = picked.length ? picked : topics.slice(0, count);
  onStage?.('compose', { topics: topics.length, shorts: chosen.length });
  const clips = await composeShorts({ transcript, topics: chosen, minLen, maxLen, title, mode });
  return { topics, chosen, clips };
}

// ───────── 편집 후 피드백 다시 받기 ─────────

const NOTE_TOOL = {
  name: 'submit_note',
  description: '현재 편집 상태에 대한 편집 설명과 피드백을 제출한다.',
  input_schema: {
    type: 'object',
    properties: {
      rationale: { type: 'string', description: '이 편집이 어떤 구성인지, 왜 이렇게 컷편집된 것으로 보이는지 (2~4문장)' },
      feedback: { type: 'string', description: '편집자로서의 의견·피드백: 잘된 점 1가지와 아쉬운 점·개선 제안 1~2가지 (2~4문장)' },
    },
    required: ['rationale', 'feedback'],
  },
};

/** 사용자가 직접 고친 현재 편집 상태를 보고 설명/피드백을 다시 쓴다 */
export async function writeEditNote({ videoTitle, clip, parts }) {
  if (MOCK_AI) {
    return { rationale: `(데모) ${parts.length}개 구간을 이어 붙인 구성입니다. 첫 구간을 후킹으로 두고 이어서 본론을 배치했습니다.`, feedback: '(데모) 잘된 점: 구성이 간결합니다. 아쉬운 점: 마무리 한 줄 정리가 있으면 완결감이 더 좋아집니다.' };
  }
  if (!ANTHROPIC_API_KEY) throw new Error('편집 피드백에는 ANTHROPIC_API_KEY가 필요합니다.');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const body = parts.map((p, i) => `${i + 1}. [${p.role}] 원본 ${p.start.toFixed(1)}~${p.end.toFixed(1)}초 (${(p.end - p.start).toFixed(1)}초)${p.note ? ` — ${p.note}` : ''}\n   자막: ${p.text || '(없음)'}`).join('\n');
  const prompt = `영상 "${videoTitle}"에서 만든 쇼츠 "${String(clip.title).replace(/\n/g, ' ')}"의 현재 편집 상태입니다. 소주제: ${clip.topic || '(지정 안 됨)'}.
구간은 위에서 아래 순서로 이어 붙여 재생됩니다. ${clip.removed ? `무음·군말 제거로 ${clip.removed.toFixed(1)}초를 줄였습니다.` : ''}

${body}

이 편집을 보고 submit_note 도구로 (1) 왜 이렇게 컷편집된 구성인지 설명하고 (2) 편집자로서 솔직한 의견과 피드백(잘된 점 1가지, 아쉬운 점·개선 제안 1~2가지)을 쓰세요. 위에 적힌 내용 밖의 사실을 지어내지 마세요.`;
  const res = await client.messages.create({ model: CLAUDE_MODEL, max_tokens: 1500, tools: [NOTE_TOOL], tool_choice: { type: 'tool', name: NOTE_TOOL.name }, messages: [{ role: 'user', content: prompt }] });
  const tu = res.content.find((b) => b.type === 'tool_use');
  if (!tu) throw new Error('AI가 피드백을 반환하지 않았습니다.');
  return { rationale: String(tu.input.rationale || '').slice(0, 1200), feedback: String(tu.input.feedback || '').slice(0, 1200) };
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
    rationale: 'ANTHROPIC_API_KEY가 없어 AI가 영상 맥락을 분석하지 못했습니다. 말이 가장 많이 몰린 구간을 규칙으로 골라 그대로 잘랐습니다.',
    feedback: '소주제 분석과 후킹 배치, 군더더기 제거 같은 맥락 편집은 Claude 키를 설정하면 적용됩니다. 지금 구간은 직접 확인하고 시작·끝을 다듬어 주세요.',
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
    out.push({ start: round(start), end: round(end), role: ['hook', 'body', 'ending'].includes(r.role) ? r.role : 'body', note: String(r.note || '').trim().slice(0, 80) });
    total += end - start;
  }
  return out;
}

/**
 * AI가 준 쇼츠 목록을 실제 발화 경계/길이/겹침 제약에 맞게 보정.
 * topics(쇼츠로 만들 소주제)가 주어지면: 쇼츠의 모든 구간을 그 소주제 시간 범위 안으로 제한하고, 소주제 하나에 쇼츠는 하나만 허용한다.
 */
export function normalizeClips(raw, { transcript, duration, minLen, maxLen, topics = null }) {
  const out = [];
  const usedTopics = new Set();
  const byScore = [...raw].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  for (const r of byScore) {
    let rawSegs = Array.isArray(r.segments) && r.segments.length ? r.segments : [{ start: r.start, end: r.end, role: 'body' }];
    let topic = null;
    if (topics) {
      topic = topics.find((t) => t.id === Number(r.topic_id));
      if (!topic) continue; // 소주제를 알 수 없는 쇼츠는 소주제별 구성 원칙에 맞지 않아 제외
      if (usedTopics.has(topic.id)) continue;
      // 다른 소주제 내용이 섞이지 않게 소주제 범위 밖은 잘라낸다
      rawSegs = rawSegs.map((g) => ({ ...g, start: Math.max(Number(g.start), topic.start), end: Math.min(Number(g.end), topic.end) })).filter((g) => g.end - g.start >= 1);
    }
    const segments = normalizeSegments(rawSegs, { transcript, duration, maxLen });
    if (!segments.length) continue;
    const total = segments.reduce((n, g) => n + (g.end - g.start), 0);
    if (total < Math.min(minLen * 0.6, 5)) continue;
    // 다른 쇼츠와 원본 구간이 겹치면 제외
    if (out.some((o) => o.segments.some((a) => segments.some((b) => b.start < a.end && b.end > a.start)))) continue;
    if (topic) usedTopics.add(topic.id);
    out.push({
      start: round(Math.min(...segments.map((g) => g.start))),
      end: round(Math.max(...segments.map((g) => g.end))),
      segments,
      topicId: topic?.id ?? null,
      topic: topic?.title ?? '',
      topicRange: topic ? [topic.start, topic.end] : null,
      title: String(r.title || '').slice(0, 60),
      score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
      reason: String(r.reason || ''),
      summary: String(r.summary || '').slice(0, 200),
      rationale: String(r.rationale || '').trim().slice(0, 1200),
      feedback: String(r.feedback || '').trim().slice(0, 1200),
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

export function mockTopics(duration, count) {
  const n = Math.max(1, Math.min(count, Math.floor(duration / 25)));
  const size = duration / n;
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, start: Math.round(i * size * 10) / 10, end: Math.round((i + 1) * size * 10) / 10,
    title: `소주제 ${i + 1}: 데모 주제`, summary: '데모 모드의 가짜 소주제입니다.', score: 95 - i * 7,
  }));
}

export function mockHighlights({ topics, minLen, maxLen, mode }) {
  return topics.map((t, i) => {
    const len = Math.min(maxLen, Math.max(minLen, 30), t.end - t.start - 1);
    const s = t.start; const e = s + len;
    // 맥락 편집 데모: 소주제 끝부분의 핵심 장면을 후킹으로 앞에 두고 본론을 이어 붙임
    const segments = mode === 'single'
      ? [{ start: s, end: e, role: 'body', note: '소주제의 시작부터 이어서' }]
      : [{ start: e - 5, end: e, role: 'hook', note: '결론에 해당하는 장면을 먼저 보여줌' }, { start: s, end: s + (len - 10), role: 'body', note: '배경 설명부터 차례대로' }];
    return {
      topic_id: t.id, segments, title: `데모 하이라이트\n${i + 1}번 구간`, score: 95 - i * 7,
      reason: '데모 모드: 균등 분할 소주제', summary: mode === 'single' ? '' : '후킹 → 본론 (데모)', description: '데모 설명입니다.', hashtags: ['데모', '쇼츠'],
      rationale: `(데모) 소주제 "${t.title}" 안에서만 구간을 골랐습니다. 소주제의 마지막 5초를 후킹으로 앞에 두고, 이어서 처음부터 본론을 배치했습니다.`,
      feedback: '(데모) 잘된 점: 결론을 먼저 보여줘 이탈을 줄입니다. 아쉬운 점: 마무리 한 줄 정리가 없어 끝이 조금 갑작스럽습니다.',
    };
  });
}
