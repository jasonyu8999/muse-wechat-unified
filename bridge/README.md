# Bridge — 微信桥接（M1）

> 状态：代码完成并通过验证；**未登录**。登录二维码需用户确认后才生成。

## 目录

- `bridge.mjs` — 守护进程 + 登录 CLI（`login | run | status | logout`）
- `config.json` — 运行时配置（ownerId 在绑定时写入）
- `state/` — 微信登录态（OPENCLAW_STATE_DIR，0600/0700，永不提交）
- `queue/pending|processing|done|failed|quarantine/` — 任务队列（JSON 文件）
- `outbox/` + `outbox/sent|failed/` — 待发/已发/失败的回复
- `media/inbound|outbound/` — 入站/出站媒体（按任务隔离）
- `data/` — chatlog.md、seen.json（去重）、send-ledger.json（幂等账本）、unknown-senders.json、heartbeat
- `logs/bridge.log` — 结构化脱敏日志（无 token、无正文）
- `start-bridge.sh` / `stop-bridge.sh` — 启动/停止脚本
- `wechat-bridge.service` — systemd 单元文件（注册待 M5 验证）

## 操作

```bash
# 1. 登录（需用户确认后执行；二维码约 5 分钟有效）
node bridge.mjs login

# 2. 启动守护进程
bash start-bridge.sh

# 3. 状态
node bridge.mjs status

# 4. 停止
bash stop-bridge.sh

# 5. 退出登录（清除登录态与绑定）
node bridge.mjs logout
```

## 唤醒链路

Hook `wechat-tasks-watch`（`~/hooks/scripts/wechat-tasks-watch.sh`，每 15 秒）检测 `queue/pending/`，
有任务时 wake worker；worker 按 `docs/WORKER_CONTRACT.md` 认领、执行、写 outbox；
桥接进程每 5 秒扫描 outbox 并发回微信。

## 已验证（2026-11-12）

- SDK 构建通过（`transport/dist/bot.js` 导出 Bot/isLoggedIn/login/logout/start）
- `bridge.mjs status` 正常（未登录、队列全空）
- SDK 传输冒烟：`startWeixinLoginWithQr` 成功签发二维码（已丢弃，未出示、未保存）
- Hook：空队列 silent、放测试任务 wake（payload 正确），dry-run 通过，已启用
