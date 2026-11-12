#!/usr/bin/env bash
# watchdog.sh — 检查微信桥接是否存活，死了才拉起（最多每 15 分钟一次）。
# 只做本地检查与启动；无登录态时不做任何事；不发消息、不改配置。
set -euo pipefail
BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$BRIDGE_DIR/bridge.pid"
MARKER="$BRIDGE_DIR/data/watchdog-restarted"
STATE_DIR="$BRIDGE_DIR/state"

# 无登录态：桥接本来就不该跑，什么都不做。
if [ ! -d "$STATE_DIR/openclaw-weixin" ] || [ -z "$(ls -A "$STATE_DIR/openclaw-weixin" 2>/dev/null)" ]; then
  echo "no login state; nothing to do"
  exit 0
fi

# 进程还活着：什么都不做。
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "bridge alive (pid $(cat "$PID_FILE"))"
  exit 0
fi

# 15 分钟内已拉起过一次：避免重启风暴。
if [ -f "$MARKER" ] && [ $(( $(date +%s) - $(stat -c %Y "$MARKER") )) -lt 900 ]; then
  echo "restarted recently; skipping"
  exit 0
fi

echo "bridge down; restarting"
if systemctl cat wechat-bridge >/dev/null 2>&1; then
  # 桥接由 systemd 管理：用 systemctl 重启（unit 自带代理环境文件）。
  systemctl restart wechat-bridge
else
  # 未注册 systemd 时的兜底：nohup 启动（继承调用方 shell 的代理环境）。
  bash "$BRIDGE_DIR/start-bridge.sh"
fi
touch "$MARKER"
sleep 5
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "bridge restarted (pid $(cat "$PID_FILE"))"
  exit 0
else
  echo "bridge restart FAILED" >&2
  exit 1
fi
