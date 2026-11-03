import { OUT_W, OUT_H } from './config.js';

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export const FRAME_LIMITS = { w: [0.3, 1], h: [0.2, 1], zoom: [1, 3] };

/** 레이아웃별 영상 프레임 기본값 (템플릿이 값을 따로 저장하지 않았을 때 / 레이아웃을 바꿀 때 쓰는 값) */
export const FRAME_DEFAULTS = {
  full: { w: 1, h: 1, cy: 0.5 },
  framed: { w: 1, h: 1080 / 1920, cy: 0.5 },
};

/**
 * 템플릿이 정하는 기본 영상 프레임 (캔버스 대비 비율, cy는 프레임 중심의 세로 위치).
 * 프레임 밖 영역은 템플릿의 배경색으로 채운다.
 */
export function defaultFrame(tpl) {
  const d = FRAME_DEFAULTS[tpl.layout === 'framed' ? 'framed' : 'full'];
  return { w: tpl.frameW ?? d.w, h: tpl.frameH ?? d.h, cy: tpl.frameCy ?? d.cy, bg: tpl.bgColor ?? '#000000' };
}

/** 쇼츠별 설정(clip.frame)을 기본값 위에 덮어 영상 프레임을 결정 */
export function resolveFrame(tpl, clip = {}) {
  const d = defaultFrame(tpl);
  const f = clip.frame || {};
  const w = clamp(f.w ?? d.w, ...FRAME_LIMITS.w, d.w);
  const h = clamp(f.h ?? d.h, ...FRAME_LIMITS.h, d.h);
  const cy = clamp(f.cy ?? d.cy, h / 2, 1 - h / 2, d.cy);
  return { w, h, cy, bg: d.bg };
}

/** 프레임 → 출력 캔버스(1080x1920)의 픽셀 사각형 (짝수로 맞춤) */
export function framePixels(fr) {
  const fw = Math.min(OUT_W, even(fr.w * OUT_W));
  const fh = Math.min(OUT_H, even(fr.h * OUT_H));
  const x0 = Math.floor((OUT_W - fw) / 4) * 2; // 가운데, 짧은 쪽은 짝수 좌표
  const y0 = Math.max(0, Math.min(OUT_H - fh, Math.round((fr.cy * OUT_H - fh / 2) / 2) * 2));
  return { fw, fh, x0, y0 };
}

/** 프레임을 채우도록(cover) 원본에서 잘라낼 영역. zoom>1이면 더 좁게 잘라 확대 */
export function cropBox({ srcW, srcH, fw, fh, zoom = 1, cropX = 0.5, cropY = 0.5 }) {
  const a = fw / fh;
  let cw; let ch;
  if (srcW / srcH >= a) { ch = srcH; cw = srcH * a; } else { cw = srcW; ch = srcW / a; }
  const z = clamp(zoom, ...FRAME_LIMITS.zoom, 1);
  cw = even(Math.min(srcW, cw / z));
  ch = even(Math.min(srcH, ch / z));
  return {
    cw, ch,
    x: Math.round((srcW - cw) * clamp(cropX, 0, 1, 0.5)),
    y: Math.round((srcH - ch) * clamp(cropY, 0, 1, 0.5)),
  };
}

export function sanitizeFrame(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  const r3 = (n) => Math.round(n * 1000) / 1000;
  if (input.w != null) out.w = r3(clamp(input.w, ...FRAME_LIMITS.w, 1));
  if (input.h != null) out.h = r3(clamp(input.h, ...FRAME_LIMITS.h, 1));
  if (input.cy != null) out.cy = r3(clamp(input.cy, 0, 1, 0.5));
  return Object.keys(out).length ? out : null;
}
