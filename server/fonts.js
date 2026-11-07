import fs from 'node:fs';
import path from 'node:path';
import { FONTS_DIR } from './config.js';

/**
 * 템플릿에서 고를 수 있는 폰트. family는 ffmpeg(libass)가 폰트를 찾는 이름,
 * bold는 ASS Bold 플래그(-1/0) — 파일 자체의 굵기와 일치시켜 인위적 굵게(합성) 처리를 피한다.
 */
export const FONT_CATALOG = [
  { id: 'pretendard-bold', label: 'Pretendard 볼드', family: 'Pretendard', bold: -1, file: 'Pretendard-Bold.otf' },
  { id: 'pretendard-xbold', label: 'Pretendard 엑스트라볼드', family: 'Pretendard ExtraBold', bold: 0, file: 'Pretendard-ExtraBold.otf' },
  // 페이퍼로지(OFL): 굵기마다 별도 파일이라 전체 이름(Paperlogy N 이름)으로 지정해야 정확한 굵기가 선택된다
  { id: 'paperlogy-5', label: '페이퍼로지 미디엄', family: 'Paperlogy 5 Medium', bold: 0, file: 'Paperlogy-5Medium.ttf' },
  { id: 'paperlogy-6', label: '페이퍼로지 세미볼드', family: 'Paperlogy 6 SemiBold', bold: 0, file: 'Paperlogy-6SemiBold.ttf' },
  { id: 'paperlogy-7', label: '페이퍼로지 볼드', family: 'Paperlogy 7 Bold', bold: 0, file: 'Paperlogy-7Bold.ttf' },
  { id: 'paperlogy-8', label: '페이퍼로지 엑스트라볼드', family: 'Paperlogy 8 ExtraBold', bold: 0, file: 'Paperlogy-8ExtraBold.ttf' },
  { id: 'paperlogy-9', label: '페이퍼로지 블랙', family: 'Paperlogy 9 Black', bold: 0, file: 'Paperlogy-9Black.ttf' },
  { id: 'black-han-sans', label: '블랙 한 산스', family: 'Black Han Sans', bold: 0, file: 'BlackHanSans_400Regular.ttf' },
  { id: 'do-hyeon', label: '도현체', family: 'Do Hyeon', bold: 0, file: 'DoHyeon_400Regular.ttf' },
  { id: 'jua', label: '주아체', family: 'Jua', bold: 0, file: 'Jua_400Regular.ttf' },
  { id: 'sunflower', label: '해바라기', family: 'Sunflower', bold: -1, file: 'Sunflower_700Bold.ttf' },
  { id: 'gaegu', label: '개구체', family: 'Gaegu', bold: -1, file: 'Gaegu_700Bold.ttf' },
  { id: 'nanum-myeongjo', label: '나눔명조 (명조체)', family: 'NanumMyeongjoExtraBold', bold: 0, file: 'NanumMyeongjo_800ExtraBold.ttf' },
  { id: 'nanum-pen', label: '나눔손글씨 펜', family: 'Nanum Pen', bold: 0, file: 'NanumPenScript_400Regular.ttf' },
  // 한글 글리프가 없는 폰트: 영문·숫자만 이 폰트로, 한글은 hangulFallback 폰트로 고정한다.
  // 라이선스상 저장소에 포함하지 않으며(.gitignore), 파일을 fonts/ 에 직접 넣었을 때만 목록에 나타난다.
  { id: 'notion-hand', label: 'NotionHand (영문·숫자 / 한글은 Pretendard)', family: 'NotionHand Community', bold: 0, file: 'NotionHand_Community.ttf', hangulFallback: 'pretendard-bold' },
];

export const DEFAULT_FONT_ID = FONT_CATALOG[0].id;
export const isFontId = (id) => FONT_CATALOG.some((f) => f.id === id);
export const fontById = (id) => FONT_CATALOG.find((f) => f.id === id) || FONT_CATALOG[0];

/** 실제로 파일이 있는 폰트만 선택지로 노출 */
export const availableFonts = () => FONT_CATALOG.filter((f) => fs.existsSync(path.join(FONTS_DIR, f.file)));

/** 브라우저 미리보기용 @font-face (같은 파일을 /fonts/ 로 제공) */
export const fontsCss = () => availableFonts()
  .map((f) => `@font-face{font-family:'jy-${f.id}';src:url('/fonts/${encodeURIComponent(f.file)}');font-display:swap;}`)
  .join('\n');
