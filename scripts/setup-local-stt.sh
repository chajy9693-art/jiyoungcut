#!/bin/bash
# 로컬(무료) 음성 인식 설치: whisper.cpp + 한국어 지원 모델(large-v3-turbo, 양자화 약 570MB)
set -euo pipefail
MODEL_DIR="${WHISPER_MODEL_DIR:-$HOME/.cache/jiyoungcut}"
MODEL_FILE="ggml-large-v3-turbo-q5_0.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE"

if ! command -v whisper-cli >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/whisper-cli ]; then
  command -v brew >/dev/null 2>&1 || { echo "Homebrew가 필요합니다: https://brew.sh" >&2; exit 1; }
  echo "▶ whisper.cpp 설치 중 (brew install whisper-cpp)…"
  brew install whisper-cpp
else
  echo "✔ whisper-cli 이미 설치됨"
fi

mkdir -p "$MODEL_DIR"
if [ -s "$MODEL_DIR/$MODEL_FILE" ]; then
  echo "✔ 모델 이미 있음: $MODEL_DIR/$MODEL_FILE"
else
  echo "▶ 모델 다운로드 중 (약 570MB)…"
  curl -L --fail --progress-bar -o "$MODEL_DIR/$MODEL_FILE.part" "$URL"
  mv "$MODEL_DIR/$MODEL_FILE.part" "$MODEL_DIR/$MODEL_FILE"
fi

echo
echo "✅ 로컬 음성 인식 준비 완료."
echo "   서비스로 실행 중이면 반영을 위해: npm run service:install"
