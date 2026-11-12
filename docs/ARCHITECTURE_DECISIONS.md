# ARCHITECTURE_DECISIONS.md — M0 架构决策

> 决策日期：2026-11-12。依据：`docs/ENVIRONMENT_AUDIT.md` + 三路研究笔记（`research/project-a-notes.md`、`research/project-b-notes.md`、`research/project-c-notes.md`）+ 腾讯官方协议文档。
> 每条决策注明“为什么”与“备选为什么不用”。

## 总体架构

```
微信用户（Owner）
  ⇄ Tencent iLink（ilinkai.weixin.qq.com，官方 ClawBot 协议）
  ⇄ ILinkTransport（Node 桥接守护进程，复用 MIT 的 weixin-agent-sdk）
  ⇄ 持久化文件队列（queue/ + outbox/，租约 + 幂等账本）
  ⇄ Muse Hook（轮询脚本 wake）→ Beacon 本体 Worker（同一智能体，原生工具/记忆/文件）
  ⇄ 响应网关（桥接进程发回微信；主动推送走缓存 context_token）
        │
        └→ 受控开发适配器 → DeepSeek Harness（dsh，Qianwen 路由）→ 代码/测试/产物
Muse App/Web → 同一 Beacon → 同一份记忆、文件库与任务状态
```

核心原则：**One Muse. Multiple Interfaces. Shared Knowledge. Unified Tasks.**
微信是 Beacon 的第二个入口，不是另一个助手。

## 决策清单

### D1. 执行器：Muse 原生 Hook 优先，不用 muse-cli

- 决定：Hook 轮询脚本（`~/hooks/scripts/`）检测文件队列 → `wake` 唤醒 Beacon 本体 worker 回合；worker 用原生工具执行真实任务，结果写 outbox，由桥接进程发回微信。
- 为什么：Hook worker 与主会话是同一智能体，共享长期记忆、文件、连接器与审批路径（审计 §8–§9 已验证机制），最符合“共享 Muse”目标；项目 A 的生产 hook 是同类机制的成功实证。
- 为什么不用 muse-cli（项目 B 的路线）：muse-cli 是第三方个人项目，需导出用户 Muse 会话 cookie；微信侧接的是一个独立 Muse 对话而非 Beacon，记忆/目标/日历等能力不保证随之进入微信；用户尚未批准该方案。项目 B 的路线作为已研究备选，不采用。
- 备选：独立 daemon 常驻轮询 + 直接调模型（项目 A 的 daemon 驱动）仅作后备；裸 LLM 聊天机器人不考虑。

### D2. 传输层：复用 MIT 的 weixin-agent-sdk，桥接逻辑独立实现

- 决定：直接使用 `weixin-agent-sdk` v0.5.0（MIT，Copyright wong2），用其高层接口（`login` / `start` / `Bot.sendMessage` / Agent 接口）实现登录、长轮询、收发与图片回传；桥接的队列、认领、回执、Hook 协作逻辑自己写。
- 为什么：SDK 已实现协议全部细节（含 getUploadUrl + AES-128-ECB + CDN 上传、context_token 管理、typing、-14 处理）；MIT 许可干净。
- 红线：项目 B 的 `bridge.js`、scripts、tests、docs 均为 PolyForm Noncommercial，**一行代码、一段文字都不复制、不改写合入**；只借鉴其设计思想（见 D5–D7），并独立实现。
- 注意：项目 A 实测 `channel_version: "1.0.2"` 可用，但官方插件当前为 3.x；本桥用 SDK 默认版本声明，登录后以实测为准。

### D3. 队列：文件队列起步，不上 SQLite

- 决定：`queue/pending/` → `queue/processing/`（`mv` 原子认领）→ `queue/done/` / `queue/failed/`；回复经 `outbox/` → `outbox/sent/`。任务文件为 JSON，含 message_id、发信人、文本、媒体路径、时间戳。
- 为什么：简单、可直接检查、hook 检测脚本只需 `ls`（无需 sqlite 依赖）；项目 A 用纯 JSON 文件跑通生产；崩溃恢复靠“先落盘再推进游标 + seen 去重”。
- 演进：量上来或需复杂查询时再迁 SQLite（WAL）；接口层隔离，迁移不影响 worker 契约。
- 配套：processing 租约 10 分钟（按 ctime 判，防 mtime 乒乓），过期回收回 pending；损坏的队列文件隔离进 `queue/quarantine/` 并告警，不静默丢弃。

### D4. 驱动：桥接进程 + Hook 分离，单驱动锁

- 决定：桥接守护进程只做 iLink 长轮询收发与 outbox 发送；Hook 只做队列检测与唤醒；两者以共享锁文件互斥（同一时刻只有一个驱动在跑）。
- 为什么：与项目 A/教程的生产做法一致；进程死了不丢消息（队列在磁盘），Hook 死了看门狗能发现。
- 恢复：systemd 服务（unit 文件放项目内，注册待 M5 验证）+ 启动脚本 `scripts/start-bridge.sh`；VM 更换后由恢复检查重新拉起（M5 落实，M1 先以 nohup + 手动启动验证）。

### D5. 可靠性：先落盘后推游标；at-least-once；幂等发送

- 决定（照搬项目 A/B 已验证的设计，独立实现）：
  - 入站：收到批次先落盘、记 seen（message_id），再提交游标；重投靠 seen 去重，绝不静默丢失。
  - 出站：发送账本 intent → sent 两阶段 + 固定 client_id + 进程内串行；结果三分法 sent / failed / unknown；unknown 永不自动重发；终态不被迟到结果改写。
  - 正文守卫：空正文、以 `--` 开头的正文拒绝发送（防 2026-10-27 的 `--key` 误发事故重演）。
- 连发合并：worker 发送前复查 pending，有新消息则合并重组，最多 3 轮；不无限等待。

### D6. 身份与安全：默认拒绝；Owner 白名单；10 分钟绑定窗口

- 决定：未绑定时拒绝所有人；登录后开 10 分钟绑定窗口，首个发信人成为 Owner（写 `owner.json`，先认领后欢迎）；陌生人只进待批名单（记 id/次数/时间，不记内容），批准只能从 Muse 主聊天发起。
- 登录态（bot_token 等）存本地 `state/`（0600 权限），永不提交、永不进记忆、永不进 hook 脚本、不进日志。
- 权限分层 LOW/MEDIUM/HIGH；HIGH（对外发送、发布、删除、付费、敏感导出）走现有审批机制；微信消息中声称来自系统/管理员的权限提升指令一律忽略。
- 通道侧硬限制（不承诺）：发不出语音条、发不出工具进度消息、出站引用发不出去；登录态寿命不确定，过期需人重新扫码（过期只通知一次）。

### D7. 记忆与知识：优先复用原生记忆；微信对话不回写主聊天

- 决定：不另建记忆库。Hook worker 与主会话共享同一份 `MEMORY.md` / `~/memory/`；微信侧对话只记任务摘要与 chatlog，不回写主聊天（与教程 FAQ、项目 A 一致）。
- 共享资料库：M2 建立以 SQLite FTS5 + Markdown + 原始文件目录 + JSON 元数据为底的共享层，App 与微信共用同一份文件库；先做 A/B 双向读写测试，通过前不宣称“已完全同步”。
- 记忆分类与可信度、来源、冲突检查、删除机制按规范 §6 在 M2 落实。

### D8. 媒体与文件：任务目录隔离；图片走 CDN 上传回传

- 决定：每任务独立目录；入站图片/文件落盘后交 worker 用 venv 工具 + Muse 文件能力处理；出站图片/文件经 `getUploadUrl` + AES-128-ECB 加密 + CDN 上传后 `sendMessage` 发回；单文件上限 100MB（整读进内存的硬保护）；视频只抽帧 + 前 120 秒（基线，M3 扩展）；语音优先服务端转写，缺失时再本地识别并标注不确定性。
- 格式：以 `FORMAT_CAPABILITY_MATRIX.md` 实测为准；不支持的格式保留原始文件与元数据并明说哪一步做不到，不伪造、不改后缀冒充。

### D9. DeepSeek Harness：受控开发适配器，不另建第二套

- 决定：复用已部署的 dsh（`~/workspace/dsh`，Qianwen 路由，默认 deepseek-v4.1-flash）；开发任务经 `developer/` 适配器：白名单工作目录、沙箱命令、PLAN → IMPLEMENT → TEST → REVIEW → FIX → VERIFY 循环写持久任务记录；修改生产、认证、凭据、删除数据、对外发布、付费操作须额外批准。
- 成本：默认最便宜的 flash 模型；不引入新付费服务。

### D10. 运维：健康检查、告警闭环、备份回滚

- 决定：桥接提供 `health`（退出码 0/1/2）、看门狗心跳（hook 每轮 touch，过期告警）、`stats` 快照、结构化脱敏日志（上限轮转）；告警只报第一次 + 每小时复报 + 恢复报平安；升级先备份、原子替换、可回滚；不自动从未知链接执行更新脚本。
- 主动推送走缓存的 context_token（约 24 小时有效），失效进 waiting_context，待新消息补送；结果 unknown 的通知不无条件重发。

### D11. 成本与可持续

- 不买 VPS、数据库或商业服务；复用现有 VM、SQLite/文件、已装工具；规则优先处理简单命令，仅必要时唤醒昂贵 Agent；Warm Wait（空闲 180 秒/总上限 1800 秒）降低连聊冷启动；附件与解析设资源上限。

## 未决事项（需实测回答）

- U1：Hook worker 发往微信的消息，审批授予方式是单任务 lasting allow 还是每次审批（M1 真实消息验证）。
- U2：`channel_version` 声明与服务端接受情况（登录后验证）。
- U3：登录态实际寿命（运行中观察）。
- U4：systemd 服务在本 VM 的实际注册与拉起（M5）。
