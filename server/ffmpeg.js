import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OUT_W, OUT_H, FONTS_DIR } from './config.js';

function run(cmd, args, { cwd, onStdoutLine } = {}) {
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
export function buildVideoFilter({ srcW, srcH, cropX, assName }) {
  const target = OUT_W / OUT_H;
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  let filter;
  const cx = Math.min(1, Math.max(0, Number(cropX ?? 0.5)));
  if (srcW / srcH >= target) {
    const cw = even(srcH * target);
    const x = Math.round((srcW - cw) * cx);
    filter = `crop=${cw}:${even(srcH)}:${x}:0`;
  } else {
    // 이미 세로보다 더 좁은 영상: 위아래를 잘라 9:16 맞춤
    const ch = even(srcW / target);
    const y = Math.round((srcH - ch) / 2);
    filter = `crop=${even(srcW)}:${ch}:0:${y}`;
  }
  filter += `,scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1`;
  if (assName) {
    const fontsDir = fs.existsSync(FONTS_DIR) ? `:fontsdir='${FONTS_DIR.replace(/\\/g, '/').replace(/:/g, '\\:')}'` : '';
    filter += `,ass=${assName}${fontsDir}`;
  }
  return filter;
}

export async function renderClip({ src, start, end, srcW, srcH, cropX, assFile, hasAudio, out, onProgress }) {
  const dur = end - start;
  const workDir = path.dirname(assFile);
  const vf = buildVideoFilter({ srcW, srcH, cropX, assName: path.basename(assFile) });
  const args = [
    '-y', '-v', 'error', '-progress', 'pipe:1', '-nostats',
    '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', src,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
  ];
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '44100');
  else args.push('-an');
  args.push('-movflags', '+faststart', out);
  await run('ffmpeg', args, {
    cwd: workDir,
    onStdoutLine: (line) => {
      const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m && onProgress) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / dur));
    },
  });
}
