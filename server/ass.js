import { OUT_W, OUT_H, FONT_NAME } from './config.js';
import { splitTitle } from './subtitles.js';

// 자막 스타일. ASS 색상은 &HAABBGGRR
export const SUB_TEMPLATES = {
  basic: { label: '기본 (흰색)', primary: '&H00FFFFFF', outline: '&H00000000', border: 1, outlineSize: 7 },
  yellow: { label: '노랑 강조', primary: '&H0000F0FF', outline: '&H00000000', border: 1, outlineSize: 7 },
  box: { label: '검정 박스', primary: '&H00FFFFFF', outline: '&HB0000000', border: 3, outlineSize: 14 },
};

// framed 레이아웃: 위아래 바 사이에 1080x1080 영상
export const FRAME = { top: 420, size: 1080 };

export function hexToAss(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? `&H00${m[3]}${m[2]}${m[1]}`.toUpperCase() : '&H00FFFFFF';
}

export function assTime(sec) {
  const s = Math.max(0, sec);
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** 클립의 구간 목록 (구버전 데이터는 start/end 하나로 대체) */
export const segmentsOf = (clip) => (clip.segments?.length ? clip.segments : [{ start: clip.start, end: clip.end }]);
export const totalDuration = (segs) => segs.reduce((n, s) => n + (s.end - s.start), 0);

/** 원본 시간 기준 자막을 이어 붙인 결과물의 타임라인(0초 시작)으로 변환 */
export function timelineSubs(segs, subs) {
  const out = [];
  let offset = 0;
  for (const seg of segs) {
    for (const s of subs) {
      const a = Math.max(seg.start, s.start);
      const b = Math.min(seg.end, s.end);
      if (b - a >= 0.05) out.push({ start: offset + (a - seg.start), end: offset + (b - seg.start), text: s.text });
    }
    offset += seg.end - seg.start;
  }
  return out;
}

const esc = (t) => String(t).replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');

/**
 * @param subs  [{start,end,text}] — 원본 영상 기준 시간(초)
 * @param clip  {start,end,title,subtitleOn,titleOn}
 * @param tpl   templates.js 의 템플릿
 */
export function buildAss({ clip, subs, tpl }) {
  const sub = SUB_TEMPLATES[tpl.subStyle] || SUB_TEMPLATES.basic;
  const framed = tpl.layout === 'framed';
  const segs = segmentsOf(clip);
  const dur = totalDuration(segs);
  const lines = [];
  lines.push('[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${OUT_W}`, `PlayResY: ${OUT_H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '');
  lines.push('[V4+ Styles]');
  lines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  lines.push(`Style: Sub,${FONT_NAME},68,${sub.primary},&H000000FF,${sub.outline},&H00000000,-1,0,0,0,100,100,0,0,${sub.border},${sub.outlineSize},0,2,70,70,${framed ? 450 : 430},1`);
  lines.push(`Style: Title,${FONT_NAME},${tpl.titleSize},${hexToAss(tpl.titleColor1)},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,8,0,8,60,60,190,1`);
  lines.push(`Style: Account,${FONT_NAME},${tpl.accountSize},${hexToAss(tpl.accountColor)},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${framed ? 0 : 5},0,5,60,60,0,1`, '');
  lines.push('[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

  if (clip.titleOn !== false) {
    const t = splitTitle(clip.title);
    if (t.length) {
      const text = t.length === 1 ? esc(t[0]) : `${esc(t[0])}\\N{\\c${hexToAss(tpl.titleColor2)}&}${esc(t[1])}`;
      const pos = framed ? `{\\an5\\pos(${OUT_W / 2},${FRAME.top / 2})}` : '';
      lines.push(`Dialogue: 0,${assTime(0)},${assTime(dur)},Title,,0,0,0,,${pos}${text}`);
    }
  }
  if (tpl.account) {
    const y = framed ? FRAME.top + FRAME.size + FRAME.top / 2 : OUT_H - 120;
    lines.push(`Dialogue: 0,${assTime(0)},${assTime(dur)},Account,,0,0,0,,{\\an5\\pos(${OUT_W / 2},${y})}${esc(tpl.account)}`);
  }
  if (clip.subtitleOn !== false) {
    for (const s of timelineSubs(segs, subs)) {
      lines.push(`Dialogue: 1,${assTime(s.start)},${assTime(s.end)},Sub,,0,0,0,,${esc(s.text)}`);
    }
  }
  return lines.join('\n') + '\n';
}
