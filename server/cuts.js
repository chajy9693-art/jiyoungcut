import { spawn } from 'node:child_process';

/** ffmpeg silencedetect 출력(stderr) → [{start,end}] */
export function parseSilenceDetect(text, duration) {
  const out = [];
  let start = null;
  for (const line of String(text).split('\n')) {
    let m = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) { start = Math.max(0, Number(m[1])); continue; }
    m = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (m && start != null) { out.push({ start, end: Number(m[1]) }); start = null; }
  }
  if (start != null && duration > start) out.push({ start, end: duration }); // 끝까지 이어진 무음
  return out.filter((s) => s.end > s.start);
}

/** 원본 영상의 소리에서 무음 구간을 찾는다 (오디오만 디코딩하므로 빠름) */
export function detectSilences(src, duration, { noiseDb = -35, minDur = 0.35 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'info', '-nostats', '-i', src, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let buf = '';
    const keep = []; // 긴 영상에서도 메모리를 아끼려고 관련 줄만 보관
    p.stderr.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.includes('silence_')) keep.push(line);
      }
    });
    p.on('error', (e) => reject(new Error(`ffmpeg 실행 실패: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve(parseSilenceDetect(keep.join('\n'), duration)) : reject(new Error(`무음 분석 실패 (ffmpeg 종료 코드 ${code})`))));
  });
}

// 군말: 말 내용이 아닌 순수한 추임새만. "아", "그"처럼 의미 있는 말로도 쓰이는 단어는 일부러 제외한다.
const FILLERS = new Set(['음', '으음', '음음', '음음음', '어', '어어', '어어어', '으', '에', '에에', '엄', '흠', 'um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hmm', 'hm', 'mm']);
const norm = (t) => String(t).toLowerCase().replace(/[\s.,!?~…·'"`()[\]{}\-_]/g, '');
export const isFiller = (t) => FILLERS.has(norm(t));

/** 단어 단위 타임스탬프에서 군말 구간 추출 (OpenAI Whisper word timestamps) */
export function findFillers(words) {
  return (words || [])
    .filter((w) => isFiller(w.text) && w.end > w.start && w.end - w.start <= 1.5)
    .map((w) => ({ start: w.start, end: w.end, text: norm(w.text) }));
}

/** 단어 정보가 없을 때: 발화 한 줄이 통째로 군말뿐이면 그 구간 전체를 군말로 본다 */
export function fillersFromSegments(segments) {
  return (segments || [])
    .filter((s) => {
      const tokens = String(s.text).split(/\s+/).filter(Boolean);
      return tokens.length > 0 && tokens.every(isFiller) && s.end - s.start <= 2;
    })
    .map((s) => ({ start: s.start, end: s.end, text: norm(s.text) }));
}

export function buildCuts({ silences, words, segments }) {
  const fillers = words?.length ? findFillers(words) : fillersFromSegments(segments);
  return { silences: silences || [], fillers };
}

/** 데모 모드: 일정 간격으로 무음과 군말을 만들어 기능을 눈으로 확인할 수 있게 한다 */
export function mockCuts(duration) {
  const silences = []; const fillers = [];
  for (let t = 6; t + 1.4 < duration; t += 11) silences.push({ start: t, end: t + 1.4 });
  for (let t = 3; t + 0.5 < duration; t += 17) fillers.push({ start: t, end: t + 0.5, text: '음' });
  return { silences, fillers };
}
