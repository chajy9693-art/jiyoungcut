import { OUT_W, OUT_H } from './config.js';
import { fontById } from './fonts.js';
import { splitTitle } from './subtitles.js';

// framed 레이아웃: 위아래 바 사이에 1080x1080 영상
export const FRAME = { top: 420, size: 1080 };

/** #rrggbb + 불투명도(%) → ASS &HAABBGGRR (ASS의 alpha는 00=불투명, FF=투명) */
export function assColor(hex, opacityPct = 100) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  const a = Math.round((1 - Math.min(100, Math.max(0, opacityPct)) / 100) * 255).toString(16).padStart(2, '0');
  return m ? `&H${a}${m[3]}${m[2]}${m[1]}`.toUpperCase() : '&H00FFFFFF';
}

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

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7FF]+/g;
const boldTag = (f) => (f.bold === -1 ? 1 : 0);

/** 한글이 없는 폰트는 한글 구간만 폴백 폰트로 바꿔 시스템 대체 폰트에 맡기지 않는다 */
export function withHangulFallback(escaped, font) {
  if (!font.hangulFallback) return escaped;
  const fb = fontById(font.hangulFallback);
  return escaped.replace(HANGUL, (m) => `{\\fn${fb.family}\\b${boldTag(fb)}}${m}{\\fn${font.family}\\b${boldTag(font)}}`);
}

const esc = (t) => String(t).replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');

/**
 * @param subs  [{start,end,text}] — 원본 영상 기준 시간(초)
 * @param clip  {start,end,title,subtitleOn,titleOn}
 * @param tpl   templates.js 의 템플릿
 */
export function buildAss({ clip, subs, tpl }) {
  const fTitle = fontById(tpl.titleFont);
  const fSub = fontById(tpl.subFont);
  const fAcc = fontById(tpl.accountFont);
  const segs = segmentsOf(clip);
  const dur = totalDuration(segs);
  // 요소 중심 좌표 (캔버스 비율 → 픽셀)
  const at = (x, y) => `{\\an5\\pos(${Math.round(x * OUT_W)},${Math.round(y * OUT_H)})}`;
  const lines = [];
  lines.push('[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${OUT_W}`, `PlayResY: ${OUT_H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '');
  lines.push('[V4+ Styles]');
  lines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');

  // 글자 스타일(테두리) 와 배경 박스 스타일(글자는 투명, BorderStyle 3 박스만 그림)을 요소마다 만든다
  const styles = {};
  const addStyle = (name, el, font, size, color, margins) => {
    const outline = tpl[`${el}OutlineOn`] ? tpl[`${el}OutlineWidth`] : 0;
    lines.push(`Style: ${name},${font.family},${size},${color},&H000000FF,${assColor(tpl[`${el}OutlineColor`])},&H00000000,${font.bold},0,0,0,100,100,0,0,1,${outline},0,5,${margins},0,1`);
    if (tpl[`${el}BgOn`]) {
      lines.push(`Style: ${name}Bg,${font.family},${size},&HFFFFFFFF,&H000000FF,${assColor(tpl[`${el}BgColor`], tpl[`${el}BgOpacity`])},&HFFFFFFFF,${font.bold},0,0,0,100,100,0,0,3,${tpl[`${el}BgPad`]},0,5,${margins},0,1`);
    }
    styles[el] = { name, bg: !!tpl[`${el}BgOn`] };
  };
  addStyle('Title', 'title', fTitle, tpl.titleSize, hexToAss(tpl.titleColor1), '60,60');
  addStyle('Sub', 'sub', fSub, tpl.subSize, hexToAss(tpl.subColor), '70,70');
  addStyle('Account', 'account', fAcc, tpl.accountSize, hexToAss(tpl.accountColor), '60,60');
  lines.push('', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

  // 배경 박스는 아래 레이어(0), 글자는 위 레이어(1)에 같은 문구를 그린다
  const emit = (el, start, end, pos, text, bgText = text) => {
    const st = styles[el];
    if (st.bg) lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},${st.name}Bg,,0,0,0,,${pos}${bgText}`);
    lines.push(`Dialogue: 1,${assTime(start)},${assTime(end)},${st.name},,0,0,0,,${pos}${text}`);
  };

  if (clip.titleOn !== false) {
    const t = splitTitle(clip.title);
    if (t.length) {
      const f = (x) => withHangulFallback(esc(x), fTitle);
      const text = t.length === 1 ? f(t[0]) : `${f(t[0])}\\N{\\c${hexToAss(tpl.titleColor2)}&}${f(t[1])}`;
      emit('title', 0, dur, at(tpl.titleX, tpl.titleY), text, t.map(f).join('\\N'));
    }
  }
  if (tpl.account) {
    emit('account', 0, dur, at(tpl.accountX, tpl.accountY), withHangulFallback(esc(tpl.account), fAcc));
  }
  if (clip.subtitleOn !== false) {
    const p = at(tpl.subX, tpl.subY);
    for (const s of timelineSubs(segs, subs)) emit('sub', s.start, s.end, p, withHangulFallback(esc(s.text), fSub));
  }
  return lines.join('\n') + '\n';
}
