# TEST_REPORT.md — 测试报告

> 更新：2026-11-12 18:03。判定：PASS（已实测）/ FAIL / BLOCKED / NOT TESTED。
> 每项附证据（文件路径/日志行/时间戳），不凭印象。

## M1 核心桥接 — 首次真实消息测试 PASS

| 检查点 | 结果 | 证据 |
| --- | --- | --- |
| 登录（扫码绑定） | PASS | 2026-11-12 18:02，`bridge.mjs login` 返回 LOGIN_OK；accountId `754159d8a4bb-im-bot`；Owner 绑定完成；`bridge.mjs status` 显示 loggedIn: true |
| 桥接守护进程启动 | PASS | pid 8190；`[weixin] monitor started (https://ilinkai.weixin.qq.com, account=754159d8a4bb-im-bot)`；心跳每 5 秒刷新 |
| 入站：微信 → 队列 | PASS | 18:03:23.283Z `task queued`，id `wx-mwddr2mq-548694`，textLen 6，内容“你好，你是谁”；文件 `queue/done/wx-mwddr2mq-548694.json` |
| Hook 唤醒 | PASS | hook 日志 1 次 `outcome: wake, reason: wechat-tasks-pending`（`~/hooks/logs/wechat-tasks-watch.jsonl`） |
| Worker 执行并写 outbox | PASS | worker 回复“你好，我是 Beacon，Jason 的个人助手。现在通过微信和你连通了……”；`outbox/sent/wx-mwddr2mq-548694.json` |
| 出站：outbox → 微信 | PASS | 18:03:36.300Z `outbox sent`；账本 `data/send-ledger.json` 记 `wx-mwddr2mq-548694: sent` |
| 端到端耗时 | 13.0 秒 | 入队 18:03:23.283 → 发出 18:03:36.300（含 Hook 15 秒轮询 + worker 执行） |
| 用户在微信里实际看到回复 | 待用户确认 | API 层成功 ≠ 用户收到；请用户在微信确认 |

补充：用户在微信还应收到一条即时回执“收到，正在处理…”（SDK 的 Agent 返回，18:03:23 前后发出），随后是正式回复。

## M0 环境审计 — 全部通过

见 `docs/ENVIRONMENT_AUDIT.md`（17 项）。iLink 连通性、Hook 机制、记忆共享机制、Harness 接口、媒体工具均已实测。

## M2 共享记忆 — A/B 测试 NOT TESTED（登录后可执行）

见 `docs/MEMORY_SYNC_SPEC.md` §6。测试协议已写好（A1/A2/B1/B2/B3），消息链路已通，可随时执行。

## M3 格式能力 — 本地实测通过，Send 列部分待测

见 `docs/FORMAT_CAPABILITY_MATRIX.md`。15 种格式的本地解析/转换/生成已验证；**文本消息发送已验证**（本次测试）；图片/文件/视频的回传发送尚未实测。

## M4 开发适配器 — 骨架验证通过

见 `developer/README.md`。测试任务 test-hello：status ok，14.3 秒，hello.txt 内容准确。

## 工具安装 — 全部通过

见 `docs/TOOLS_INVENTORY.md`。apt 工具、typst/tectonic、venv Python 库均已冒烟测试通过。

## v0.2 第一批修复 — 代码已改 + 单元测试通过，待真机发送验证

见 `docs/KNOWN_LIMITATIONS.md` 末节。2026-11-12 19:45，用户确认先修最危险的三项：

| 修复 | 代码 | 验证 |
| ---- | ---- | ---- |
| 发送账本：稳定 client_id + 错误分类 + 分段投递状态 | `bridge/send-policy.mjs`、`bridge/bridge.mjs`（`processOutbox`）、SDK `send.ts` / `send-media.ts` / `bot.ts`（clientIds 透传、parts 回传、上传失败标记） | `node --test bridge/send-policy.test.mjs` 6/6 通过；`node --check bridge/bridge.mjs` 通过；SDK `tsc --noEmit` 通过，`transport/dist` 已重建并核对含新代码 |
| 去重改用 msg_id，内容哈希仅作 30 秒兜底 | `bridge/send-policy.mjs`（`dedupKeyForRequest`）、`bridge/bridge.mjs`（`makeAgent.chat`） | 同上（单元测试覆盖 msg_id / 兜底 / TTL） |
| 出站 mediaPath 白名单（仅 `bridge/media/outbound/`，解析符号链接） | `bridge/send-policy.mjs`（`checkOutboundPath`）、`bridge/bridge.mjs`（`processOutbox` 发送前校验） | 同上（单元测试覆盖根目录内 / 根目录外 / 符号链接逃逸 / 不存在文件） |

真机验证：桥接重启后以一条真实微信通知验证新发送路径（见下一次更新）。
