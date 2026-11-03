import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WHISPER_CLI, WHISPER_MODEL_PATH } from './config.js';
import { toWav16k } from './ffmpeg.js';

/** PATH에서 실행 파일 찾기 (절대경로면 그대로 확인) */
export function findBin(name, envPath = process.env.PATH || '') {
  if (name.includes('/')) return fs.existsSync(name) ? name : null;
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {}
  }
  // launchd/IDE처럼 PATH가 짧은 환경을 위한 Homebrew 기본 경로
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {}
  }
  return null;
}

export const localStatus = () => ({
  cli: findBin(WHISPER_CLI),
  model: fs.existsSync(WHISPER_MODEL_PATH) ? WHISPER_MODEL_PATH : null,
});
export const localAvailable = () => { const s = localStatus(); return !!(s.cli && s.model); };

/** whisper-cli -oj 결과를 앱 공통 세그먼트로 변환 (offset: 이 조각의 시작 시간, 초) */
export function parseWhisperCppJson(json, offset = 0) {
  const out = [];
  for (const t of json?.transcription || []) {
    const text = String(t.text || '').replace(/\s+/g, ' ').trim();
    // [BLANK_AUDIO], (음악) 같은 소리 설명/무음 표기는 자막에서 제외
    if (!text || /^[\[(（].*[\])）]$/.test(text) || /^[♪♬\s]+$/.test(text)) continue;
    const from = (t.offsets?.from ?? 0) / 1000;
    const to = (t.offsets?.to ?? 0) / 1000;
    if (to <= from) continue;
    out.push({ start: offset + from, end: offset + to, text, noSpeech: 0 });
  }
  return out;
}

function runWhisper(cli, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cli, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(new Error(`whisper 실행 실패: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`whisper 종료 코드 ${code}\n${err.split('\n').slice(-6).join('\n')}`))));
  });
}

/** 로컬 whisper.cpp로 조각을 순서대로 인식 (GPU를 쓰므로 순차 처리) */
export async function transcribeLocal(chunks, { language, onProgress }) {
  const { cli, model } = localStatus();
  if (!cli || !model) throw new Error('로컬 음성 인식이 설치되지 않았습니다. 터미널에서 `npm run setup:stt`를 실행하세요.');
  const all = [];
  let done = 0;
  for (const c of chunks) {
    const base = c.file.replace(/\.mp3$/, '');
    await toWav16k(c.file, `${base}.wav`);
    await runWhisper(cli, ['-m', model, '-f', `${base}.wav`, '-l', language && language !== 'auto' ? language : 'auto', '-oj', '-of', base, '-np']);
    const json = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
    all.push(...parseWhisperCppJson(json, c.offset));
    onProgress?.(++done / chunks.length);
  }
  return all;
}
