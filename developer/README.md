# developer/ — 受控开发适配器（M4）

用已部署的 DeepSeek Harness（`~/workspace/dsh`，Qianwen 路由，默认 deepseek-v4.1-flash）
以 headless 模式执行开发任务。**不另建第二套 Harness。**

## 结构

- `run-dev-task.sh` — 适配器入口（见下）
- `work/` — 白名单工作目录（任务只能写这里）
- `tasks/<task-id>/` — 每次运行的记录：`result.json` + `out.txt` + `err.txt`

## 用法

```bash
# 1. 写任务描述
cat > /tmp/task.txt <<'EOF'
在当前目录创建一个 hello.txt，内容只有一行：hello from dsh。不要做其他任何事。
EOF
# 2. 运行（workdir 必须在 developer/work/ 内）
bash developer/run-dev-task.sh test-hello developer/work/test-hello /tmp/task.txt
# 3. 检查结果
cat developer/tasks/test-hello/result.json
cat developer/tasks/test-hello/out.txt
```

## 安全规则

- 每次运行换取新的 Qianwen surrogate；真实 Key 永不落盘、不进日志、不进结果文件。
- dsh 只写任务的 workdir（`--permission-mode workspace-write` + `--add-dir`）；审批策略 `ask`，高风险操作无人值守时超时即判为 `needs_approval`，不自动放行。
- 本脚本不发布、不部署、不删除、不对外发送；产物留在任务目录供 worker 检查后再决定。
- 超时默认 600 秒，上限 1800 秒；workdir、task-id、prompt 均有白名单/格式校验。
- 任务流程（worker 侧）：PLAN → IMPLEMENT → TEST → REVIEW → FIX → VERIFY，每步写持久任务记录；修改生产、认证、凭据、删除数据、对外发布、付费操作须额外批准。

## 成本

默认最便宜的 deepseek-v4.1-flash；一次 headless 会话约 ¥0.08（2026-11-05 实测估算）。
