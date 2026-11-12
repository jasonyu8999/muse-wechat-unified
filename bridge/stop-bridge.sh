#!/usr/bin/env bash
# 停止微信桥接守护进程。
set -euo pipefail
BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$BRIDGE_DIR/bridge.pid" ]; then
  PID="$(cat "$BRIDGE_DIR/bridge.pid")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "已停止桥接（pid $PID）"
  else
    echo "桥接未在运行（残留 pid 文件已清理）"
  fi
  rm -f "$BRIDGE_DIR/bridge.pid"
else
  echo "桥接未在运行"
fi
