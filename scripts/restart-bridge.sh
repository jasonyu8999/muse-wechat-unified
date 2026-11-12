#!/usr/bin/env bash
# restart-bridge.sh — 安全重启微信桥接（2026-11-12 教训：18:31 一次未做语法检查的
# 改动让服务连续 3 次启动失败、触发 StartLimit 熄火 10 分钟）。
# 流程：语法检查 -> 备份 bridge.mjs -> daemon-reload -> 重启 -> 验活（状态+心跳）。
set -euo pipefail
BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bridge"
BACKUP_DIR="$BRIDGE_DIR/backups"
mkdir -p "$BACKUP_DIR"

node --check "$BRIDGE_DIR/bridge.mjs" || {
  echo "bridge.mjs 语法检查失败，拒绝重启" >&2
  exit 1
}
echo "syntax OK"

cp "$BRIDGE_DIR/bridge.mjs" "$BACKUP_DIR/bridge.mjs.$(date +%Y%m%d-%H%M%S)"
echo "backup saved to $BACKUP_DIR"

# unit 有改动时重新安装（含代理环境文件重生成）。
if [ -f "$BRIDGE_DIR/../scripts/setup-systemd.sh" ]; then
  bash "$BRIDGE_DIR/../scripts/setup-systemd.sh" >/dev/null
fi
systemctl daemon-reload
systemctl restart wechat-bridge
sleep 5
systemctl is-active --quiet wechat-bridge || {
  echo "service not active after restart" >&2
  systemctl status wechat-bridge --no-pager | head -20 >&2
  exit 1
}
HB_AGE=$(( $(date +%s) - $(( $(cat "$BRIDGE_DIR/data/heartbeat" 2>/dev/null || echo 0) / 1000 )) ))
echo "bridge active; heartbeat age ${HB_AGE}s"
if [ "$HB_AGE" -gt 60 ]; then
  echo "WARNING: heartbeat stale (>60s), check journalctl -u wechat-bridge" >&2
  exit 1
fi
echo "restart OK"
