import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OUT_W, OUT_H, FONTS_DIR } from './config.js';
import { cropBox } from './layout.js';

export function run(cmd, args, { cwd, onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      if (onStdoutLine) {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          onStdoutLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      } else out += d;
    });
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-8000);
    });
    p.on('error', (e) => reject(new Error(`${cmd} 실행 실패: ${e.message} (ffmpeg가 설치되어 있는지 확인하세요)`)));
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} 종료 코드 ${code}\n${err.split('\n').slice(-12).join('\n')}`));
    });
  });
}

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('영상 스트림을 찾을 수 없습니다. 동영상 파일이 맞는지 확인하세요.');
  let width = v.width;
  let height = v.height;
  const rot = Number(v.tags?.rotate || v.side_data_list?.find((s) => s.rotation)?.rotation || 0);
  if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [width, height] = [height, width];
  const duration = Number(j.format?.duration || v.duration || 0);
  return { duration, width, height, hasAudio: !!a, fileSize: Number(j.format?.size || 0) };
}

export async function makeThumbnail(src, dest, at) {
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', src, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', dest]);
}

/** 브라우저에서 재생 가능한 가벼운 미리보기용 프록시 */
export async function makeProxy(src, dest) {
  await run('ffmpeg', [
    '-y', '-v', 'error', '-i', src,
    '-vf', "scale='min(960,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', dest,
  ]);
}

/** Whisper 업로드 한도(25MB)를 피하려고 저비트레이트 mono mp3 조각으로 분할 */
export async function extractAudioChunks(src, dir, chunkSec = 600) {
  fs.mkdirSync(dir, { recursive: true });
  await run('ffmpeg', [
    '-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
    '-f', 'segment', '-segment_time', String(chunkSec), '-reset_timestamps', '1',
    path.join(dir, 'chunk_%03d.mp3'),
  ]);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort().map((f) => path.join(dir, f));
  const chunks = [];
  let offset = 0;
  for (const f of files) {
    const { duration } = await probe(f).catch(() => ({ duration: chunkSec }));
    chunks.push({ file: f, offset, duration });
    offset += duration;
  }
  return chunks;
}

/**
 * 컷 → 9:16 크롭 → 1080x1920 → 자막/제목(ASS) 번인 → MP4
 * cropX: 0(왼쪽)~1(오른쪽) 크롭 창 위치
 */
/**
 * 원본을 프레임(fw x fh)에 cover로 채워 자르고(zoom/cropX/cropY) 1080x1920 캔버스의 (x0,y0)에 배치한다.
 * 프레임이 캔버스 전체면 패딩 없이 전체화면, 아니면 bg 색 위에 올린다.
 */
export function buildVideoFilter({ srcW, srcH, cropX, cropY, zoom, frame, assName }) {
  const { fw, fh, x0, y0, bg } = frame;
  const c = cropBox({ srcW, srcH, fw, fh, zoom, cropX, cropY });
  let filter = `crop=${c.cw}:${c.ch}:${c.x}:${c.y},scale=${fw}:${fh}:flags=lanczos,setsar=1`;
  if (fw !== OUT_W || fh !== OUT_H) filter += `,pad=${OUT_W}:${OUT_H}:${x0}:${y0}:color=0x${String(bg).replace('#', '')}`;
  if (assName) {
    const fontsDir = fs.existsSync(FONTS_DIR) ? `:fontsdir='${FONTS_DIR.replace(/\\/g, '/').replace(/:/g, '\\:')}'` : '';
    filter += `,ass=${assName}${fontsDir}`;
  }
  return filter;
}

/**
 * 이어 붙일 구간 목록(재생 순서)으로 ffmpeg 입력/필터 그래프를 만든다.
 * eff: [{start,end,src}] — src가 같은 항목들은 같은 원본 구간에서 나온 "남길 조각"이며,
 * 그 구간은 입력을 한 번만 열고 select 필터로 제거할 부분(무음·군말)을 걷어낸다.
 */
export function buildRenderGraph({ eff, hasAudio, vf }) {
  const groups = [];
  for (const e of eff) {
    const g = groups[groups.length - 1];
    if (g && g.src === e.src) g.keeps.push(e); else groups.push({ src: e.src, keeps: [e] });
  }
  const inputs = [];
  const parts = [];
  groups.forEach((g, i) => {
    const s0 = g.keeps[0].start; const s1 = g.keeps[g.keeps.length - 1].end;
    inputs.push('-ss', s0.toFixed(3), '-t', (s1 - s0).toFixed(3), '-i', '__SRC__');
    const dur = g.keeps.reduce((n, k) => n + k.end - k.start, 0);
    const f = Math.min(0.04, dur / 4).toFixed(3); // 이음새 팝 노이즈 방지용 짧은 페이드
    if (g.keeps.length === 1) {
      parts.push(`[${i}:v]setpts=PTS-STARTPTS,fps=30[v${i}]`);
      if (hasAudio) parts.push(`[${i}:a]aresample=44100,asetpts=PTS-STARTPTS,afade=t=in:d=${f},afade=t=out:st=${(dur - Number(f)).toFixed(3)}:d=${f}[a${i}]`);
    } else {
      // 입력 시작(s0)을 0초로 본 상대 시간으로 남길 범위를 고른다
      const expr = g.keeps.map((k) => `gte(t,${(k.start - s0).toFixed(3)})*lt(t,${(k.end - s0).toFixed(3)})`).join('+');
      parts.push(`[${i}:v]fps=30,select='${expr}',setpts=N/(30*TB)[v${i}]`);
      if (hasAudio) parts.push(`[${i}:a]aresample=44100,aselect='${expr}',asetpts=N/SR/TB,afade=t=in:d=${f},afade=t=out:st=${(dur - Number(f)).toFixed(3)}:d=${f}[a${i}]`);
    }
  });
  const ins = groups.map((_, i) => (hasAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join('');
  parts.push(`${ins}concat=n=${groups.length}:v=1:a=${hasAudio ? 1 : 0}[vc]${hasAudio ? '[aout]' : ''}`);
  parts.push(`[vc]${vf}[vout]`);
  return { inputs, graph: parts.join(';'), total: eff.reduce((n, e) => n + e.end - e.start, 0) };
}

export async function renderClip({ src, eff, srcW, srcH, cropX, cropY, zoom, frame, assFile, hasAudio, out, onProgress }) {
  const workDir = path.dirname(assFile);
  const vf = buildVideoFilter({ srcW, srcH, cropX, cropY, zoom, frame, assName: path.basename(assFile) });
  const { inputs, graph, total } = buildRenderGraph({ eff, hasAudio, vf });
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', ...inputs.map((a) => (a === '__SRC__' ? src : a))];
  args.push('-filter_complex', graph, '-map', '[vout]');
  if (hasAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', out);
  await run('ffmpeg', args, {
    cwd: workDir,
    onStdoutLine: (line) => {
      const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m && onProgress) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / total));
    },
  });
}

/** whisper.cpp 입력용 16kHz mono WAV */
export async function toWav16k(src, dest) {
  await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dest]);
}
