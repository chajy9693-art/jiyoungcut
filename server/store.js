import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const PROJECTS = path.join(DATA_DIR, 'projects');
fs.mkdirSync(PROJECTS, { recursive: true });

const cache = new Map();

export const newId = (n = 8) => crypto.randomBytes(n).toString('hex');
export const projectDir = (id) => path.join(PROJECTS, id);
const jsonPath = (id) => path.join(projectDir(id), 'project.json');
const validId = (id) => /^[a-f0-9]{8,32}$/.test(id);

export function save(p) {
  const tmp = jsonPath(p.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p));
  fs.renameSync(tmp, jsonPath(p.id));
}

export function get(id) {
  if (!validId(id)) return null;
  if (cache.has(id)) return cache.get(id);
  if (!fs.existsSync(jsonPath(id))) return null;
  const p = JSON.parse(fs.readFileSync(jsonPath(id), 'utf8'));
  // 서버 재시작으로 중단된 작업 정리
  if (p.status === 'analyzing') {
    p.status = 'error';
    p.error = '서버가 재시작되어 분석이 중단되었습니다. 다시 시도해 주세요.';
  }
  for (const c of p.clips || []) {
    if (c.render?.status === 'rendering' || c.render?.status === 'queued') c.render = { status: 'error', error: '렌더링이 중단되었습니다.' };
  }
  cache.set(id, p);
  return p;
}

export function list() {
  return fs.readdirSync(PROJECTS)
    .map((id) => get(id))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function create(p) {
  fs.mkdirSync(projectDir(p.id), { recursive: true });
  cache.set(p.id, p);
  save(p);
  return p;
}

export function remove(id) {
  cache.delete(id);
  if (validId(id)) fs.rmSync(projectDir(id), { recursive: true, force: true });
}

/** 클라이언트에 보낼 때 큰 필드(전체 자막)는 필요한 만큼만 */
export function publicView(p, { withSubtitles = true } = {}) {
  const { transcript, ...rest } = p;
  if (!withSubtitles) delete rest.subtitles;
  return rest;
}
