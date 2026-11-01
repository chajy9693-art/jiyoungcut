import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OUT_W, OUT_H, FONTS_DIR } from './config.js';
import { FRAME } from './ass.js';

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
export function buildVideoFilter({ srcW, srcH, cropX, assName, layout = 'full', bgColor = '#000000' }) {
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  const cx = Math.min(1, Math.max(0, Number(cropX ?? 0.5)));
  let filter;
  if (layout === 'framed') {
    // 정사각 크롭 → 1080x1080 → 배경색 위 가운데 배치
    if (srcW >= srcH) {
      const s = even(srcH);
      filter = `crop=${s}:${s}:${Math.round((srcW - s) * cx)}:0`;
    } else {
      const s = even(srcW);
      filter = `crop=${s}:${s}:0:${Math.round((srcH - s) / 2)}`;
    }
    const bg = '0x' + String(bgColor).replace('#', '');
    filter += `,scale=${FRAME.size}:${FRAME.size}:flags=lanczos,setsar=1,pad=${OUT_W}:${OUT_H}:0:${FRAME.top}:color=${bg}`;
  } else {
    const target = OUT_W / OUT_H;
    if (srcW / srcH >= target) {
      const cw = even(srcH * target);
      filter = `crop=${cw}:${even(srcH)}:${Math.round((srcW - cw) * cx)}:0`;
    } else {
      // 이미 세로보다 더 좁은 영상: 위아래를 잘라 9:16 맞춤
      const ch = even(srcW / target);
      filter = `crop=${even(srcW)}:${ch}:0:${Math.round((srcH - ch) / 2)}`;
    }
    filter += `,scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1`;
  }
  if (assName) {
    const fontsDir = fs.existsSync(FONTS_DIR) ? `:fontsdir='${FONTS_DIR.replace(/\\/g, '/').replace(/:/g, '\\:')}'` : '';
    filter += `,ass=${assName}${fontsDir}`;
  }
  return filter;
}

export async function renderClip({ src, segments, srcW, srcH, cropX, layout, bgColor, assFile, hasAudio, out, onProgress }) {
  const total = segments.reduce((n, s) => n + (s.end - s.start), 0);
  const workDir = path.dirname(assFile);
  const vf = buildVideoFilter({ srcW, srcH, cropX, layout, bgColor, assName: path.basename(assFile) });
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
  // 구간마다 입력을 따로 열어 빠르게 탐색한 뒤 concat으로 이어 붙인다
  for (const s of segments) args.push('-ss', s.start.toFixed(3), '-t', (s.end - s.start).toFixed(3), '-i', src);
  const parts = [];
  segments.forEach((s, i) => {
    const d = s.end - s.start;
    parts.push(`[${i}:v]setpts=PTS-STARTPTS,fps=30[v${i}]`);
    if (hasAudio) {
      const f = Math.min(0.04, d / 4).toFixed(3); // 이음새 팝 노이즈 방지용 짧은 페이드
      parts.push(`[${i}:a]aresample=44100,asetpts=PTS-STARTPTS,afade=t=in:d=${f},afade=t=out:st=${(d - Number(f)).toFixed(3)}:d=${f}[a${i}]`);
    }
  });
  const ins = segments.map((_, i) => (hasAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join('');
  parts.push(`${ins}concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}[vc]${hasAudio ? '[aout]' : ''}`);
  parts.push(`[vc]${vf}[vout]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[vout]');
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
