# OPERATIONS.md — 运维手册

> 桥接状态：已上线（2026-11-12 18:02 登录，18:03 首条真实消息通过）。

## 架构速览

```
微信（Owner 私聊） ⇄ iLink（ilinkai.weixin.qq.com）
  ⇄ bridge.mjs（守护进程：长轮询 + outbox 发送）
  ⇄ 文件队列（queue/pending → processing → done/failed；outbox/ → sent/failed）
  ⇄ Hook wechat-tasks-watch（每 15 秒检测 pending，有任务则 wake）
  ⇄ Beacon worker 回合（认领、执行、写 outbox）
```

## 日常命令

```bash
cd ~/workspace/muse-wechat-unified/bridge
node bridge.mjs status        # 登录态、Owner、进程、队列积压
bash start-bridge.sh          # 启动守护进程（后台）
bash stop-bridge.sh           # 停止守护进程
node bridge.mjs logout        # 退出登录并清除绑定（谨慎：需重新扫码）
```

## 日志与状态

- `bridge/logs/bridge.log` — 结构化 JSONL（无 token、无正文）；`task queued` / `outbox sent` 是关键行。
- `bridge/data/chatlog.md` — 微信对话记录（用户/我，按时间）。
- `bridge/data/send-ledger.json` — 发送账本（intent → sent；unknown 不自动重发）。
- `bridge/data/heartbeat` — 桥接心跳（每 5 秒刷新；超过 60 秒未刷新即异常）。
- `~/hooks/logs/wechat-tasks-watch.jsonl` — Hook 每次轮询的判决（silent/wake）。
- `bridge/data/unknown-senders.json` — 被白名单挡下的发信人（只记 id/次数，不记内容）。

## 健康检查

```bash
node bridge.mjs status
# 期望：loggedIn true，running true，heartbeatAgeSec < 10，pending/processing 为小数字
```

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 桥接进程不在了 | `bash bridge/watchdog.sh`（先确认已登录；未登录时不做任何事）或 `systemctl restart wechat-bridge`；看门狗 timer 每 15 分钟自动检查 |
| 改了 bridge.mjs 要重启 | 一律走 `bash scripts/restart-bridge.sh`：先 `node --check`、自动备份、再重启验活；**不要直接 systemctl restart**（18:31 未检查语法的改动导致 3 次启动失败、StartLimit 熄火 10 分钟） |
| 微信发消息没回 | ① `status` 看 running 与 heartbeat；② `queue/pending/` 是否有积压；③ hook 日志是否 wake；④ `logs/bridge.log` 找错误 |
| 登录过期（token expired / -14 持续 1 小时） | 重新 `node bridge.mjs login` 扫码；过期只通知一次，不反复打扰 |
| outbox/failed 里有文件 | 看 `data/send-ledger.json` 与日志；确认网络与 token 后可把文件移回 `outbox/` 重发（同一 client_id 不会重复投递） |
| processing 里有超 10 分钟的任务 | 桥接会自动回收回 pending；若反复出现，检查 worker 是否卡住 |
| VM 更换/重启后 | 桥接与 dsh 都要重新启动（`start-bridge.sh` + `~/workspace/dsh/start-web.sh`）；apt 装的工具需重跑 `scripts/install-media-tools.sh`；home 下的文件与登录态保留 |
| Hook 一直 silent | 正常——无任务时就该 silent；放一个测试任务文件能 wake 即正常 |

## 审批说明（实测结论）

- 桥接发往微信的消息（outbox → sendMessage）**不触发审批卡片**：它是守护进程的 SDK 调用，不是智能体直接发消息。
- Worker 回合内的 HIGH 操作（对外发送、发布、删除、付费、敏感导出）仍走正常审批；无人值守时不自动放行，改为写一条请用户确认的消息到 outbox。
- 首次真实消息的回复全程无审批卡片，13 秒完成。

## 2026-11-12 故障：systemd 迁移后长轮询全失败（已修复）

**现象**：18:08 起用户在微信发的消息全部收不到（VPN 开/关都一样）；18:03 的首条消息正常。
**根因**：桥接从 nohup 迁到 systemd 后，服务环境里没有出口代理变量（HTTP(S)_PROXY、NODE_USE_ENV_PROXY=1）。VM 出口必须走代理，Node fetch 直连失败，getUpdates 从 18:07:59 起全部 `fetch failed`（36 次错误，0 次成功轮询）。
**修复**：`scripts/setup-systemd.sh` 从当前 shell 环境生成 `/run/hatch/wechat-bridge.env`（0600，tmpfs，凭据不进持久文件），unit 加 `EnvironmentFile=-/run/hatch/wechat-bridge.env`，重启服务。验证：60 秒内 0 新错误，sync buf 时间戳推进，用户 18:15:44 起的测试消息全部进队并陆续回复。
**教训**：systemd 服务的环境是干净的，不继承 shell；任何需要代理的服务都必须显式配环境文件。VM 更换后重跑 `scripts/setup-systemd.sh`（unit 在 /etc、env 文件在 /run，都会丢）。

## 2026-11-12 自我优化与引用验证（18:45–18:50，用户要求）

**内存/CPU**：桥接常驻 RSS 约 47MB、9 小时 CPU 不到 1 秒，已够 lean；unit 加 `MemoryMax=512M` + `--max-old-space-size=256`（防泄漏的安全阀）。dsh web 空闲占 RSS 约 232MB、9 小时仅 13 秒 CPU，已停（开发任务走无头 dsh 不受影响；想用网页版时 `bash ~/workspace/dsh/start-web.sh`）。主机层 `free` 显示已用 7.3GB 是运行时/宿主侧占用，不在本单元控制内；本单元自己的进程合计约 250MB RSS。

**不断联**：桥接与用户手机 VPN 无关——出口走本机沙箱代理（`NODE_USE_ENV_PROXY=1` + `/run/hatch/wechat-bridge.env`），VPN 开关只影响用户自己的手机网络。加固：`StartLimitBurst` 3→5/600s；看门狗落实为 systemd timer `wechat-bridge-watchdog.timer`（每 15 分钟；之前文档写的 cron 在本机实际不存在——无 crontab、无 timer、无注册记录，marker 文件从未生成）；`scripts/restart-bridge.sh` 强制先语法检查再重启，改动前自动备份到 `bridge/backups/`。验证：18:48 重启后 pid 16203、心跳 9 秒、sync buf 续接、0 错误；且 18:42 的重启已证明持久化 context_token 生效——重启后无需新入站消息即可发信。

**引用**：18:43 带 `ref_msg` 的回复服务端返回成功，但用户微信里不显示引用气泡；与项目 A/B 笔记的通道硬限制一致——**通道不支持机器人消息的引用渲染，不是代码 bug**。兜底已上线：桥接发信时在正文前加 `回「原消息前40字」：`，`ref_msg` 照常发。详见 `KNOWN_LIMITATIONS.md`。
