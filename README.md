# jiyoungcut

롱폼 영상을 업로드하면 AI가 하이라이트 구간을 골라 **9:16 쇼츠(MP4)** 로 만들어 주는 웹앱입니다. (알파컷 스타일 MVP)

## 기능

| 단계 | 내용 |
|---|---|
| 업로드 | MP4/MOV/MKV/WEBM 업로드, 영상 검증, 썸네일·미리보기용 프록시 생성 |
| AI 분석 | ffmpeg로 오디오 분할 → OpenAI Whisper로 음성 인식(STT) → Claude가 전사본의 **맥락을 이해해** 쇼츠를 구성하고 제목·설명·해시태그 생성 |
| 맥락 편집 | 구간 하나를 그냥 자르지 않고, 핵심 장면을 **후킹으로 앞에 배치** → 본론(잡담·반복·곁가지 제거) → 마무리 순으로 **여러 구간을 이어 붙임**. 분석 시 "단순 구간" 방식도 선택 가능 |
| 편집기 | 추천 구간 목록, 9:16 실시간 미리보기, 구간별 타임라인 컷 편집, 영상 구성 목록(구간 추가·삭제·순서 변경·역할 지정), 크롭 위치 드래그, 자막 텍스트 수정/삭제/추가, 제목 오버레이 |
| 템플릿 | 템플릿 설정 화면에서 **미리보기를 직접 끌어** 제목·자막·계정명(하단)의 위치를 정하고, 요소별로 **폰트(9종 번들)·크기·색·테두리(색/두께)·배경 박스(색/투명도/여백)**와 레이아웃(전체화면/프레임+배경색)을 지정해 여러 개 저장 → 쇼츠마다 선택 |
| 출력 | 1080×1920 MP4 렌더링(크롭 + 자막/제목 번인), 다운로드 |

미구현(다음 단계): 유튜브 URL 입력, 화자 추적·스마트 크롭, 무음 제거, 배속, 배경음악, 다국어 번역, SNS 발행.

## 실행

필요: Node.js 22.9+, ffmpeg(libass 포함), ffprobe

```bash
npm install
cp .env.example .env   # OPENAI_API_KEY, ANTHROPIC_API_KEY 입력
npm start              # http://localhost:3000
```

- **음성 인식(둘 중 하나)**
  - 무료·키 없음: `npm run setup:stt` — whisper.cpp와 모델(약 570MB)을 설치해 내 맥에서 직접 인식합니다. (애플 실리콘은 GPU 사용, 영상이 외부로 나가지 않음)
  - OpenAI: `.env`에 `OPENAI_API_KEY`
  - 둘 다 있으면 OpenAI를 쓰며, `STT_PROVIDER=local` 또는 `openai`로 고정할 수 있습니다.
- `ANTHROPIC_API_KEY` — 없으면 발화 밀도 기반 단순 규칙으로 하이라이트를 선정(맥락 편집 불가, 품질 낮음)
- API 키 없이 UI/렌더링만 확인: `MOCK_AI=1 npm start` (가짜 자막·균등 분할 구간)

## 터미널을 닫아도 계속 실행 (macOS)

```bash
npm run service:install     # 등록: 백그라운드 실행 + 로그인 시 자동 시작 + 비정상 종료 시 재시작
npm run service:status      # 상태 확인
npm run service:logs        # 로그 보기 (Ctrl+C로 종료)
npm run service:uninstall   # 해제
```

- 등록 후 http://localhost:3000 이 항상 열립니다. 실행 중이던 `npm start`는 먼저 `Ctrl+C`로 끄세요(포트 충돌).
- 키 없이 데모로 등록: `MOCK_AI=1 npm run service:install`. `.env`의 키를 바꾸면 `npm run service:install`을 다시 실행하세요.
- 코드를 업데이트(`git pull`)한 뒤에도 `npm run service:install`을 다시 실행하면 새 코드로 재시작됩니다.
- 로그는 `~/Library/Logs/jiyoungcut.log`에 저장됩니다.

## 구조

```
server/  index.js(API) · ai.js(Whisper/Claude) · ffmpeg.js · ass.js(자막 번인) · subtitles.js · store.js
public/  index.html · style.css · app.js (빌드 없는 바닐라 JS)
data/    프로젝트별 원본/결과 (git 제외)
```

## 참고

- 영상은 서버에 저장되고 외부 AI에는 **오디오(저비트레이트 mp3, 로컬 음성 인식 사용 시 제외)와 전사 텍스트만** 전송됩니다.
- 렌더링은 한 번에 하나씩 순차 처리됩니다. 인증/결제/멀티유저는 없습니다(로컬·개인용).
- 미리보기와 결과물의 자막 모양은 거의 같지만 픽셀 단위로 동일하지는 않습니다.
