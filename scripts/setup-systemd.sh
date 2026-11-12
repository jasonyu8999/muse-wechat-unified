#!/usr/bin/env bash
# setup-systemd.sh — 把微信桥接注册为 systemd 服务（可重复执行）。
#
# 背景：VM 的出口必须走代理（HTTP(S)_PROXY + NODE_USE_ENV_PROXY=1），这些变量由
# 运行时注入每个 shell 会话，systemd 服务的环境里默认没有。直接用 unit 跑桥接，
# 它的 fetch 会全部失败（2026-11-12 实测：迁移到 systemd 后 getUpdates 全失败）。
# 做法：从当前 shell 环境生成 /run/hatch/wechat-bridge.env（0600，tmpfs，重启即失），
# unit 用 EnvironmentFile=- 读它；凭据不写进任何持久文件。
# VM 更换后重跑本脚本即可（同时重装 unit、重生成 env 文件、重拉起服务）。
set -euo pipefail
BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bridge"
ENV_FILE="/run/hatch/wechat-bridge.env"
UNIT_SRC="$BRIDGE_DIR/wechat-bridge.service"
UNIT_DST="/etc/systemd/system/wechat-bridge.service"

mkdir -p /run/hatch
# 只写代理相关变量；值来自当前 shell 环境（运行时注入），不回显、不记日志。
{
  for v in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NODE_USE_ENV_PROXY NO_PROXY no_proxy; do
    if [ -n "${!v:-}" ]; then
      printf '%s=%s\n' "$v" "${!v}"
    fi
  done
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "env file written: $ENV_FILE ($(wc -l < "$ENV_FILE") vars, no values printed)"

cp "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable --now wechat-bridge
echo "service enabled and started"
systemctl status wechat-bridge --no-pager | head -6
