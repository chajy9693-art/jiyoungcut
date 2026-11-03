import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { newId } from './store.js';
import { SUB_TEMPLATES } from './ass.js';
import { isFontId, DEFAULT_FONT_ID } from './fonts.js';

const FILE = path.join(DATA_DIR, 'templates.json');

/** 레이아웃별 요소 기본 위치 (캔버스 비율, 요소 중심 기준) */
export const POSITION_DEFAULTS = {
  full: { title: [0.5, 0.152], sub: [0.5, 0.755], account: [0.5, 0.9375] },
  framed: { title: [0.5, 0.109375], sub: [0.5, 0.76], account: [0.5, 0.890625] },
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
  subStyle: 'basic',
  accountFont: DEFAULT_FONT_ID,
  accountSize: 52,
  accountColor: '#ffffff',
};

const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d);
const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const frac = (v, d) => { const n = Number(v); return v == null || !Number.isFinite(n) ? d : Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000; };

export function sanitize(input = {}, base = DEFAULTS) {
  const i = { ...base, ...input };
  const layout = i.layout === 'framed' ? 'framed' : 'full';
  const pd = POSITION_DEFAULTS[layout];
  return {
    name: String(i.name ?? base.name).trim().slice(0, 30) || base.name,
    account: String(i.account ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40),
    layout,
    bgColor: hex(i.bgColor, base.bgColor),
    titleFont: isFontId(i.titleFont) ? i.titleFont : DEFAULT_FONT_ID,
    titleSize: num(i.titleSize, 40, 130, base.titleSize),
    titleColor1: hex(i.titleColor1, base.titleColor1),
    titleColor2: hex(i.titleColor2, base.titleColor2),
    titleX: frac(i.titleX, pd.title[0]),
    titleY: frac(i.titleY, pd.title[1]),
    subFont: isFontId(i.subFont) ? i.subFont : DEFAULT_FONT_ID,
    subSize: num(i.subSize, 36, 110, base.subSize),
    subStyle: SUB_TEMPLATES[i.subStyle] ? i.subStyle : base.subStyle,
    subX: frac(i.subX, pd.sub[0]),
    subY: frac(i.subY, pd.sub[1]),
    accountFont: isFontId(i.accountFont) ? i.accountFont : DEFAULT_FONT_ID,
    accountSize: num(i.accountSize, 24, 110, base.accountSize),
    accountColor: hex(i.accountColor, base.accountColor),
    accountOutline: i.accountOutline == null ? layout === 'full' : !!i.accountOutline,
    accountX: frac(i.accountX, pd.account[0]),
    accountY: frac(i.accountY, pd.account[1]),
  };
}

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
