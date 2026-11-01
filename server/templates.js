import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { newId } from './store.js';
import { SUB_TEMPLATES } from './ass.js';

const FILE = path.join(DATA_DIR, 'templates.json');

export const DEFAULTS = {
  name: '새 템플릿',
  account: '',
  layout: 'full', // full: 영상 전체화면 / framed: 배경색 위에 정사각 영상
  bgColor: '#1f6f6a',
  titleSize: 84,
  titleColor1: '#ffffff',
  titleColor2: '#fff000',
  subStyle: 'basic',
  accountSize: 52,
  accountColor: '#ffffff',
};

const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d);
const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export function sanitize(input = {}, base = DEFAULTS) {
  const i = { ...base, ...input };
  return {
    name: String(i.name ?? base.name).trim().slice(0, 30) || base.name,
    account: String(i.account ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40),
    layout: i.layout === 'framed' ? 'framed' : 'full',
    bgColor: hex(i.bgColor, base.bgColor),
    titleSize: num(i.titleSize, 50, 110, base.titleSize),
    titleColor1: hex(i.titleColor1, base.titleColor1),
    titleColor2: hex(i.titleColor2, base.titleColor2),
    subStyle: SUB_TEMPLATES[i.subStyle] ? i.subStyle : base.subStyle,
    accountSize: num(i.accountSize, 30, 90, base.accountSize),
    accountColor: hex(i.accountColor, base.accountColor),
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
