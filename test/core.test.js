import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkSegments, splitTitle } from '../server/subtitles.js';
import { buildAss, assTime, timelineSubs, withHangulFallback, assColor } from '../server/ass.js';
import { fontById, FONT_CATALOG } from '../server/fonts.js';
import { normalizeClips, normalizeSegments, heuristicHighlights, pickSttProvider, normalizeTopics, pickTopics, mockTopics, mockHighlights } from '../server/ai.js';
import { parseWhisperCppJson } from '../server/stt-local.js';
import { buildVideoFilter, buildRenderGraph } from '../server/ffmpeg.js';
import { effectiveSegments, tightenSummary, sanitizeTighten } from '../public/cuts.js';
import { parseSilenceDetect, findFillers, fillersFromSegments, buildCuts } from '../server/cuts.js';
import { DEFAULTS, sanitize, sanitizeOverrides, applyOverrides } from '../server/templates.js';
import { resolveFrame, framePixels, cropBox, sanitizeFrame } from '../server/layout.js';

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

test('영상 프레임 필터: 전체화면은 패딩 없이 cropX 반영', () => {
  const frame = { ...framePixels(resolveFrame(sanitize({}))), bg: '#000000' };
  assert.match(buildVideoFilter({ srcW: 1920, srcH: 1080, cropX: 1, cropY: 0.5, zoom: 1, frame }), /^crop=606:1080:1314:0,scale=1080:1920:flags=lanczos,setsar=1$/);
  assert.match(buildVideoFilter({ srcW: 1920, srcH: 1080, cropX: 0, cropY: 0.5, zoom: 1, frame }), /^crop=606:1080:0:0,/);
});

test('API 키 없는 대체 로직', () => {
  const transcript = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 4, text: '가'.repeat((i % 7) + 1) }));
  const out = heuristicHighlights({ transcript, duration: 300, minLen: 20, maxLen: 40, count: 3 });
  assert.equal(out.length, 3);
});

test('framed 레이아웃: 정사각 크롭 + 배경색 패딩, 계정명은 하단 바 중앙', () => {
  const tp = sanitize({ layout: 'framed', bgColor: '#1f6f6a' });
  const fr = resolveFrame(tp);
  const f = buildVideoFilter({ srcW: 1920, srcH: 1080, cropX: 0.5, cropY: 0.5, zoom: 1, frame: { ...framePixels(fr), bg: fr.bg } });
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

test('영상 너비·크기: 프레임 계산(짝수, 가운데, 범위 보정)과 확대/이동 크롭', () => {
  const tp = sanitize({});
  // 기본: 전체화면
  assert.deepEqual(framePixels(resolveFrame(tp)), { fw: 1080, fh: 1920, x0: 0, y0: 0 });
  // 너비 60%, 높이 40%, 세로 위치 맨 위 요청 → 프레임이 캔버스 안으로 보정되고 가운데 정렬
  const fr = resolveFrame(tp, { frame: { w: 0.6, h: 0.4, cy: 0 } });
  const px = framePixels(fr);
  assert.deepEqual([px.fw, px.fh, px.x0, px.y0], [648, 768, 216, 0]);
  assert.ok(px.fw % 2 === 0 && px.fh % 2 === 0 && px.x0 % 2 === 0 && px.y0 % 2 === 0);
  // 범위 밖 값은 한계로 보정
  const lim = resolveFrame(tp, { frame: { w: 5, h: 0.01, cy: 9 } });
  assert.deepEqual([lim.w, lim.h], [1, 0.2]);
  assert.equal(sanitizeFrame({ w: 0.1 }).w, 0.3);
  assert.equal(sanitizeFrame({}), null);
  // 프레임 비율에 맞춘 cover 크롭 + 확대 2배 + 이동
  const full = cropBox({ srcW: 1920, srcH: 1080, fw: 1080, fh: 1920, zoom: 1, cropX: 0.5, cropY: 0.5 });
  const z2 = cropBox({ srcW: 1920, srcH: 1080, fw: 1080, fh: 1920, zoom: 2, cropX: 1, cropY: 1 });
  assert.deepEqual([full.cw, full.ch], [606, 1080]);
  assert.deepEqual([z2.cw, z2.ch], [302, 540]);
  assert.deepEqual([z2.x, z2.y], [1920 - 302, 1080 - 540]); // 오른쪽 아래 끝
  // 가로로 넓은 프레임(전체 너비 + 낮은 높이)은 원본을 가로로 채움
  const wide = cropBox({ srcW: 1920, srcH: 1080, fw: 1080, fh: 608, zoom: 1 });
  assert.equal(wide.cw / wide.ch > 1.7, true);
  // 프레임 필터: 작은 프레임은 배경색 패딩이 붙는다
  const f = buildVideoFilter({ srcW: 1920, srcH: 1080, cropX: 0.5, cropY: 0.5, zoom: 1, frame: { ...px, bg: '#102030' } });
  assert.match(f, /pad=1080:1920:216:0:color=0x102030/);
});

test('쇼츠별 텍스트 스타일 덮어쓰기: 템플릿 설정과 같은 항목(폰트·크기·색·위치·테두리·배경)만 검증해 적용', () => {
  const o = sanitizeOverrides({
    titleSize: 999, subOutlineOn: 0, accountOutlineColor: '#ABCDEF', subOutlineWidth: -3,
    titleX: 0.9, titleY: 2, subFont: 'jua', accountFont: 'nope', titleColor2: '#00ff00', subColor: 'red',
    titleBgOn: true, titleBgColor: '#112233', titleBgOpacity: 500, titleBgPad: 20,
    layout: 'framed', account: 'x', frameW: 0.5, evil: 1, bgColor: '#000000',
  });
  assert.deepEqual(o, {
    titleSize: 130, titleColor2: '#00ff00', titleX: 0.9, titleY: 1, titleBgOn: true, titleBgColor: '#112233', titleBgOpacity: 100, titleBgPad: 20,
    subFont: 'jua', subOutlineOn: false, subOutlineWidth: 0, accountOutlineColor: '#abcdef',
  }); // 폰트 id/색이 잘못되면 무시, 범위 밖 값은 보정, 템플릿 전용 항목(layout/account/frame/bgColor)은 덮어쓸 수 없음
  const tp = sanitize({});
  const eff = applyOverrides(tp, o);
  assert.equal(eff.titleSize, 130);
  assert.equal(eff.titleX, 0.9);
  assert.equal(eff.titleY, 1);
  assert.equal(eff.layout, tp.layout);
  assert.equal(applyOverrides(tp, {}), tp);
  assert.equal(applyOverrides(tp, undefined), tp);
  const ass = buildAss({ clip: { start: 0, end: 5, title: '제목' }, subs: [{ start: 0, end: 2, text: '자막' }], tpl: eff });
  assert.match(ass, /Style: Title,[^,]+,130,/);
  assert.match(ass, /Style: TitleBg,/); // 배경이 켜지면 박스 스타일 생성
  assert.match(ass, /Title,,0,0,0,,\{\\an5\\pos\(972,1920\)\}제목/); // 위치 덮어쓰기 반영
  assert.match(ass, /Style: Sub,Jua,/);
});

test('템플릿 영상 크기: 레이아웃 기본값에서 시작, 범위 보정, 쇼츠별 조정이 위에 덮임', () => {
  assert.deepEqual([sanitize({}).frameW, sanitize({}).frameH, sanitize({}).frameCy], [1, 1, 0.5]);
  const fr = sanitize({ layout: 'framed' });
  assert.deepEqual([fr.frameW, fr.frameH, fr.frameCy], [1, 0.5625, 0.5]);
  // 범위 밖 값 보정 + 세로 위치는 프레임이 캔버스 안에 있도록 제한
  const t = sanitize({ frameW: 0.1, frameH: 0.5, frameCy: 0 });
  assert.deepEqual([t.frameW, t.frameH, t.frameCy], [0.3, 0.5, 0.25]);
  // 템플릿 프레임이 기본이 되고, 쇼츠별 조정은 지정한 값만 덮는다
  const tp = sanitize({ frameW: 0.8, frameH: 0.4, frameCy: 0.5, bgColor: '#102030' });
  assert.deepEqual(resolveFrame(tp), { w: 0.8, h: 0.4, cy: 0.5, bg: '#102030' });
  assert.deepEqual(resolveFrame(tp, { frame: { w: 0.5 } }), { w: 0.5, h: 0.4, cy: 0.5, bg: '#102030' });
  assert.deepEqual(framePixels(resolveFrame(tp)), { fw: 864, fh: 768, x0: 108, y0: 576 });
  // 이전에 저장된(프레임 값이 없는) 템플릿은 레이아웃 기본값 그대로
  assert.deepEqual(resolveFrame({ layout: 'framed', bgColor: '#000000' }), { w: 1, h: 0.5625, cy: 0.5, bg: '#000000' });
});

test('무음 제거: 긴 침묵은 2*pad 쉼으로 줄이고, 짧은 침묵은 유지', () => {
  const cuts = { silences: [{ start: 12, end: 14 }, { start: 20, end: 20.4 }], fillers: [] };
  const opts = { silence: true, minSilence: 0.6, pad: 0.15, filler: false };
  const eff = effectiveSegments([{ start: 10, end: 30, role: 'body' }], cuts, opts);
  // 12~14 침묵 → 12.15~13.85 제거. 0.4초 침묵은 minSilence 미만이라 그대로
  assert.deepEqual(eff.map((e) => [e.start, e.end, e.src]), [[10, 12.15, 0], [13.85, 30, 0]]);
  const sum = tightenSummary([{ start: 10, end: 30 }], cuts, opts);
  assert.equal(Math.round(sum.saved * 100) / 100, 1.7);
  assert.equal(sum.silences, 1);
  // 옵션이 꺼져 있거나 데이터가 없으면 원본 그대로
  assert.deepEqual(effectiveSegments([{ start: 10, end: 30 }], cuts, null).map((e) => [e.start, e.end]), [[10, 30]]);
  assert.deepEqual(effectiveSegments([{ start: 10, end: 30 }], null, opts).map((e) => [e.start, e.end]), [[10, 30]]);
});

test('군말 제거 + 여러 구간: 순서·역할·원본 구간(src) 유지, 전부 지워지면 원본 유지', () => {
  const cuts = { silences: [{ start: 105, end: 108 }], fillers: [{ start: 3, end: 3.5, text: '음' }, { start: 50, end: 60, text: '음' }] };
  const opts = { silence: true, minSilence: 0.6, pad: 0.15, filler: true };
  const segs = [{ start: 100, end: 110, role: 'hook' }, { start: 0, end: 20, role: 'body' }, { start: 50, end: 60, role: 'ending' }];
  const eff = effectiveSegments(segs, cuts, opts);
  assert.deepEqual(eff.map((e) => [e.role, e.src, e.start, e.end]), [
    ['hook', 0, 100, 105.15], ['hook', 0, 107.85, 110],
    ['body', 1, 0, 3], ['body', 1, 3.5, 20],
    ['ending', 2, 50, 60], // 구간 전체가 군말이라 전부 지워지게 되므로 원본 유지
  ]);
  // 켜진 항목만 반영
  assert.equal(effectiveSegments(segs, cuts, { ...opts, filler: false }).filter((e) => e.src === 1).length, 1);
});

test('무음 감지 출력 파싱, 군말 찾기(단어/문장), 옵션 검증', () => {
  const log = `[silencedetect @ 0x1] silence_start: 3.5\n[silencedetect @ 0x1] silence_end: 5.25 | silence_duration: 1.75\n[silencedetect @ 0x1] silence_start: 118.4`;
  assert.deepEqual(parseSilenceDetect(log, 120), [{ start: 3.5, end: 5.25 }, { start: 118.4, end: 120 }]);
  const words = [{ start: 1, end: 1.4, text: ' 음,' }, { start: 2, end: 2.5, text: '안녕' }, { start: 3, end: 3.3, text: 'Um...' }, { start: 4, end: 9, text: '음' }];
  assert.deepEqual(findFillers(words).map((f) => f.text), ['음', 'um']); // 1.5초를 넘는 건 군말이 아니라고 판단
  const segs = [{ start: 0, end: 1.2, text: '음...' }, { start: 2, end: 5, text: '음 그래서 오늘은' }, { start: 6, end: 7, text: '어 어' }];
  assert.deepEqual(fillersFromSegments(segs).map((f) => [f.start, f.end]), [[0, 1.2], [6, 7]]);
  assert.equal(buildCuts({ silences: [], words, segments: segs }).fillers.length, 2); // 단어 정보가 있으면 그걸 우선
  assert.deepEqual(sanitizeTighten({ silence: 1, minSilence: 99, pad: -1, filler: 0 }), { silence: true, minSilence: 2, pad: 0, filler: false });
  assert.equal(sanitizeTighten(null), null);
});

test('렌더 그래프: 일부를 걷어낸 구간은 select로, 그대로인 구간은 단순 입력으로', () => {
  const eff = [{ start: 100, end: 105, src: 0 }, { start: 0, end: 4, src: 1 }, { start: 5, end: 9, src: 1 }, { start: 11, end: 20, src: 1 }];
  const { inputs, graph, total } = buildRenderGraph({ eff, hasAudio: true, vf: 'crop=1:1:0:0' });
  assert.deepEqual(inputs.filter((x) => x !== '__SRC__' && x !== '-i'), ['-ss', '100.000', '-t', '5.000', '-ss', '0.000', '-t', '20.000']);
  assert.equal(total, 5 + 4 + 4 + 9);
  assert.match(graph, /\[0:v\]setpts=PTS-STARTPTS,fps=30\[v0\]/);
  assert.match(graph, /\[1:v\]fps=30,select='gte\(t,0.000\)\*lt\(t,4.000\)\+gte\(t,5.000\)\*lt\(t,9.000\)\+gte\(t,11.000\)\*lt\(t,20.000\)',setpts=N\/\(30\*TB\)\[v1\]/);
  assert.match(graph, /\[1:a\]aresample=44100,aselect='/);
  assert.match(graph, /concat=n=2:v=1:a=1\[vc\]\[aout\];\[vc\]crop=1:1:0:0\[vout\]$/);
  // 제거된 시간만큼 자막 타임라인도 줄어든다
  const ass = buildAss({ clip: { segments: eff, title: '' }, tpl: sanitize({}), subs: [{ start: 8, end: 12, text: '걸침' }] });
  // 타임라인: 0~5(구간0) 5~9(0~4) 9~13(5~9) 13~22(11~20). 원본 8~12초 자막은 8~9→12~13, 11~12→13~14로 나뉜다
  assert.match(ass, /Dialogue: 1,0:00:12.00,0:00:13.00,Sub,,0,0,0,,[^\n]*걸침/);
  assert.match(ass, /Dialogue: 1,0:00:13.00,0:00:14.00,Sub,,0,0,0,,[^\n]*걸침/);
});

test('소주제: 발화 경계로 맞추고 겹침·너무 짧은 구간 제거, 가치 높은 순으로 선택', () => {
  const transcript = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 4.5, text: 'x' }));
  const raw = [
    { title: '두 번째 주제', summary: '', start: 100.8, end: 200.2, score: 60 },
    { title: '첫 주제', summary: 's', start: 1, end: 99, score: 90 },
    { title: '앞과 겹치는 주제', summary: '', start: 150, end: 160, score: 80 },
    { title: '너무 짧음', summary: '', start: 250, end: 254, score: 99 },
    { title: '', summary: '', start: 260, end: 290, score: 50 },
  ];
  const topics = normalizeTopics(raw, { transcript, duration: 300 });
  assert.deepEqual(topics.map((t) => [t.id, t.title, t.start, t.end]), [[1, '첫 주제', 0, 99.5 - 0.0], [2, '두 번째 주제', 100, 199.5]].map((x) => x));
  assert.ok(topics.every((t, i) => i === 0 || t.start >= topics[i - 1].end)); // 겹치지 않음
  assert.deepEqual(pickTopics(topics, { count: 1, minLen: 30 }).map((t) => t.id), [1]); // 점수 높은 순
  assert.deepEqual(pickTopics(topics, { count: 5, minLen: 30 }).map((t) => t.id), [1, 2]); // 시간 순서로 반환
});

test('소주제별 쇼츠: 소주제 범위 밖 구간은 제거, 소주제 하나에 쇼츠 하나, 편집 노트 보존', () => {
  const transcript = Array.from({ length: 80 }, (_, i) => ({ start: i * 5, end: i * 5 + 4.5, text: 'x' }));
  const topics = [{ id: 1, title: 'A', start: 0, end: 100, summary: '' }, { id: 2, title: 'B', start: 100, end: 200, summary: '' }];
  const mk = (topic_id, segments, score) => ({ topic_id, segments, title: 't', score, rationale: ` 이유${topic_id} ` });
  const out = normalizeClips([
    mk(1, [{ start: 150, end: 160, role: 'hook', note: '다른 소주제의 장면' }, { start: 10, end: 45, role: 'body', note: '본론 설명' }], 90), // 150~160은 소주제 밖 → 제거
    mk(1, [{ start: 50, end: 80, role: 'body', note: '' }], 80), // 같은 소주제 두 번째 쇼츠 → 제외
    mk(2, [{ start: 120, end: 150, role: 'body', note: '' }], 70),
    mk(9, [{ start: 0, end: 30, role: 'body', note: '' }], 99), // 없는 소주제 → 제외
  ], { transcript, duration: 400, minLen: 30, maxLen: 60, topics });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.topicId), [1, 2]);
  assert.deepEqual(out[0].segments.map((g) => [g.start, g.end, g.role, g.note]), [[10, 44.5, 'body', '본론 설명']]);
  assert.deepEqual([out[0].topic, out[0].topicRange], ['A', [0, 100]]);
  assert.equal(out[0].rationale, '이유1');
  assert.ok(out.every((c) => c.segments.every((g) => g.start >= c.topicRange[0] && g.end <= c.topicRange[1])));
  // 데모 모드도 같은 규칙을 만족한다
  const mt = mockTopics(120, 3);
  const mc = normalizeClips(mockHighlights({ topics: mt, minLen: 30, maxLen: 60 }), { transcript: [], duration: 120, minLen: 30, maxLen: 60, topics: mt });
  assert.equal(mc.length, mt.length);
  assert.ok(mc.every((c) => c.rationale && !('feedback' in c) && c.segments.length === 2 && c.segments[0].note));
});
