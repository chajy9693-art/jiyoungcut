import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkSegments, splitTitle } from '../server/subtitles.js';
import { buildAss, assTime } from '../server/ass.js';
import { normalizeClips, heuristicHighlights } from '../server/ai.js';
import { buildVideoFilter } from '../server/ffmpeg.js';
import { DEFAULTS, sanitize } from '../server/templates.js';

test('자막 분할: 줄당 16자 이하, 시간 보존', () => {
  const out = chunkSegments([{ start: 10, end: 14, text: '이것은 쇼츠에 들어갈 조금 긴 문장입니다 정말로 길어요' }]);
  assert.ok(out.length >= 2);
  assert.ok(out.every((s) => s.text.length <= 16));
  assert.equal(out[0].start, 10);
  assert.ok(Math.abs(out.at(-1).end - 14) < 0.05);
});

test('제목 두 줄 분할', () => {
  assert.deepEqual(splitTitle('짧은 제목'), ['짧은 제목']);
  assert.equal(splitTitle('이 영상 하나면 충분합니다 정말로 그렇습니다').length, 2);
  assert.deepEqual(splitTitle('가\n나'), ['가', '나']);
});

test('ASS 시간 및 구간 상대화', () => {
  assert.equal(assTime(3661.5), '1:01:01.50');
  const ass = buildAss({ clip: { start: 100, end: 110, title: '제목' }, tpl: { ...DEFAULTS, subStyle: 'box', account: '@jiyoung' }, subs: [{ start: 98, end: 102, text: '안녕{}' }, { start: 200, end: 201, text: '밖' }] });
  assert.match(ass, /Dialogue: 1,0:00:00.00,0:00:02.00,Sub,,0,0,0,,안녕/);
  assert.ok(!ass.includes('밖'));
  assert.match(ass, /Account,,0,0,0,,\{\\an5\\pos\(540,1800\)\}@jiyoung/);
});

test('하이라이트 보정: 길이 제한, 겹침 제거, 발화 경계 스냅', () => {
  const transcript = Array.from({ length: 40 }, (_, i) => ({ start: i * 5, end: i * 5 + 4.5, text: 'x' }));
  const raw = [
    { start: 11, end: 200, title: 'a', score: 90 },
    { start: 20, end: 50, title: '겹침', score: 80 },
    { start: 120, end: 160, title: 'b', score: 70 },
  ];
  const out = normalizeClips(raw, { transcript, duration: 200, minLen: 20, maxLen: 60 });
  assert.equal(out.length, 2);
  assert.ok(out.every((c) => c.end - c.start <= 60));
  assert.equal(out[0].start, 10);
});

test('크롭 필터: 16:9 → 9:16, cropX 반영', () => {
  assert.match(buildVideoFilter({ srcW: 1920, srcH: 1080, cropX: 1 }), /^crop=606:1080:1314:0,scale=1080:1920/);
  assert.match(buildVideoFilter({ srcW: 1920, srcH: 1080, cropX: 0 }), /^crop=606:1080:0:0,/);
});

test('API 키 없는 대체 로직', () => {
  const transcript = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 4, text: '가'.repeat((i % 7) + 1) }));
  const out = heuristicHighlights({ transcript, duration: 300, minLen: 20, maxLen: 40, count: 3 });
  assert.equal(out.length, 3);
});

test('framed 레이아웃: 정사각 크롭 + 배경색 패딩, 계정명은 하단 바 중앙', () => {
  const f = buildVideoFilter({ srcW: 1920, srcH: 1080, cropX: 0.5, layout: 'framed', bgColor: '#1f6f6a' });
  assert.match(f, /^crop=1080:1080:420:0,scale=1080:1080.*pad=1080:1920:0:420:color=0x1f6f6a/);
  const ass = buildAss({ clip: { start: 0, end: 5, title: '제목' }, subs: [], tpl: { ...DEFAULTS, layout: 'framed', account: '@a' } });
  assert.match(ass, /pos\(540,1710\)\}@a/);
});

test('템플릿 검증: 잘못된 값은 기본값으로 보정', () => {
  const t = sanitize({ bgColor: 'red', titleSize: 9999, layout: 'x', subStyle: 'nope', account: '@a\nb' });
  assert.equal(t.bgColor, DEFAULTS.bgColor);
  assert.equal(t.titleSize, 110);
  assert.equal(t.layout, 'full');
  assert.equal(t.subStyle, 'basic');
  assert.equal(t.account, '@a b');
});
