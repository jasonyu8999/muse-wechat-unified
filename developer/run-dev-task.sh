#!/usr/bin/env bash
# run-dev-task.sh — 受控开发适配器（M4）：用已部署的 dsh 以 headless 模式执行一个开发任务。
#
# 用法：bash run-dev-task.sh <task-id> <workdir> <prompt-file> [timeout-secs]
#   task-id      只允许 [a-zA-Z0-9_-]+（用作目录名与结果文件名）
#   workdir      必须在白名单内：$HOME/workspace/muse-wechat-unified/developer/work/
#   prompt-file  任务描述文本文件（避免 shell 注入；内容即发给 dsh 的任务）
#   timeout-secs 默认 600，上限 1800
#
# 安全规则：
# - 每次运行换取新的 Qianwen surrogate 注入 QIANWEN_API_KEY；真实 Key 永不落盘、不进日志。
# - dsh 只写 workdir（--permission-mode workspace-write + --add-dir）；审批策略 ask，
#   高风险操作需批准，无人值守时超时即判为 needs-approval，不自动放行。
# - 产物留在 tasks/<task-id>/ 供 worker 检查；本脚本不发布、不部署、不删除、不对外发送。
# - 结果写 tasks/<task-id>/result.json + out.txt + err.txt；退出码与状态一并记录。
set -euo pipefail

TASK_ID="${1:?task-id required}"
WORKDIR_INPUT="${2:?workdir required}"
PROMPT_FILE="${3:?prompt-file required}"
TIMEOUT_SECS="${4:-600}"

DEV_ROOT="$HOME/workspace/muse-wechat-unified/developer"
WORK_ROOT="$DEV_ROOT/work"
TASKS_DIR="$DEV_ROOT/tasks"
DSH_DIR="$HOME/workspace/dsh"
PATCH="$DSH_DIR/qianwen.patch.yml"

# --- 校验 task-id ---
if [[ ! "$TASK_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "task-id 非法（只允许字母数字 _ -）: $TASK_ID" >&2
  exit 2
fi

# --- 校验 workdir 在白名单内 ---
WORKDIR="$(realpath -m "$WORKDIR_INPUT")"
case "$WORKDIR" in
  "$WORK_ROOT"/*) ;;
  *) echo "workdir 不在白名单内（必须是 $WORK_ROOT/...）: $WORKDIR" >&2; exit 2 ;;
esac
mkdir -p "$WORKDIR"

# --- 校验 prompt 文件 ---
if [ ! -f "$PROMPT_FILE" ]; then
  echo "prompt 文件不存在: $PROMPT_FILE" >&2
  exit 2
fi
PROMPT="$(cat "$PROMPT_FILE")"
if [ -z "${PROMPT// /}" ]; then
  echo "prompt 为空" >&2
  exit 2
fi

# --- 校验 timeout ---
if ! [[ "$TIMEOUT_SECS" =~ ^[0-9]+$ ]] || [ "$TIMEOUT_SECS" -gt 1800 ]; then
  echo "timeout 非法（默认 600，上限 1800）: $TIMEOUT_SECS" >&2
  exit 2
fi

TASK_DIR="$TASKS_DIR/$TASK_ID"
mkdir -p "$TASK_DIR"
OUT_FILE="$TASK_DIR/out.txt"
ERR_FILE="$TASK_DIR/err.txt"
RESULT_FILE="$TASK_DIR/result.json"

# --- 换取新的 surrogate（真实 Key 永不落盘） ---
export QIANWEN_API_KEY="$(
  "$HOME/workspace/muse-wechat-unified/.venv/bin/python" - <<'PYEOF'
import sys
sys.path.insert(0, '/opt/muse/skills/custom-connector-setup/bin')
from dynamic_credentials import dynamic_credential_entry
print(dynamic_credential_entry('custom.qianwen')['surrogate'])
PYEOF
)"
if [ -z "$QIANWEN_API_KEY" ]; then
  echo "无法换取 Qianwen 凭据 surrogate" >&2
  exit 3
fi

START_MS="$(date +%s%3N)"
cd "$WORKDIR"
set +e
timeout "$TIMEOUT_SECS" "$DSH_DIR/node_modules/.bin/dsh" headless \
  --patch "$PATCH" \
  --permission-mode workspace-write \
  --add-dir "$WORKDIR" \
  --approval-policy ask \
  "$PROMPT" > "$OUT_FILE" 2> "$ERR_FILE"
EXIT_CODE=$?
set -e
END_MS="$(date +%s%3N)"
DURATION_MS=$((END_MS - START_MS))

STATUS="ok"
if [ "$EXIT_CODE" -eq 124 ]; then
  STATUS="timeout"
elif [ "$EXIT_CODE" -ne 0 ]; then
  STATUS="error"
fi
# 审批超时/等待的特征：dsh 在 err 里提示需要批准。
if grep -qiE "approval|needs approval|permission" "$ERR_FILE" 2>/dev/null; then
  STATUS="needs_approval"
fi

# --- 写结果（不含任何凭据） ---
python3 - "$RESULT_FILE" <<PYEOF
import json
result = {
    "taskId": "$TASK_ID",
    "status": "$STATUS",
    "exitCode": $EXIT_CODE,
    "durationMs": $DURATION_MS,
    "workdir": "$WORKDIR",
    "model": "qianwen-maas/deepseek-v4.1-flash",
    "promptFile": "$PROMPT_FILE",
    "outputFile": "$OUT_FILE",
    "errorFile": "$ERR_FILE",
}
with open("$RESULT_FILE", "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
PYEOF

echo "task $TASK_ID: status=$STATUS exit=$EXIT_CODE duration=${DURATION_MS}ms"
echo "result: $RESULT_FILE"
[ "$STATUS" = "ok" ] && exit 0 || exit 1
