# 项目 B 研究笔记：wechat-muse-bridge-public

> 研究对象：本地克隆 `~/workspace/wechat-muse-bridge-review`
> 上游：https://github.com/6688dong/wechat-muse-bridge-public
> 本地 HEAD：`8a96899`（2026-10-13，docs 提交）；工作区干净，无任何修改
> 版本：1.0.0（2026-10-12 首次公开发布），`bridge/bridge.js` SHA-256 见 `FINAL-REPORT.md`
> 研究方式：只读。未修改仓库、未安装、未登录、未生成二维码、未碰任何凭据。
> 阅读范围：README、docs/DEPLOY.md、ACCEPTANCE.md、DAILY_TOOLS.md、MULTI_ACCOUNT.md、UPGRADE.md、FAQ.md、
> `bridge/bridge.js` 全文（2895 行）、tests/ 全部 13 个文件、LICENSE、NOTICE、THIRD_PARTY_NOTICES.md、
> `bridge/vendor/weixin-agent-sdk/`（结构与 LICENSE）、scripts/、service 模板、FINAL-REPORT.md、CHANGELOG.md。

---

## 0. 一句话定位

一个单文件 Node 守护进程（`bridge/bridge.js`，2895 行），用腾讯官方 ClawBot/iLink 通道收发微信，
用本地 `muse-cli` 子进程驱动一个专属 Muse 对话，并在 SQLite 里做任务状态机、逐段/逐文件发送回执、
提醒/待办/资料索引等本地日常工具。**它不是把 Beacon 接进微信，而是把一个独立 Muse 对话接进微信。**

---

## 1. 许可边界（先看这节，再决定能拿什么）

### 1.1 两层许可，边界清晰

| 范围 | 许可 | 说明 |
| --- | --- | --- |
| 项目自有材料：`bridge/bridge.js`、scripts/、tests/、docs/、README、service 模板、skills/ | **PolyForm Noncommercial 1.0.0**（根目录 LICENSE；NOTICE 要求保留 `Required Notice: Copyright (c) 2026 6688dong and project contributors.`） | 非商业源码许可，**不是 OSI 开源许可** |
| 内置 `bridge/vendor/weixin-agent-sdk/`（v0.5.0，含本项目本地修改） | **MIT**（Copyright (c) 2026 wong2） | 根目录的非商业限制不改变 SDK 的 MIT 使用权 |
| npm 依赖 | 各自许可 | silk-wasm MIT、TypeScript Apache-2.0、@types/node MIT、Prettier MIT、undici-types MIT |
| 外部程序（不随仓库分发） | 各自许可/服务条款 | Node.js、muse-cli、Muse 服务、ffmpeg、LibreOffice、faster-whisper 及模型权重 |

### 1.2 绝对不能直接合入 MIT 项目的东西

以下全部属于 PolyForm Noncommercial 项目自有材料，**一行代码、一段文档文字都不能原样复制、改写后复制、
或翻译后合入 MIT 项目**（MIT 允许商业使用与再许可，与 PolyForm 的非商业限制直接冲突；重新许可即违约）：

- `bridge/bridge.js` 全部代码（包括其中的 SQL、提示词模板、正则、状态机实现）；
- `scripts/` 全部脚本（deploy.sh、qr-login.mjs、verify.sh、rollback.sh、add-account.sh、faster-whisper-wrapper.py）；
- `tests/` 全部测试用例；
- `docs/` 全部文档文字（DEPLOY / ACCEPTANCE / DAILY_TOOLS / MULTI_ACCOUNT / UPGRADE / FAQ），包括验收清单的措辞；
- README、FINAL-REPORT.md、CHANGELOG.md、skills/SKILL.md 的文字；
- `wechat-muse-bridge.service` 模板文字。

PolyForm Noncommercial 允许的只是**非商业目的**的使用、复制、分发与改编（改编仍须是非商业目的，且分发时须附带
许可全文与 Required Notice，不得再许可/转让）。统一项目若为 MIT 且可能用于商业用途，则连“非商业改编后合入”
这条路也是关闭的。

### 1.3 可以直接复用的东西（MIT 或公共知识）

- **vendored weixin-agent-sdk 本身**：MIT，可直接使用/内嵌/修改，但须保留其 LICENSE 全文与 `Copyright (c) 2026 wong2`
声明。注意：该 SDK 是上游 Tencent `openclaw-weixin` 协议实现的一个分支版本（v0.5.0，含本项目本地修改）；
统一项目更干净的做法是直接依赖上游 MIT SDK，而不是复制本仓库的 vendored 副本。
- **npm 依赖**（silk-wasm、TypeScript 等）：按各自许可正常使用。
- **协议知识**：iLink HTTP JSON 协议（getUpdates / sendMessage / getUploadUrl / getConfig / sendTyping /
get_bot_qrcode / get_qrcode_status）属于公开协议文档内容，按文档实现自己的客户端不构成复制。
- **设计思想**（见第 9 节）：思路、状态机、回执模型、认领模式等概念层面可借鉴，但必须**独立重新实现**，
不能逐行翻译或改写 bridge.js（那仍是演绎作品）。

### 1.4 一条红线

“借鉴设计思想”与“改写代码”的界限：可以写下“用自然语言结束标记做回复归属”这样的设计要点再自己实现；
不能对照 bridge.js 把 `markerFor / findMarkedReply / waitForReply` 的逻辑换个变量名重写一遍。
笔记第 9 节只记录设计要点，不贴源码。

---

## 2. 整体架构

```
微信 / ClawBot（iLink） ⇄ bridge.js（单进程守护进程）
│ ├─ SQLite tasks.db（WAL）：任务、文件索引、提醒、待办、偏好、context
│ ├─ media/<message_id>/：每任务隔离目录（0700，文件 0600）
│ ├─ state/weixin/：SDK 登录态（OPENCLAW_STATE_DIR）
│ └─ logs/bridge.log（脱敏 + 10MB 轮转）
└─ muse-cli 子进程（execFile 参数数组，不拼 shell）
send --thread <weixin_session_id> --wait 30 -- <prompt>
history --thread <id> --limit N --raw
```

关键设计选择：

- **单进程串行**：一条消息完整走完才处理下一条；单实例由 pidfile 原子创建 + stale 检查保证；
deploy.sh 还会扫描 `/proc/*/cmdline` 拒绝已有消费者时部署。
- **只用 SDK 的底层原语，不用 SDK 的高层 Bot/Monitor**：bridge.js 直接 import 编译后的
`dist/api/api.js`（getUpdates/sendMessage）、`dist/api/types.js`、`dist/storage/sync-buf.js`、
`dist/api/session-guard.js`、`dist/auth/accounts.js`、`dist/messaging/inbound.js`（bodyFromItemList）、
`dist/media/media-download.js`、`dist/cdn/upload.js`、`dist/messaging/send.js`，自己实现轮询循环、
任务状态机与 Muse 调用。SDK 自带的 `bot.ts / monitor.ts / process-message.ts`（Agent 接口 + 同步 chat）
在本项目中**没有被使用**。
- **启动顺序**：openDb → loadConfig → 单实例 → ensureWechatAccount（核对扫码者）→ seedDedup →
recoverOnStartup → warmupMuse（history 预热，失败则拒绝启动）→ 启动提醒调度器 → mainLoop 长轮询。
- **配置**：`config.json` 必填 `ilink_user_id`、`weixin_session_id`（muse-cli session-start 创建的专属对话，
不可与其他 profile 共用）、`muse_cli_path`；超时默认值：任务总超时 480s、Muse 等待 180s、history 轮询 4s、
history 单次调用超时 15s、history limit 50。
- **日志脱敏**：token / context_token / cookie 只记 `<redacted>`；context_token 另入脱敏表（上限 200 条）。
- **运行环境要求**：Linux、Node.js ≥ 22.13、npm、已登录的 muse-cli；按需 ffmpeg/ffprobe、faster-whisper、
LibreOffice；systemd 服务 `Restart=on-failure`，`StartLimitBurst=3 / 300s`。

---

## 3. Muse CLI 调用方式（核心交互协议）

### 3.1 三个调用点

| 调用 | 用途 |
| --- | --- |
| `muse-cli session-start` | **部署时人工执行一次**，创建专属对话，取 session_id 填入 config；桥接运行期不调用 |
| `muse-cli send --thread <id> --wait 30 -- <prompt>` | 提交任务。`--` 防止 `-` 开头文本被误解析；`--wait 30` 保活连接确保服务端注册（实测 `--wait 0` 会丢消息，`--wait 8/25` 正常）；输出须为含 `stream` 字段的 JSON，否则按失败处理 |
| `muse-cli history --thread <id> --limit N --raw` | 轮询取回复。返回 `chat_events` 数组 |

### 3.2 回复归属：自然语言结束标记（本项目最关键的设计）

- 每任务唯一标记：`任务<微信原始 message_id>回复完毕。`（独立一行，置于最终回复末尾）。
选用自然语言而非 `` 括号式标记的原因：实测 Muse 会过滤括号式系统标记，但会原样输出自然语言标记（含完整 19 位 ID）。
- 认领规则（三重约束，缺一不可）：`event_name === "message.assistant"` 且 `seq > baseline`（发送前 history 最大 seq）
且文本包含本任务标记；取 seq 最大的一个。**没有无标记兜底**（2026-10-10 用户决策取消 D15 兜底：
history 事件无服务端请求 ID 可关联，`reply_to` 为空，会话/seq/静默时间都不足以证明归属）。
- 超时后 baseline 前推到当前最大 seq，防止迟到回复被后续任务认领。
- 标记在发送给用户前由 `cleanReplyForWechat` 剥离；同时剥离 `生成文件：<路径>` 指令行与已核实附件路径、
以及机械前缀 `回「…」：`；普通 URL（含 /home 路径的网址）会被保留。

### 3.3 超时与取消

- 任务总超时 8 分钟（AbortController，覆盖媒体处理 → baseline → CLI 提交 → 等待回复 → 文件回传 → 发送全流程）；
超时可取消卡住的子进程与 history 等待；超时后**禁止一切新发送**，且终态不被迟到结果改写。
- `waitForReply`：每 4s 查一次 history，180s 上限；单次 history 调用 15s 超时可取消；连续 5 次 history 失败 →
记 `unknown`（查不到 ≠ 没回复）。
- `getMaxSeq`：取 baseline，失败重试 3 次（间隔 2s），失败则任务记 `failed`。

---

## 4. 多模态与文件能力

### 4.1 入站（微信 → Muse）

| 类型 | 处理方式 |
| --- | --- |
| 图片（type 2） | SDK `downloadMediaFromItem` 下载解密到 `media/<taskId>/01_image.jpg`，交给 Muse 读图 |
| 语音（type 3） | 优先微信服务端转写（`voice_item.text`）；无转写时 SILK_V3 → silk-wasm 解码 24kHz PCM → 手工封装 WAV → faster-whisper（tiny 模型，中文）本地识别；本地识别结果明确标注“未经人工核实，可能有误”，数字/人名不确定须标注 |
| 视频（type 5） | ffprobe 取时长；ffmpeg 抽 3 帧（第 5 秒 / 中段 / 倒数 5 秒，PNG）；**只覆盖前 120 秒**；音轨提取为 16kHz 单声道 WAV 后 faster-whisper 转写；明确告知用户“基于 3 帧画面，未观看完整连续画面” |
| 文件（type 4） | 原样下载（保留原文件名，消毒后保存），交给 Muse 的文件工具处理 |
| 扫描 PDF | **无本地 OCR**。由 Muse 环境直接读取扫描页；已有可辨中文扫描样本通过，但质量受清晰度和工具影响 |

通用约束：单文件 20MB 上限；媒体下载 120s 超时；文件保存在任务隔离目录；提示词要求 Muse
“使用文件读取工具直接读取上述文件，不要猜测内容”。

### 4.2 出站（Muse → 微信）

- Muse 生成/修改文件时**必须**保存到 `media/<taskId>/`，并在回复末尾、标记之前单独一行写
`生成文件：<文件的绝对路径>`。桥接扫描回复中出现的任务目录路径，逐一校验存在性与
`isPathInTaskDir`（防路径遍历）后才发送。
- 按扩展名分流：图片（.jpg/.jpeg/.png/.gif/.webp）按微信图片发送，其余按文件附件发送；
视频有独立的视频发送路径。图片按图片发、其他产物按附件发，正文不暴露服务器路径。
- **Excel 特殊处理**：.xlsx 回传前用 LibreOffice headless 重算填充公式缓存值（保留公式本身，
原子 rename 覆盖）；重算失败仍发原文件，但必须明确通知用户“公式结果未验证”。
- CDN 上传走 SDK（AES-128-ECB 加密，上传地址必须用 CDN 域名 `novac2c.cdn.weixin.qq.com`，
不能用 API 域名 `ilinkai.weixin.qq.com`）；上传 5xx/网络异常最多 5 次退避重试（延迟 5/15/30/60 秒），
4xx 不重试（见 tests/cdn-backoff.test.mjs）。
- 一次任务可返回多个文件，分别记录发送结果；文字成功不代表附件成功。

### 4.3 资料找回（附件索引）

- `file_index` 表：按 `(account_id, sender_id)` 隔离；short_id 按该账号+发送者的文件计数顺序编号；
每条索引绑定 `original_task_id`（归属验证用）。
- 命令：`最近文件`（最多 10 项：名称、日期、大小、编号）、`找文件 <关键词>`（文件名 LIKE 搜索）、
`再发文件 <编号>`（重发仍可用的实际附件）、口语 `把昨天那份表格再发我`（北京时间日期 + 类型映射：
表格.xlsx/.xls/.csv、文档.docx/.doc/.pdf/.txt、图片、视频；多候选先列出、不猜测）。
- 安全：重发/索引时 `verifyFilePath` 严格校验——originalTaskId 必填、原任务的 from_user_id 与 account_id
须匹配、realpath 必须在 MEDIA_DIR 内且在原任务目录内、拒绝跨任务符号链接与任意路径；
旧任务缺账号元数据时不猜归属、不自动纳入索引；重复重发不增加索引；`偏好 索引关` 只停新索引，
已有索引与任务记录保留。

---

## 5. 任务管理与发送回执、重试机制

### 5.1 任务状态机（tasks 表，SQLite WAL，文件 0600）

```
received → running → replied → sent / failed / unknown / timeout
seeded（去重种子导入的历史 message_id）
```

- 终态集合：`timeout / failed / sent / unknown`。`setStatusIfNotFinal` 拒绝迟到写入覆盖终态
（防止“已超时却被迟到发送改成 sent”等错误）。
- 去重：原始 `message_id` 字符串（`message_id_str` 或首个 item 的 `msg_id`），`INSERT OR IGNORE`；
绝不用文本/context_token 代替。游标 `get_updates_buf` **先处理本批全部消息落库、再持久化**，
崩溃后重拉本批靠 DB 去重，不丢不重。
- 会话过期：getUpdates 返回 errcode -14 → `pauseSession` 暂停 1 小时，需用户重新扫码。
- 启动恢复：`received` 的命令类任务 → unknown（不自动重操作）；媒体未下载完 → failed；
媒体已下载 → 重跑；`running / replied` → unknown（保留已有结果与回执，不自动重发，
因网关 client_id 去重尚未验证）；提醒 `sending` → unknown。

### 5.2 发送与回执（核心诚实性设计）

- `sendOnce`：**单次发送，无自动重试**（2026-10-10 用户决策：网络错误/超时时服务端可能已接受，
重试可能导致重复发送；待 T-36 同 client_id 去重实测通过后再评估）。
- 发送结果三分法：`sent`（接口接受）/ `failed`（服务端明确拒绝，HTTP 非 2xx 或 errcode ≠ 0）/
`unknown`（网络错误，结果不明确，不盲目重发，待人工核对）。
- 文字分段：1500 字符一段（优先按换行切），段间隔 1s；每段独立 client_id
（单段用任务 client_id，多段用 `<client_id>:segN`）；逐段记录 `text_send_results` JSON。
- 终态判定 `deliveryOutcome`：文字或任一文件 failed → failed；任一 unknown/非 ok → unknown；
文字 sent 且文件全 ok → sent；文字 skipped（清理后为空）且文件全 ok → sent；
**空回复且无附件 → unknown，不算成功**。
- `send_attempts` 是历史重试计数，**不是**已发送分段数；以逐段/逐文件回执和微信实收为准。
- 关键措辞纪律：日志与文档反复强调“微信接口已接受发送 ≠ 用户已收到”；附件失败时
文字中的“已发给你”会被改写为“已生成”，不得假称全部成功。

### 5.3 重试机制

| 层次 | 策略 |
| --- | --- |
| 微信文本/附件发送 | 不自动重试；unknown 待人工核对 |
| CDN 上传 | 5xx/网络异常最多 5 次，延迟 5/15/30/60s；4xx 不重试 |
| 提醒主动发送 | 明确拒绝最多 3 次，退避 1 分钟/5 分钟/15 分钟，耗尽 → waiting_context；网络错误 → unknown（不再自动发，下次只告知一次“可能已发送”） |
| 任务级重试 | 用户发 `重试最近失败任务`/`重试`：新建任务（新 message_id `<原id>:retry`，新结束标记），原任务与回执保留；仅限本人本账号明确 failed/timeout 的普通任务，不重放本地命令与 unknown 任务；附件须全部可验证且完整，复制到新任务目录；同一原任务重试加锁（`retryInProgress` 集合），等待执行结束后释放；串行处理 |

### 5.4 长任务进度

`ProgressNotifier`：约 10 秒、90 秒、240 秒发送进度通知（中性措辞，不承诺“马上就好”），
节流（距上次不足 30 秒不发），每条通知独立 client_id，终态后停止、不猜完成时间；
短任务结束清理计时器；通知发送结果真实核对。

### 5.5 实测速度（README，2026-10-10 至 10-12，50 条普通任务）

平均 39.2 秒，中位数 22.5 秒，P90 85.9 秒，最快 11.4 秒 / 最慢 247.4 秒。
计时范围：开始执行 Muse 任务 → 微信发送接口返回；**不是**首字延迟、不是“处理中”通知出现时间、
不是手机端到端耗时；不含媒体下载、排队与手机送达时间。49 条纯文字 + 1 条附件，附件样本不足。

---

## 6. 多账号 / 家人账号隔离

- **Profile 制**：默认连接在 `$HOME/wechat-muse-bridge/bridge`；家人连接在
`bridge/profiles/<name>`（`scripts/add-account.sh <name>` 创建；名称限字母/数字/下划线/短横线，
≤32 字符，不能用 `default`；拒绝已存在目录）。
- **每 profile 完全独立**：config.json、state/weixin（微信登录态）、tasks.db、media/、logs/、
bridge.pid、systemd 服务（`wechat-muse-bridge-<name>.service`）、Muse 对话（weixin_session_id 不可共用）。
- **绑定校验**：启动时 `verifyBoundWechatAccount` 核对持久化扫码者 userId 与 config.ilink_user_id 一致，
否则拒绝启动；已有绑定不能被其他扫码者静默覆盖；qr-login.mjs 发现已有账号直接退出。
- **旧态迁移默认关闭**：不自动读取其他 profile 或旧桥的 session.json；仅环境变量
`WECHAT_MUSE_ALLOW_OLD_IMPORT=1` 显式 opt-in，且须核对 ilink_bot_id 与 ilink_user_id 一致；
去重种子导入同样 opt-in，且数据源以旧桥 v2.db 为准（processed.json 被发现不完整）。
- **隔离的边界（文档反复声明）**：共用同一个 Muse 账号即**共用其权限与费用**；对话与文件目录分开
不等于账户级权限隔离。需要独立 Muse 权限时，应使用独立 Muse 账号与运行环境（不同服务用户/HOME）。
更换共享 muse-cli cookie 会影响所有 profile。
- **部署/运维**：deploy.sh 拒绝在任一 profile 有活跃消费者时更新共享源码与依赖；升级须先停全部消费者，
用 `sqlite3.backup` 做 WAL 一致性备份（禁止直接复制运行中 DB 文件）；rollback.sh 只回滚 bridge.js 代码
（先 `node --check` + sha256 校验暂存代码，再停服务、替换、启动），不恢复数据库与登录态。

---

## 7. 日常工具（本地命令，不走 Muse）

`handleMessage` 先按正则识别本地命令（command_kind='daily'），本地处理完直接回执，不创建 Muse 任务：

- **提醒**：`提醒我 10分钟后 开会` / `明天上午9点 交报告` / `2027-01-01 09:00 新年计划`；
时间按北京时间解释；相对时间直接 `Date.now()+delta`；绝对时间 `Date.UTC()-8h`；
模糊时间（无上午/下午的 1–12 点）先澄清、不落库；过去时间、2 月 30 日等不存在日期拒绝；
后台每 30 秒检查到期提醒，用条件 `UPDATE … WHERE status='pending'` 认领（`changes=1` 才算抢到，
防并发重复）；主动发送用持久化的最新 context_token；无有效上下文时进 `waiting_context`，
等本人发新消息后补送；`提醒列表` / `取消提醒 N`（取消优先处理，避免与到期补送竞态）。
- **待办**：`待办 买牛奶` / `待办列表` / `完成 N` / `取消待办 N`；归属限定账号 + 发送者。
- **偏好**：`偏好 简短/详细/标准`、`偏好 纯文本/Markdown/列表`、`偏好 索引开/关`、`偏好查看`；
每账号 + 发送者独立保存；只接受固定枚举值，不允许自由输入覆盖桥接规则；偏好以固定字段拼入 Muse 提示词。
- **资料找回**：见 4.3 节。
- **重试**：见 5.3 节。

---

## 8. 真实微信验收流程（ACCEPTANCE.md 关键步骤）

验收哲学（全文反复强调）：**自动化检查、服务 active、数据库 sent、退出码 0 都不能代替手机实收；
旧版本成功不能替代新候选的微信实测。** 每次记录部署哈希、profile、任务编号与唯一测试标记。

1. **文本与附件回复**：在绑定微信的 ClawBot 对话发新的唯一标记，要求原样回复；确认实际收到、
无机械的 `回「…」：` 前缀；请求两个文件，确认微信收到**能打开的附件**，正文不显示内部目录或
“生成文件：”指令；执行 `scripts/verify.sh <profile> "<唯一标记>"` 核对部署哈希、单消费者、
status/send_receipt 及每段文本、每个附件的实际回执。附件失败不能仅因文本发出就标 sent；
空回复且无附件不算成功；unknown/pending 不得盲目重发。
2. **扫描 PDF**：准备无文本层的扫描 PDF（中文字体可辨，含预先记录的姓名、日期、电话、金额及至少一张表格），
先人工检查每页图像，再由用户从微信发入；比对 OCR 返回的关键值、表格行列及遗漏。
先前字体不可读的扫描样本不合格，新样本生成或发送也不等于 OCR 已通过。
3. **视频**：准备有可辨文字、动作和语音的短视频，预先记录答案；由用户从微信发入，确认时长、
抽帧内容与语音结果正确；若缺少语音工具，如实记录未覆盖语音。只生成视频或调用 ffmpeg 成功
不足以证明微信端到端成功。
4. **家人连接**：默认微信与家人微信分别发送不同标记与附件；核对 Muse 对话编号、数据库、附件目录均不同，
回复只回各自微信；家人账号不能读取或迁移默认账号的登录 state。
5. **超时与故障回归**：检查 CLI/history 挂起、缺少任务结束标记、迟到回复、媒体进程挂起、多附件途中超时、
超时后返回发送回执、重启中间任务；确认终态不被迟到结果改写、无取消后的新发送、无重复发送、
无孤儿媒体进程；故障后观察至少 30 秒，保留逐段/逐附件回执。

已验证范围（FINAL-REPORT.md，2026-10-10–11）：两套独立部署确认 txt 附件实收；一套部署确认 1 分钟提醒
设置与到时实收；Excel/Word/文本 PDF/PPTX 既有样本通过（未每次重测）；扫描 PDF 中文关键字段及表格样本通过；
视频画面样本通过；**视频清晰人声的微信端到端验收仍待完成**（仅本地转写检查通过）；资料找回/待办/进度/偏好
主要由代码回归覆盖，不等同完整手机实测。

---

## 9. 测试覆盖

`npm test`（`node --test tests/*.test.mjs`），13 个文件，grep 计数 58 个用例（README 称 60 项；
含原有 32 项、日常工具 20 项、真实轮询入口 1 项、附件重试 4 项、任务目录校验 3 项）。

测试手法值得注意：**用 `vm` 沙箱真实加载 bridge.js 源码切片**（按函数名切出 `openDb`、发送、
`runTaskInner` 等代码段执行），而非只测抽取出的纯函数；另有读取真实源码做解析断言的用例
（如 buildMuseText/buildMediaPrompt 必须包含任务专属目录与标记）。

覆盖重点（按文件）：

- `delivery.test.mjs`：两附件 + 空文字 → sent 且逐文件回执 ok；附件被拒 → failed（即使文字成功）
并通知用户；空回复无附件 → unknown；迟到已接受分段保留回执且不覆盖 timeout；取消时 baseline
阶段不提交 Muse；总超时只发一次通知且不再查 history。
- `reply.test.mjs`：取消时保留已接受段回执并跳过下段；纯文件回复跳过文字发送且保留 URL；
附件失败时文字“已发给你”改写为“已生成”；终态由文字 + 全部附件组合决定。
- `daily-review.test.mjs`（最大，17KB）：提醒时间解析（UTC 服务器不加 8 小时、模糊澄清不落库、
2 月 30 日拒绝）、命令去重、unknown 提醒不可重选自动发送、文件归属校验、待办/偏好按账号隔离、
后台调度器真实发送与退避、重启不重放本地命令、重试保留原回执并持锁至执行结束、进度通知节流。
- `cdn-backoff.test.mjs`：CDN 上传 500/网络异常最多 5 次（延迟 5/15/30/60 秒），4xx 不重试。
- `accounts.test.mjs` / `qr.test.mjs` / `polling-entry.test.mjs` / `startup.test.mjs`：
家人 profile 不隐式导入属主 state、扫码者须与配置匹配、显式错账号拒绝、真实轮询入口先落库后推游标、
真实启动到达 warmup 与轮询且扫码者匹配。
- `scripts.test.mjs`：profile 名校验、回滚拒绝目录穿越、回滚前校验代码、家人安装不碰默认 state。
- `verify.test.mjs` / `taskdir-prompt.test.mjs`：标记逐字匹配且不改 DB、任务目录约束进提示词。

---

## 10. 可直接复用的设计（思想层面，须独立实现）

以下按“设计要点”记录，不含源码。统一项目实现时可采纳这些思路，但须自己写代码：

1. **结束标记归属协议**：用含任务唯一 ID 的自然语言句做最终回复标记，history 轮询时以
`seq > baseline + 含本任务标记` 三重约束认领；无标记不兜底；超时后 baseline 前推防迟到认领。
2. **发送结果三分法**：sent / failed / unknown；网络错误记 unknown、不自动重发；终态集合 + 条件更新
防止迟到写入覆盖终态；文字与附件的交付状态分别记录、组合判定终态。
3. **逐段/逐文件回执**：每段文字、每个附件独立 client_id 与独立回执记录；`send_attempts` 不冒充发送段数。
4. **先落库后推游标**：崩溃安全的轮询消费顺序（处理完本批再持久化 get_updates_buf，重启重拉靠 DB 去重）。
5. **任务目录隔离**：每任务独立目录，Muse 生成文件只认该目录内路径；出站文件先 realpath 校验归属与范围。
6. **提醒状态机**：pending → sending（条件 UPDATE 认领）→ sent / failed（有限退避）/ unknown（不再自动发，
只通知一次）/ waiting_context（等新消息补送）；重启时 sending → unknown。
7. **文件索引归属模型**：索引绑定 original_task_id，重发时三重校验（原任务存在、发送者一致、路径在原任务目录内）。
8. **单消费者 enforcement**：pidfile + 部署前扫描进程表；升级先停全部消费者。
9. **启动恢复策略**：中间态任务按“能安全重跑的重跑，不能确认的不重发、记 unknown 待人工核对”。
10. **进度通知节流**：固定时间点 + 最小间隔 + 终态停止 + 中性措辞。
11. **Excel 回传前 LibreOffice 重算填充公式缓存**；失败时发原文件 + 明确告知用户。
12. **语音处理分层**：优先服务端转写 → SILK 解码 → 本地 whisper；本地识别结果标注不确定性。
13. **验收纪律**：唯一标记回显、双附件实收、verify 脚本核对回执、“接口接受 ≠ 用户收到”。

---

## 11. 对统一项目（MIT）的具体提示

1. **不要从本仓库复制任何代码或文档文字**（第 1.2 节清单）。统一项目应直接依赖上游 MIT 的
weixin-agent-sdk（或保留 MIT 声明地内嵌本仓库的 vendored SDK），其余桥接逻辑自己写。
2. **Muse 侧接口不同**：本项目用 `muse-cli` 子进程 + history 轮询 + 结束标记；统一项目若用 Beacon
原生能力（Hook/任务队列唤醒），不需要结束标记协议——但仍需要同等的“回复归属”与“终态不被迟到结果
改写”机制（第 10 条第 1、2 点的思想可直接迁移）。
3. **本项目的微信侧是独立 Muse 对话，不是 Beacon**：统一项目“One Muse, shared knowledge”的目标
要求微信任务与 App 任务共享知识与任务状态，这是本项目**没有解决**的问题（其多 profile 之间
也是隔离的），不能把本项目的隔离模型误当成统一模型。
4. **视频声音是已知未完成项**：微信端到端清晰人声验收仍待完成；统一项目如承诺视频语音理解，
须自己完成该验收，不可引用本项目的“已有样本”作背书。
5. **附件 20MB 上限、视频仅前 120 秒、3 帧抽样**等边界条件可直接作为统一项目的需求基线参考。
6. **提醒主动发送依赖 context_token（约 24 小时有效）**：统一项目设计主动推送时须处理上下文失效
后的 waiting/补送逻辑，不可假设随时可主动发消息。
7. 部署运维上可借鉴：systemd 模板结构、备份（sqlite3 `.backup`）、回滚先校验代码、verify 脚本
核对部署哈希与单消费者——均为通用运维模式，文字与脚本须自己写。

---

## 12. 研究局限

- 未运行任何代码（只读研究）：测试用例数量为 grep 计数（58），README 称 60，差异未核实；
未验证 `npm test` 是否通过。
- SDK 的本地修改内容未逐行比对上游（THIRD_PARTY_NOTICES 仅声明“包含本项目修改”，未列修改清单）；
如需内嵌该 vendored SDK，建议比对上游确认修改点。
- 性能数字（39.2s 平均）为维护者历史样本（2026-10-10–12），非本研究实测。
