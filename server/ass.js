import { OUT_W, OUT_H, FONT_NAME } from './config.js';
import { splitTitle } from './subtitles.js';

// ASS 색상은 &HAABBGGRR
export const SUB_TEMPLATES = {
  basic: { label: '기본 (흰색)', primary: '&H00FFFFFF', outline: '&H00000000', border: 1, outlineSize: 7, back: '&H00000000' },
  yellow: { label: '노랑 강조', primary: '&H0000F0FF', outline: '&H00000000', border: 1, outlineSize: 7, back: '&H00000000' },
  box: { label: '검정 박스', primary: '&H00FFFFFF', outline: '&HB0000000', border: 3, outlineSize: 14, back: '&H00000000' },
};

export function assTime(sec) {
  const s = Math.max(0, sec);
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

const esc = (t) => String(t).replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');

/**
 * @param subs  [{start,end,text}] — 원본 영상 기준 시간(초)
 * @param clip  {start,end,title,template,subtitleOn,titleOn}
 */
export function buildAss({ clip, subs }) {
  const tpl = SUB_TEMPLATES[clip.template] || SUB_TEMPLATES.basic;
  const dur = clip.end - clip.start;
  const lines = [];
  lines.push('[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${OUT_W}`, `PlayResY: ${OUT_H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '');
  lines.push('[V4+ Styles]');
  lines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  lines.push(`Style: Sub,${FONT_NAME},68,${tpl.primary},&H000000FF,${tpl.outline},${tpl.back},-1,0,0,0,100,100,0,0,${tpl.border},${tpl.outlineSize},0,2,70,70,430,1`);
  lines.push(`Style: Title,${FONT_NAME},84,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,8,0,8,60,60,190,1`, '');
  lines.push('[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

  if (clip.titleOn !== false) {
    const t = splitTitle(clip.title);
    if (t.length) {
      const text = t.length === 1 ? esc(t[0]) : `${esc(t[0])}\\N{\\c&H0000F0FF&}${esc(t[1])}`;
      lines.push(`Dialogue: 0,${assTime(0)},${assTime(dur)},Title,,0,0,0,,${text}`);
    }
  }
  if (clip.subtitleOn !== false) {
    for (const s of subs) {
      const a = Math.max(clip.start, s.start) - clip.start;
      const b = Math.min(clip.end, s.end) - clip.start;
      if (b - a < 0.05) continue;
      lines.push(`Dialogue: 1,${assTime(a)},${assTime(b)},Sub,,0,0,0,,${esc(s.text)}`);
    }
  }
  return lines.join('\n') + '\n';
}
