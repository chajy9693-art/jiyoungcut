import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkSegments, splitTitle } from '../server/subtitles.js';
import { buildAss, assTime, timelineSubs, withHangulFallback, assColor } from '../server/ass.js';
import { fontById, FONT_CATALOG } from '../server/fonts.js';
import { normalizeClips, normalizeSegments, heuristicHighlights, pickSttProvider } from '../server/ai.js';
import { parseWhisperCppJson } from '../server/stt-local.js';
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
  const ass = buildAss({ clip: { start: 100, end: 110, title: '제목' }, tpl: sanitize({ subStyle: 'box', account: '@jiyoung' }), subs: [{ start: 98, end: 102, text: '안녕{}' }, { start: 200, end: 201, text: '밖' }] });
  assert.match(ass, /Dialogue: 1,0:00:00.00,0:00:02.00,Sub,,0,0,0,,\{\\an5\\pos\(540,1450\)\}안녕/);
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
  const ass = buildAss({ clip: { start: 0, end: 5, title: '제목' }, subs: [], tpl: sanitize({ layout: 'framed', account: '@a' }) });
  assert.match(ass, /pos\(540,1710\)\}@a/);
});

test('템플릿 검증: 잘못된 값은 기본값으로 보정', () => {
  const t = sanitize({ bgColor: 'red', titleSize: 9999, layout: 'x', subStyle: 'nope', account: '@a\nb' });
  assert.equal(t.bgColor, DEFAULTS.bgColor);
  assert.equal(t.titleSize, 130);
  assert.equal(t.layout, 'full');
  assert.equal(t.subOutlineOn, true); // 알 수 없는 subStyle은 무시하고 기본값 유지
  assert.equal(t.account, '@a b');
});

test('맥락 편집: 구간 보정 — 겹침 제거, 인접 병합, 총 길이 제한, 재생 순서 유지', () => {
  const transcript = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 4.5, text: 'x' }));
  const segs = normalizeSegments(
    [
      { start: 200, end: 205, role: 'hook' },
      { start: 10, end: 24.5, role: 'body' },
      { start: 25, end: 39.5, role: 'body' }, // 바로 이어지므로 병합
      { start: 20, end: 30, role: 'body' }, // 겹침 → 제거
      { start: 100, end: 140, role: 'ending' }, // 남은 길이만큼만
    ],
    { transcript, duration: 300, maxLen: 50 },
  );
  assert.equal(segs[0].role, 'hook');
  assert.equal(segs[0].start, 200);
  assert.deepEqual([segs[1].start, segs[1].end], [10, 39.5]);
  assert.equal(segs.length, 3);
  assert.ok(segs.reduce((n, s) => n + s.end - s.start, 0) <= 50.001);
});

test('맥락 편집: 쇼츠끼리 원본 구간이 겹치면 제외', () => {
  const transcript = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 4.5, text: 'x' }));
  const mk = (segments, score) => ({ segments, title: 't', score });
  const out = normalizeClips(
    [mk([{ start: 10, end: 40, role: 'body' }], 90), mk([{ start: 200, end: 205, role: 'hook' }, { start: 30, end: 55, role: 'body' }], 80), mk([{ start: 100, end: 130, role: 'body' }], 70)],
    { transcript, duration: 300, minLen: 20, maxLen: 60 },
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.score), [90, 70]);
});

test('이어 붙인 타임라인으로 자막 시간 변환', () => {
  const segs = [{ start: 200, end: 205 }, { start: 10, end: 20 }];
  const out = timelineSubs(segs, [{ start: 10, end: 12, text: '본론' }, { start: 201, end: 203, text: '후킹' }, { start: 100, end: 101, text: '제외' }]);
  assert.deepEqual(out.map((s) => [s.text, s.start, s.end]), [['후킹', 1, 3], ['본론', 5, 7]]);
  const ass = buildAss({ clip: { segments: segs, title: '' }, tpl: sanitize({}), subs: [{ start: 10, end: 12, text: '본론' }] });
  assert.match(ass, /Dialogue: 1,0:00:05.00,0:00:07.00,Sub,,0,0,0,,\{[^}]*\}본론/);
});

test('whisper.cpp JSON 변환: 오프셋 적용, 소리 설명/빈 구간 제외', () => {
  const json = { transcription: [
    { offsets: { from: 0, to: 2500 }, text: ' 안녕하세요  여러분' },
    { offsets: { from: 2500, to: 3000 }, text: ' [BLANK_AUDIO]' },
    { offsets: { from: 3000, to: 3000 }, text: ' 길이 0' },
    { offsets: { from: 3000, to: 6000 }, text: ' (음악)' },
    { offsets: { from: 6000, to: 8200 }, text: ' 오늘은 노션입니다' },
  ] };
  const out = parseWhisperCppJson(json, 600);
  assert.deepEqual(out.map((s) => [s.start, s.end, s.text]), [[600, 602.5, '안녕하세요 여러분'], [606, 608.2, '오늘은 노션입니다']]);
});

test('음성 인식 방식 선택', () => {
  assert.equal(pickSttProvider({ explicit: '', openaiKey: 'k', localOk: true }), 'openai');
  assert.equal(pickSttProvider({ explicit: '', openaiKey: '', localOk: true }), 'local');
  assert.equal(pickSttProvider({ explicit: 'local', openaiKey: 'k', localOk: true }), 'local');
  assert.equal(pickSttProvider({ explicit: 'local', openaiKey: 'k', localOk: false }), null);
  assert.equal(pickSttProvider({ explicit: '', openaiKey: '', localOk: false }), null);
});

test('템플릿: 폰트·위치 기본값은 레이아웃 기준, 범위/폰트 id 검증', () => {
  const full = sanitize({});
  assert.deepEqual([full.titleX, full.titleY, full.accountY], [0.5, 0.152, 0.9375]);
  const framed = sanitize({ layout: 'framed' });
  assert.equal(framed.accountY, 0.890625);
  assert.equal(framed.accountOutlineOn, false);
  const t = sanitize({ titleX: 5, titleY: -2, titleFont: 'nope', subFont: 'jua', subSize: 10, accountOutlineOn: true });
  assert.equal(t.titleX, 1);
  assert.equal(t.titleY, 0);
  assert.equal(t.titleFont, 'pretendard-bold');
  assert.equal(t.subFont, 'jua');
  assert.equal(t.subSize, 36);
  assert.equal(t.accountOutlineOn, true);
  // 기존 템플릿 수정 시 지정하지 않은 값은 유지
  assert.equal(sanitize({ subSize: 90 }, t).titleX, 1);
});

test('ASS: 요소별 폰트와 위치가 반영된다', () => {
  const tpl = sanitize({ account: '@jy', titleFont: 'black-han-sans', subFont: 'nanum-myeongjo', accountFont: 'jua', titleX: 0.25, titleY: 0.3, subSize: 80, accountOutlineOn: false });
  const ass = buildAss({ clip: { start: 0, end: 5, title: '제목' }, subs: [{ start: 0, end: 2, text: '자막' }], tpl });
  assert.match(ass, /Style: Title,Black Han Sans,84,.*,0,0,0,0,100,100,0,0,1,8,0,5,/);
  assert.match(ass, /Style: Sub,NanumMyeongjoExtraBold,80,/);
  assert.match(ass, /Style: Account,Jua,52,.*,1,0,0,5,/);
  assert.match(ass, /Title,,0,0,0,,\{\\an5\\pos\(270,576\)\}제목/);
});

test('한글 글리프가 없는 폰트는 한글 구간만 폴백 폰트로 지정', () => {
  const nh = fontById('notion-hand');
  assert.equal(withHangulFallback('ABC 노션 123', nh), 'ABC {\\fnPretendard\\b1}노션{\\fnNotionHand Community\\b0} 123');
  assert.equal(withHangulFallback('가나', fontById('jua')), '가나'); // 폴백 없는 폰트는 그대로
  const tpl = sanitize({ titleFont: 'notion-hand', account: '@jy노션' });
  const ass = buildAss({ clip: { start: 0, end: 5, title: '노션 Tips' }, subs: [], tpl });
  assert.match(ass, /\{\\fnPretendard\\b1\}노션\{\\fnNotionHand Community\\b0\} Tips/);
  assert.ok(FONT_CATALOG.every((f) => !f.hangulFallback || FONT_CATALOG.some((x) => x.id === f.hangulFallback)));
});

test('테두리/배경: 색 변환(불투명도→ASS alpha), 구버전 템플릿 마이그레이션, 값 보정', () => {
  assert.equal(assColor('#ff8800'), '&H000088FF');
  assert.equal(assColor('#000000', 69), '&H4F000000');
  assert.equal(assColor('#ffffff', 0), '&HFFFFFFFF');
  // 구버전: subStyle 'box' → 배경 켜짐/테두리 꺼짐, accountOutline → accountOutlineOn
  const old = sanitize({ subStyle: 'box', accountOutline: false, layout: 'full' });
  assert.equal(old.subBgOn, true);
  assert.equal(old.subOutlineOn, false);
  assert.equal(old.subBgOpacity, 69);
  assert.equal(old.accountOutlineOn, false);
  const yellow = sanitize({ subStyle: 'yellow' });
  assert.equal(yellow.subColor, '#fff000');
  assert.equal(yellow.subOutlineOn, true);
  // 새 값은 범위 보정, 지정하지 않은 값은 기존 템플릿 유지
  const t = sanitize({ titleOutlineWidth: 99, titleBgOpacity: -5, titleBgPad: 500, titleOutlineColor: 'red', titleBgOn: 1 });
  assert.deepEqual([t.titleOutlineWidth, t.titleBgOpacity, t.titleBgPad, t.titleOutlineColor, t.titleBgOn], [24, 0, 60, '#000000', true]);
  assert.equal(sanitize({ subSize: 90 }, t).titleBgOn, true);
});

test('ASS: 테두리 색·두께와 배경 박스(별도 레이어)가 반영된다', () => {
  const tpl = sanitize({ account: '@a', titleOutlineColor: '#ff0000', titleOutlineWidth: 12, titleBgOn: true, titleBgColor: '#112233', titleBgOpacity: 50, titleBgPad: 20, subOutlineOn: false, accountOutlineOn: false });
  const ass = buildAss({ clip: { start: 0, end: 5, title: '제목' }, subs: [{ start: 0, end: 2, text: '자막' }], tpl });
  // 글자 스타일: 빨간 테두리 12px / 배경 스타일: BorderStyle 3, 패딩 20, 50% 불투명 박스, 글자는 투명
  assert.match(ass, /Style: Title,[^,]+,84,&H00FFFFFF,&H000000FF,&H000000FF,&H00000000,[^\n]*,0,0,1,12,0,5,/);
  assert.match(ass, /Style: TitleBg,[^,]+,84,&HFFFFFFFF,&H000000FF,&H80332211,&HFFFFFFFF,[^\n]*,0,0,3,20,0,5,/);
  assert.match(ass, /Dialogue: 0,[^\n]*,TitleBg,,0,0,0,,[^\n]*제목/);
  assert.match(ass, /Dialogue: 1,[^\n]*,Title,,0,0,0,,[^\n]*제목/);
  // 테두리 끔(두께 0), 배경 꺼짐이면 배경 스타일/레이어가 없다
  assert.match(ass, /Style: Sub,[^\n]*,0,0,1,0,0,5,/);
  assert.ok(!ass.includes('SubBg') && !ass.includes('AccountBg'));
});
