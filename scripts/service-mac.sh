#!/bin/bash
# macOS 백그라운드 서비스(LaunchAgent) 등록/해제
# - 터미널을 닫아도 서버가 계속 실행되고, 로그인 시 자동 시작, 비정상 종료 시 자동 재시작됩니다.
# 사용법: scripts/service-mac.sh install | uninstall | status | logs
set -euo pipefail

LABEL="com.jiyoungcut.app"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/jiyoungcut.log"
DOMAIN="gui/$(id -u)"
PORT="${PORT:-3000}"

# 서비스를 내리고 완전히 내려갈 때까지 대기
stop_service() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || return 0
    sleep 1
  done
}

make_plist() {
  local node_bin
  node_bin="$(command -v node || true)"
  if [ -z "$node_bin" ]; then echo "node를 찾을 수 없습니다. Node.js를 먼저 설치하세요." >&2; exit 1; fi
  # launchd는 PATH가 최소라서 Homebrew의 ffmpeg 경로를 직접 넣어 준다
  local ffmpeg_dir=""
  if command -v ffmpeg >/dev/null 2>&1; then ffmpeg_dir="$(dirname "$(command -v ffmpeg)")"; fi
  local mock=""
  if [ "${MOCK_AI:-}" = "1" ]; then mock='<key>MOCK_AI</key><string>1</string>'; fi
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>--env-file-if-exists=.env</string>
    <string>server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${ffmpeg_dir:+$ffmpeg_dir:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>PORT</key><string>$PORT</string>
    $mock
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
}

case "${1:-}" in
  print) make_plist ;;  # 설치 없이 생성될 설정만 출력 (확인용)
  install)
    [ "$(uname)" = "Darwin" ] || { echo "macOS 전용 스크립트입니다." >&2; exit 1; }
    command -v ffmpeg >/dev/null 2>&1 || echo "⚠ ffmpeg를 찾지 못했습니다. 설치 후 다시 실행하세요: brew install homebrew-ffmpeg/ffmpeg/ffmpeg"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    stop_service
    make_plist > "$PLIST"
    # 직전에 내린 서비스가 아직 정리 중이면 bootstrap이 "Input/output error"로 실패하므로 재시도한다
    ok=""
    for i in 1 2 3 4 5 6; do
      if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then ok=1; break; fi
      sleep 2
    done
    if [ -z "$ok" ]; then
      echo "❌ 등록에 실패했습니다. 아래 오류를 알려 주세요:" >&2
      launchctl bootstrap "$DOMAIN" "$PLIST" >&2 || true
      exit 1
    fi
    launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    echo "✅ 등록 완료: http://localhost:$PORT"
    echo "   터미널을 닫아도 계속 실행되고, 맥에 로그인하면 자동으로 시작됩니다."
    echo "   로그 보기: npm run service:logs   /   해제: npm run service:uninstall"
    ;;
  uninstall)
    stop_service
    rm -f "$PLIST"
    echo "🛑 서비스를 해제했습니다. (프로젝트/영상 데이터는 그대로 남아 있습니다)"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "실행 중(등록됨): $LABEL"
      curl -fsS -o /dev/null "http://localhost:$PORT" && echo "응답 정상: http://localhost:$PORT" || echo "⚠ 등록은 되어 있으나 아직 응답이 없습니다. 로그를 확인하세요: npm run service:logs"
    else
      echo "등록되어 있지 않습니다. npm run service:install 로 등록하세요."
    fi
    ;;
  logs) touch "$LOG"; tail -n 50 -f "$LOG" ;;
  *) echo "사용법: $0 install | uninstall | status | logs"; exit 1 ;;
esac
