import fs from 'node:fs';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { OPENAI_API_KEY, ANTHROPIC_API_KEY, WHISPER_MODEL, CLAUDE_MODEL, MOCK_AI } from './config.js';

export const capabilities = () => ({
  mock: MOCK_AI,
  transcription: MOCK_AI || !!OPENAI_API_KEY,
  highlights: MOCK_AI || !!ANTHROPIC_API_KEY,
  highlightsFallback: !MOCK_AI && !ANTHROPIC_API_KEY,
});

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ───────────────────────── 음성 인식 (STT) ─────────────────────────

export async function transcribeChunks(chunks, { language, onProgress }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const results = new Array(chunks.length);
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
            timestamp_granularities: ['segment'],
            ...(language && language !== 'auto' ? { language } : {}),
          });
          break;
        } catch (e) {
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
      onProgress?.(++done / chunks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));
  return results.flat().filter((s) => s.text && s.noSpeech < 0.85);
}

// ───────────────────────── 하이라이트 선정 ─────────────────────────

const TOOL = {
  name: 'submit_shorts',
  description: '롱폼 영상에서 선정한 쇼츠 후보 구간을 제출한다.',
  input_schema: {
    type: 'object',
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            start: { type: 'number', description: '시작 시간(초)' },
            end: { type: 'number', description: '종료 시간(초)' },
            title: { type: 'string', description: '쇼츠 제목. 최대 2줄, 줄당 14자 이내, 줄바꿈은 \\n' },
            score: { type: 'integer', description: '0~100 종합 점수' },
            reason: { type: 'string', description: '이 구간을 고른 이유 (한 문장)' },
            description: { type: 'string', description: 'SNS 게시물 설명 (2~3문장)' },
            hashtags: { type: 'array', items: { type: 'string' }, description: '해시태그 5~8개, # 제외' },
          },
          required: ['start', 'end', 'title', 'score', 'reason', 'description', 'hashtags'],
        },
      },
    },
    required: ['clips'],
  },
};

export async function pickHighlights({ transcript, duration, minLen, maxLen, count, title }) {
  if (!ANTHROPIC_API_KEY) return heuristicHighlights({ transcript, duration, minLen, maxLen, count });
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const body = transcript.map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join('\n');
  const prompt = `다음은 "${title}" 영상(총 ${mmss(duration)})의 타임스탬프 포함 전사본입니다. 각 줄 앞의 숫자는 해당 발화의 시작 시간(초)입니다.

이 영상에서 유튜브 쇼츠/릴스/틱톡으로 만들 가치가 가장 높은 구간 ${count}개를 골라 submit_shorts 도구로 제출하세요.

선정 기준 (점수화에 반영):
- 첫 3초 안에 시청자의 관심을 끄는 정도(후킹)
- 그 구간만 봐도 이해되는 정보/스토리 완결성
- 감정 변화, 몰입도, 웃음·놀라움·갈등 등 핵심 이벤트
- 시작과 끝이 문장 단위로 자연스럽게 끊기는지
- 길이 ${minLen}~${maxLen}초 안에 담기는 콘텐츠 밀도

규칙:
- 각 구간 길이는 ${minLen}초 이상 ${maxLen}초 이하, 구간끼리 겹치지 않게
- start/end는 전사본에 있는 발화의 경계(초)에 맞추고, 문장 중간에서 끊지 말 것
- 전사본에 없는 내용을 지어내지 말 것
- 제목은 호기심을 자극하는 한국어 문구. 최대 2줄, 줄당 14자 이내
- score 높은 순으로 정렬

전사본:
${body}`;
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
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
    start: p.start,
    end: p.end,
    title: `하이라이트 ${i + 1}`,
    score: Math.round(40 + 40 * (p.density / max)),
    reason: '발화 밀도가 높은 구간 (ANTHROPIC_API_KEY가 없어 단순 규칙으로 선정)',
    description: '',
    hashtags: [],
  }));
}

/** AI가 준 시간을 실제 발화 경계로 맞추고 길이/겹침 제약을 보정 */
export function normalizeClips(raw, { transcript, duration, minLen, maxLen }) {
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
  for (const r of raw) {
    let start = Math.max(0, Number(r.start));
    let end = Math.min(duration, Number(r.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (transcript.length) {
      start = snap(start, 'start', 3);
      end = snap(end, 'end', 3);
    }
    if (end - start > maxLen) {
      const ends = transcript.filter((s) => s.end > start + minLen && s.end <= start + maxLen);
      end = ends.length ? ends[ends.length - 1].end : start + maxLen;
    }
    if (end - start < Math.min(minLen, 5)) continue;
    if (out.some((o) => start < o.end && end > o.start)) continue;
    out.push({
      start: round(start),
      end: round(Math.min(end, duration)),
      title: String(r.title || '').slice(0, 60),
      score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
      reason: String(r.reason || ''),
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

export function mockHighlights({ duration, minLen, maxLen, count }) {
  const len = Math.min(maxLen, Math.max(minLen, 30));
  const n = Math.max(1, Math.min(count, Math.floor(duration / (len + 5))));
  return Array.from({ length: n }, (_, i) => {
    const start = Math.min(duration - len, i * (duration / n));
    return {
      start, end: start + len, title: `데모 하이라이트\n${i + 1}번 구간`, score: 95 - i * 7,
      reason: '데모 모드: 균등 분할 구간', description: '데모 설명입니다.', hashtags: ['데모', '쇼츠'],
    };
  });
}
