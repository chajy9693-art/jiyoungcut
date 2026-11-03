import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { newId } from './store.js';
import { isFontId, DEFAULT_FONT_ID } from './fonts.js';
import { FRAME_DEFAULTS, FRAME_LIMITS } from './layout.js';

const FILE = path.join(DATA_DIR, 'templates.json');

/** 레이아웃별 요소 기본 위치 (캔버스 비율, 요소 중심 기준) */
export const POSITION_DEFAULTS = {
  full: { title: [0.5, 0.152], sub: [0.5, 0.755], account: [0.5, 0.9375] },
  framed: { title: [0.5, 0.109375], sub: [0.5, 0.76], account: [0.5, 0.890625] },
};

/** 자막 빠른 선택(프리셋): 선택하면 자막의 색·테두리·배경 값이 한 번에 채워진다 */
export const SUB_PRESETS = {
  basic: { label: '기본 (흰색)', color: '#ffffff', outlineOn: true, outlineColor: '#000000', outlineWidth: 7, bgOn: false, bgColor: '#000000', bgOpacity: 69, bgPad: 14 },
  yellow: { label: '노랑 강조', color: '#fff000', outlineOn: true, outlineColor: '#000000', outlineWidth: 7, bgOn: false, bgColor: '#000000', bgOpacity: 69, bgPad: 14 },
  box: { label: '검정 박스', color: '#ffffff', outlineOn: false, outlineColor: '#000000', outlineWidth: 7, bgOn: true, bgColor: '#000000', bgOpacity: 69, bgPad: 14 },
};

const ELEMENTS = ['title', 'sub', 'account'];
// 요소별 테두리/배경 기본값 (account의 테두리 on/off 기본값은 레이아웃에 따라 달라 따로 처리)
const DECOR = {
  title: { OutlineOn: true, OutlineColor: '#000000', OutlineWidth: 8, BgOn: false, BgColor: '#000000', BgOpacity: 60, BgPad: 14 },
  sub: { OutlineOn: true, OutlineColor: '#000000', OutlineWidth: 7, BgOn: false, BgColor: '#000000', BgOpacity: 69, BgPad: 14 },
  account: { OutlineColor: '#000000', OutlineWidth: 5, BgOn: false, BgColor: '#000000', BgOpacity: 60, BgPad: 14 },
};

export const DEFAULTS = {
  name: '새 템플릿',
  account: '',
  layout: 'full', // full: 영상 전체화면 / framed: 배경색 위에 정사각 영상
  bgColor: '#1f6f6a',
  titleFont: DEFAULT_FONT_ID,
  titleSize: 84,
  titleColor1: '#ffffff',
  titleColor2: '#fff000',
  subFont: DEFAULT_FONT_ID,
  subSize: 68,
  subColor: '#ffffff',
  accountFont: DEFAULT_FONT_ID,
  accountSize: 52,
  accountColor: '#ffffff',
  ...Object.fromEntries(ELEMENTS.flatMap((el) => Object.entries(DECOR[el]).map(([k, v]) => [`${el}${k}`, v]))),
};

const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d);
const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const frac = (v, d) => { const n = Number(v); return v == null || !Number.isFinite(n) ? d : Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000; };
const bool = (v, d) => (v == null ? d : !!v);
const rng = (v, lo, hi, d) => { const n = Number(v); return v == null || !Number.isFinite(n) ? d : Math.round(Math.min(hi, Math.max(lo, n)) * 1000) / 1000; };

export function sanitize(input = {}, base = DEFAULTS) {
  // 구버전 템플릿 호환: subStyle 프리셋 → 자막 색/테두리/배경 값, accountOutline → accountOutlineOn
  const preset = input.subStyle && input.subColor === undefined && input.subOutlineOn === undefined ? SUB_PRESETS[input.subStyle] : null;
  const legacy = preset ? {
    subColor: preset.color, subOutlineOn: preset.outlineOn, subOutlineColor: preset.outlineColor, subOutlineWidth: preset.outlineWidth,
    subBgOn: preset.bgOn, subBgColor: preset.bgColor, subBgOpacity: preset.bgOpacity, subBgPad: preset.bgPad,
  } : {};
  const i = { ...base, ...input, ...legacy };
  const layout = i.layout === 'framed' ? 'framed' : 'full';
  const pd = POSITION_DEFAULTS[layout];
  const fd = FRAME_DEFAULTS[layout];
  const frameH = rng(i.frameH, ...FRAME_LIMITS.h, fd.h);
  const out = {
    name: String(i.name ?? base.name).trim().slice(0, 30) || base.name,
    account: String(i.account ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40),
    layout,
    bgColor: hex(i.bgColor, base.bgColor),
    // 영상 크기: 너비/높이/세로 위치 (캔버스 대비 비율). 레이아웃 기본값에서 시작
    frameW: rng(i.frameW, ...FRAME_LIMITS.w, fd.w),
    frameH,
    frameCy: rng(i.frameCy, frameH / 2, 1 - frameH / 2, fd.cy),
    titleFont: isFontId(i.titleFont) ? i.titleFont : DEFAULT_FONT_ID,
    titleSize: num(i.titleSize, 40, 130, base.titleSize),
    titleColor1: hex(i.titleColor1, base.titleColor1),
    titleColor2: hex(i.titleColor2, base.titleColor2),
    titleX: frac(i.titleX, pd.title[0]),
    titleY: frac(i.titleY, pd.title[1]),
    subFont: isFontId(i.subFont) ? i.subFont : DEFAULT_FONT_ID,
    subSize: num(i.subSize, 36, 110, base.subSize),
    subColor: hex(i.subColor, base.subColor),
    subX: frac(i.subX, pd.sub[0]),
    subY: frac(i.subY, pd.sub[1]),
    accountFont: isFontId(i.accountFont) ? i.accountFont : DEFAULT_FONT_ID,
    accountSize: num(i.accountSize, 24, 110, base.accountSize),
    accountColor: hex(i.accountColor, base.accountColor),
    accountX: frac(i.accountX, pd.account[0]),
    accountY: frac(i.accountY, pd.account[1]),
  };
  for (const el of ELEMENTS) {
    const d = DECOR[el];
    const dflt = el === 'account' && i.accountOutlineOn == null ? (i.accountOutline != null ? !!i.accountOutline : layout === 'full') : d.OutlineOn;
    out[`${el}OutlineOn`] = bool(i[`${el}OutlineOn`], dflt);
    out[`${el}OutlineColor`] = hex(i[`${el}OutlineColor`], d.OutlineColor);
    out[`${el}OutlineWidth`] = num(i[`${el}OutlineWidth`], 0, 24, d.OutlineWidth);
    out[`${el}BgOn`] = bool(i[`${el}BgOn`], d.BgOn);
    out[`${el}BgColor`] = hex(i[`${el}BgColor`], d.BgColor);
    out[`${el}BgOpacity`] = num(i[`${el}BgOpacity`], 0, 100, d.BgOpacity);
    out[`${el}BgPad`] = num(i[`${el}BgPad`], 0, 60, d.BgPad);
  }
  return out;
}

// 쇼츠 하나에서만 템플릿 값을 덮어쓸 수 있는 항목: 요소(제목/자막/계정명)별 폰트·크기·색·위치·테두리·배경
// (템플릿 설정 화면과 같은 항목. 레이아웃·계정명 문구·영상 프레임은 별도 경로)
const SIZE_RANGE = { title: [40, 130], sub: [36, 110], account: [24, 110] };
const COLOR_KEYS = { title: ['Color1', 'Color2'], sub: ['Color'], account: ['Color'] };

export function sanitizeOverrides(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  const has = (k) => input[k] != null;
  for (const el of ELEMENTS) {
    const k = (n) => `${el}${n}`;
    if (has(k('Font')) && isFontId(input[k('Font')])) out[k('Font')] = input[k('Font')];
    if (has(k('Size'))) out[k('Size')] = num(input[k('Size')], ...SIZE_RANGE[el], DEFAULTS[k('Size')]);
    for (const c of COLOR_KEYS[el]) if (/^#[0-9a-fA-F]{6}$/.test(input[k(c)])) out[k(c)] = input[k(c)].toLowerCase();
    if (has(k('X'))) out[k('X')] = rng(input[k('X')], 0, 1, 0.5);
    if (has(k('Y'))) out[k('Y')] = rng(input[k('Y')], 0, 1, 0.5);
    if (has(k('OutlineOn'))) out[k('OutlineOn')] = !!input[k('OutlineOn')];
    if (/^#[0-9a-fA-F]{6}$/.test(input[k('OutlineColor')])) out[k('OutlineColor')] = input[k('OutlineColor')].toLowerCase();
    if (has(k('OutlineWidth'))) out[k('OutlineWidth')] = num(input[k('OutlineWidth')], 0, 24, DECOR[el].OutlineWidth);
    if (has(k('BgOn'))) out[k('BgOn')] = !!input[k('BgOn')];
    if (/^#[0-9a-fA-F]{6}$/.test(input[k('BgColor')])) out[k('BgColor')] = input[k('BgColor')].toLowerCase();
    if (has(k('BgOpacity'))) out[k('BgOpacity')] = num(input[k('BgOpacity')], 0, 100, DECOR[el].BgOpacity);
    if (has(k('BgPad'))) out[k('BgPad')] = num(input[k('BgPad')], 0, 60, DECOR[el].BgPad);
  }
  return out;
}
export const applyOverrides = (tpl, overrides) => (overrides && Object.keys(overrides).length ? { ...tpl, ...overrides } : tpl);

let list = load();

function load() {
  try {
    const l = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(l) && l.length) return l.map((t) => ({ id: t.id, ...sanitize(t) }));
  } catch {}
  const l = [{ id: newId(4), ...sanitize({ name: '기본' }) }];
  persist(l);
  return l;
}
function persist(l = list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(l, null, 2));
}

export const all = () => list;
export const find = (id) => list.find((t) => t.id === id);
/** 클립에 지정된 템플릿, 없으면(삭제됨 등) 첫 번째 템플릿 */
export const resolve = (id) => find(id) || list[0];

export function create(input) {
  const t = { id: newId(4), ...sanitize(input) };
  list.push(t);
  persist();
  return t;
}
export function update(id, input) {
  const t = find(id);
  if (!t) return null;
  Object.assign(t, sanitize(input, t));
  persist();
  return t;
}
export function remove(id) {
  if (list.length <= 1) return false;
  const n = list.filter((t) => t.id !== id);
  if (n.length === list.length) return false;
  list = n;
  persist();
  return true;
}
