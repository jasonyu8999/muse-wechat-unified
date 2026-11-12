#!/usr/bin/env bash
# 启动微信桥接守护进程（需先 login 扫码绑定）。
# 用法: bash start-bridge.sh   （后台运行；日志见 logs/bridge.log）
set -euo pipefail
BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export OPENCLAW_STATE_DIR="$BRIDGE_DIR/state"
export PATH="$HOME/.local/bin:$PATH"
cd "$BRIDGE_DIR"
if [ -f bridge.pid ] && kill -0 "$(cat bridge.pid)" 2>/dev/null; then
  echo "桥接已在运行（pid $(cat bridge.pid)）"
  exit 0
fi
nohup /usr/bin/node "$BRIDGE_DIR/bridge.mjs" run >> "$BRIDGE_DIR/logs/bridge.log" 2>&1 &
echo "桥接已启动（pid $!），日志：$BRIDGE_DIR/logs/bridge.log"
