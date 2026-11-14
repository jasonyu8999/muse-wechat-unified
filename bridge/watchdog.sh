#!/usr/bin/env bash
# watchdog.sh — 检查微信桥接是否存活，死了才拉起；同时补齐 dsh 与 systemd。
# 触发：看门狗 cron（5 分钟）、systemd 定时器（5 分钟）或 hook（60 秒）。
# 只做本地检查与启动；无登录态时不做任何事；不发消息、不改配置。
#
# 防抖：同一台机子（同一个启动）15 分钟内只拉起一次，避免重启风暴。
# 换机后防抖自动失效：标记文件的修改时间早于本次启动时间，说明是上一台
# 机子留下的（2026-11-13 06:52 曾因此漏掉一次恢复）。
#
# VM 更换会清空 /etc 与全部进程：本脚本在 unit/定时器缺失时重装它们，
# 并在 dsh 没监听时重拉 dsh（dsh 取凭据需要 agent 环境，hook 里不做这步）。
set -euo pipefail
BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$BRIDGE_DIR")"
PID_FILE="$BRIDGE_DIR/bridge.pid"
MARKER="$BRIDGE_DIR/data/watchdog-restarted"
STATE_DIR="$BRIDGE_DIR/state"
DSH_DIR="$HOME/workspace/dsh"
TIMER_SRC="$BRIDGE_DIR/wechat-bridge-watchdog.timer"
TIMER_SERVICE_SRC="$BRIDGE_DIR/wechat-bridge-watchdog.service"

log() { echo "[watchdog $(date '+%H:%M:%S')] $*"; }

# 无登录态：桥接本来就不该跑，什么都不做。
if [ ! -d "$STATE_DIR/openclaw-weixin" ] || [ -z "$(ls -A "$STATE_DIR/openclaw-weixin" 2>/dev/null)" ]; then
  log "no login state; nothing to do"
  exit 0
fi

# 本次启动时间（秒）。标记文件比它旧，说明是上一台机子留下的，防抖失效。
BOOT_EPOCH="$(awk '/^btime/{print $2}' /proc/stat)"
NOW="$(date +%s)"

bridge_alive() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

# ---- 1. 桥接 ----
if bridge_alive; then
  log "bridge alive (pid $(cat "$PID_FILE"))"
else
  # 同一台机子 15 分钟内已拉起过一次：避免重启风暴。
  if [ -f "$MARKER" ] && [ "$(stat -c %Y "$MARKER")" -ge "$BOOT_EPOCH" ] && [ $(( NOW - $(stat -c %Y "$MARKER") )) -lt 900 ]; then
    log "restarted recently on this boot; skipping"
  else
    log "bridge down; restarting"
    STARTED_BY_SETUP=0
    if [ ! -f /etc/systemd/system/wechat-bridge.service ]; then
      # VM 更换会清空 /etc：重装 unit（含代理环境文件）并拉起服务。
      if bash "$PROJECT_DIR/scripts/setup-systemd.sh" >> "$BRIDGE_DIR/logs/bridge.log" 2>&1; then
        STARTED_BY_SETUP=1
      else
        log "setup-systemd.sh failed; falling back to nohup"
      fi
    fi
    if [ "$STARTED_BY_SETUP" -eq 0 ]; then
      if [ -f /etc/systemd/system/wechat-bridge.service ]; then
        systemctl restart wechat-bridge 2>/dev/null || bash "$BRIDGE_DIR/start-bridge.sh"
      else
        bash "$BRIDGE_DIR/start-bridge.sh"
      fi
    fi
    touch "$MARKER"
    sleep 5
    if bridge_alive; then
      log "bridge restarted (pid $(cat "$PID_FILE"))"
    else
      log "bridge restart FAILED" >&2
      exit 1
    fi
  fi
fi

# ---- 2. 看门狗定时器（VM 更换会清空 /etc；与源文件不一致就重装）----
if ! cmp -s "$TIMER_SRC" /etc/systemd/system/wechat-bridge-watchdog.timer 2>/dev/null \
   || ! cmp -s "$TIMER_SERVICE_SRC" /etc/systemd/system/wechat-bridge-watchdog.service 2>/dev/null; then
  cp "$TIMER_SRC" "$TIMER_SERVICE_SRC" /etc/systemd/system/ 2>/dev/null || true
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable --now wechat-bridge-watchdog.timer 2>/dev/null || true
  log "watchdog timer reinstalled"
fi

# ---- 3. dsh（开发用 web 服务；401 说明在监听）。后台拉起，不阻塞。
if curl -s -o /dev/null --max-time 5 http://127.0.0.1:3080/ 2>/dev/null; then
  log "dsh up"
else
  log "dsh down; restarting in background"
  nohup bash "$DSH_DIR/start-web.sh" >> "$DSH_DIR/dsh-web.log" 2>&1 &
  log "dsh restart launched"
fi

exit 0
