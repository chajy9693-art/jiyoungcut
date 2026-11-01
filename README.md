# jiyoungcut

롱폼 영상을 업로드하면 AI가 하이라이트 구간을 골라 **9:16 쇼츠(MP4)** 로 만들어 주는 웹앱입니다. (알파컷 스타일 MVP)

## 기능

| 단계 | 내용 |
|---|---|
| 업로드 | MP4/MOV/MKV/WEBM 업로드, 영상 검증, 썸네일·미리보기용 프록시 생성 |
| AI 분석 | ffmpeg로 오디오 분할 → OpenAI Whisper로 음성 인식(STT) → Claude가 전사본에서 하이라이트 구간·제목·설명·해시태그 선정 |
| 편집기 | 추천 구간 목록, 9:16 실시간 미리보기, 타임라인 컷 편집(시작/종료), 크롭 위치 드래그, 자막 텍스트 수정/삭제/추가, 제목 오버레이 |
| 템플릿 | 템플릿 설정 화면에서 이름·**하단 계정명**·레이아웃(전체화면/프레임+배경색)·제목 색/크기·자막 스타일을 여러 개 저장하고, 쇼츠마다 선택 |
| 출력 | 1080×1920 MP4 렌더링(크롭 + 자막/제목 번인), 다운로드 |

미구현(다음 단계): 유튜브 URL 입력, 화자 추적·스마트 크롭, 무음 제거, 배속, 배경음악, 다국어 번역, SNS 발행.

## 실행

필요: Node.js 22.9+, ffmpeg(libass 포함), ffprobe

```bash
npm install
cp .env.example .env   # OPENAI_API_KEY, ANTHROPIC_API_KEY 입력
npm start              # http://localhost:3000
```

- `OPENAI_API_KEY` — 음성 인식에 필수
- `ANTHROPIC_API_KEY` — 없으면 발화 밀도 기반 단순 규칙으로 하이라이트를 선정(품질 낮음)
- API 키 없이 UI/렌더링만 확인: `MOCK_AI=1 npm start` (가짜 자막·균등 분할 구간)

## 구조

```
server/  index.js(API) · ai.js(Whisper/Claude) · ffmpeg.js · ass.js(자막 번인) · subtitles.js · store.js
public/  index.html · style.css · app.js (빌드 없는 바닐라 JS)
data/    프로젝트별 원본/결과 (git 제외)
```

## 참고

- 영상은 서버에 저장되고 외부 AI에는 **오디오(저비트레이트 mp3)와 전사 텍스트만** 전송됩니다.
- 렌더링은 한 번에 하나씩 순차 처리됩니다. 인증/결제/멀티유저는 없습니다(로컬·개인용).
- 미리보기와 결과물의 자막 모양은 거의 같지만 픽셀 단위로 동일하지는 않습니다.
