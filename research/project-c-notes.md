# Project C 研究笔记：Muse 接入微信（ClawBot / iLink）与 Muse 官方机制

> 研究日期：2026-11-12（只读研究，未安装、未登录、未碰任何凭据）
> 分两部分：第一部分提炼 UPGPTs 教程（Project C）；第二部分汇总 Meta Muse 官方文档与本地文档结论。
> 每个结论后注明来源。凡标注「待确认 / 推断」的，均非文档明文，请以实测为准。

---

## 第一部分：教程提炼 — UPGPTs《Muse 接入微信教程（2026）》

来源：https://upgpts.com/tutorials/muse/muse-wechat（首次发布 2026-10-18，最后更新 2026-10-26；第三方实测记录，非 Meta 或腾讯官方文档）

### 1. 方案定位与前提条件

- 方案本质：通过微信官方 **ClawBot 插件**与 **iLink 协议**，让 Muse 在云端 Linux 环境里自动配置后台长轮询收发服务与任务唤醒机制；手机扫码授权后，在微信聊天框发文字指令、调用工具执行真实任务，文字总结与生成的图片实时回传微信；全程无需公网 IP 与自建服务器；实测短任务 1–2 分钟内完成回传。
  来源：教程 TL;DR（L4–L5）、「实测环境与安全提示」（L7）。
- 两个前提：① 一个正常可用的 Muse 账号；② 手机微信支持并能开启 ClawBot 插件（路径「我 → 设置 → 插件」）。
  来源：教程「开始之前：两个前提条件」（L39–L45）。
- 方案对比：ClawBot 路线不需海外网络、支持图片/文件回传、官方扫码授权安全性高；WhatsApp 是 Meta 官方原生通道但需海外网络；企业微信自建应用需管理权限；第三方 Hook / 逆向协议极易触发微信风控封号，不建议个人主号使用。
  来源：教程「方案对比」表（L49–L65）。

### 2. ClawBot 扫码：启用插件 → 发文档 → 生成二维码 → 扫码绑定

1. 微信内启用插件：打开微信「我 → 设置 → 插件」，找到「ClawBot」并启用，之后出现「微信 ClawBot」功能入口。
   来源：教程「第一步」（L69–L75）。
2. 向 Muse 发送协议文档与接入指令：直接在主聊天要求接入个人微信时，Muse 默认回复不支持（只提供 WhatsApp 或企业微信）；解决方式是提供两份文档——腾讯开源协议库 `https://github.com/tencent/openclaw-weixin/blob/HEAD/docs/protocol_zh_CN.md` 与微信开放平台文档 `https://developers.weixin.qq.com/doc/aispeech/knowledge/openapi/Clawbotrelated.html`——让 Muse 自行阅读协议并编写桥接服务。
   来源：教程「第二步」（L79–L93）、「附录：指令模板」（L213–L237）。
3. 环境就绪检查：Muse 会在运行环境内创建桥接脚本（教程示例路径 `~/workspace/wechat-bridge/bridge.py`）并注册监控 hook；需确认输出包含两部分能力：① 消息收发服务（后台进程长轮询微信接口，接收私聊文字并存入本地队列）；② 任务唤醒与回传（hook 周期性检测未处理消息，唤醒带完整工具链的 worker 执行任务，结果回传微信）。注意：仅启动收发不等于配好执行链路。
   来源：教程「第二步」（L95–L101）。
4. 扫码授权：后台环境就绪后，在聊天框回复确认，让 Muse 生成登录二维码；二维码有效期 5 分钟，过期可重新生成；扫码后若手机端提示输入数字验证码，将验证码发给 Muse 填入确认；手机端确认授权后，服务端下发访问 Token，Muse 正式启动收发与唤醒服务。
   来源：教程「第三步」（L105–L117）。

### 3. 后台消息监听与任务唤醒（教程所述机制）

- 通信接口：腾讯官方 Bot 后端 `ilinkai.weixin.qq.com`，非第三方抓包服务。
  来源：教程「网关核心运行参数与机制说明」表（L159–L178）。
- 消息接收：35 秒 HTTP 长轮询，后台进程实时监听微信私聊文字，写入本地 `inbox/` 目录。
- 任务唤醒：15 秒本地 hook 扫描，轮询认领未处理消息，原子转移到 `running/` 并唤醒 worker。
- 响应时延：短任务 1–2 分钟（轮询接收约 35 秒 + 扫描唤醒约 15 秒 + worker 启动与执行耗时）。
- 支持范围：纯文字下发、图文回传；暂不支持直接向微信发送语音、视频或文件让 Muse 解析。
- 会话独立：微信与 Muse 界面分离，微信对话不回写到网页主聊天，后台仅记录任务执行摘要。
  来源：同上表（L159–L178）；FAQ「微信里的对话会同步到 Muse 主聊天窗口吗？」（L259–L261）。

### 4. 连通性与任务执行测试

- 连通性测试：扫码授权完成后，在微信打开「微信 ClawBot」对话框发送第一条测试消息（如“你好呀”）；第一条消息用于向后台提供当前会话的上下文信息；收到回复后可再发身份确认消息验证。
  来源：教程「第四步」（L121–L129）。
- 任务执行与图片回传测试：在微信发送绘图指令（如“帮我生成一个小姐姐的图片吧”），Muse 唤醒 worker 执行画图工具，图片保存至 Muse 内部媒体库。初始版桥接脚本若只实现纯文字回复，图片不会直接发到微信聊天框，而是提示前往 Muse 网页端媒体库查看；需在微信中回复“帮我加上吧”，Muse 会更新桥接逻辑，增加将图片上传至微信服务器获取媒体 ID 并发送到当前会话的功能，之后图片可直接在对话框内接收查看。
  来源：教程「第五步」（L133–L155）；FAQ（L251–L253）。
- 备注：「上传获取 media_id」是教程的简化说法；按腾讯协议文档，实际流程是 `getUploadUrl` 取上传参数 → AES-128-ECB 加密上传至 CDN → `sendMessage` 发送媒体引用（详见 Project B / 协议文档笔记，此处不展开）。

### 5. 基础排障（Troubleshooting）

| 现象 | 原因（教程说法） | 对策 |
|---|---|---|
| 微信插件列表找不到 ClawBot | 灰度内测插件，部分版本/地区账号尚未覆盖 | 更新微信到最新版；检查「设置 → 通用 → 辅助功能/插件」；仍无入口可用已开通插件的副号测试 |
| 扫码绑定后发消息完全无回复 | 后台仅启动了轮询进程，未启动任务唤醒 hook，或后台脚本异常中断 | 回主聊天让 Muse 检查 `bridge.py` 进程是否存活，确认 `wechat-inbox` 扫描 hook 是否 active |
| 响应时间长（1–2 分钟） | 正常现象：35 秒长轮询 + hook 每 15 秒扫描 + worker 冷启动约 15 秒 | 属正常时延；避免 30 秒内连续重复下发相同任务导致并发冲突 |
| 生成的图片没有在微信直接显示 | 初始桥接只实现纯文本发送 | 在微信发指令要求加上发图功能（上传微信服务器取 media_id 后直接发到聊天窗口） |
| 安全性与封号风险 | 基于腾讯官方 openclaw-weixin 协议、手机扫码确认授权下发 token，不拦截微信本地内存，不属于逆向违规外挂 | 仍建议遵守微信正常使用规范，避免高频轰炸式调用 |

来源：教程「常见异常与排查」（L181–L210）。

### 6. 教程本身的局限（阅读时需注意）

- 教程是第三方实测记录（2026-10-18 发布、10-26 更新），不是 Meta 或腾讯的官方文档；其中 `bridge.py`、`wechat-inbox` hook 名、`inbox/`/`running/` 目录名均为该次实测的示例实现，不同实现可以不同名。
- 教程称二维码有效期 5 分钟、hook 每 15 秒扫描：作为实测值记录；协议层以服务端返回的 `expire_time` 为准，hook 间隔以本地 hook 机制配置为准（见第二部分第 1 节：最小 5 秒，15 秒在允许范围内）。
- 教程未提及 Muse 的审批机制、凭据存放规则与 hook 脚本无凭据的约束（见第二部分第 2、7 节），落地时必须补上。
- 教程 FAQ 确认：Muse 默认只内置 WhatsApp 官方接入，不自带个人微信接口；不提供文档时 Muse 会默认认为个人微信无法连接。
  来源：教程 FAQ（L243–L245）。

---

## 第二部分：官方文档结论 — Muse 的 Hook / Worker / 定时任务 / 常驻进程 / 记忆 / 安全审批

> 重要区分：存在两套名字相似但不同的机制——
> ① **个人智能体 Muse（本产品，muse.ai / App 内运行）**的 Hook：事件型自动化 = Bash 轮询脚本 + `silent`/`wake` 决策，见第 1 节；
> ② **Muse Code（Meta 的终端编程智能体，dev.meta.ai/docs/muse-code）**的 Hook：绑定到智能体生命周期事件（SessionStart、PreToolUse 等）的 shell 命令，见第 1.5 节。
> 教程（Project C）所说的 hook 是第 ① 种。两者不可混用。

### 1. Hook 机制是什么、如何配置、轮询脚本有何约束（个人智能体 Muse）

**是什么**：Hook 是事件型自动化：一个 Bash 轮询脚本定期检查某个变化条件，命中时唤醒一个 worker 智能体处理；时间或节奏本身是触发条件时用 cron，条件变化是触发条件时用 Hook。
来源：`hooks` 工具命名空间说明；`~/docs/chat/scheduling-and-watching.md`「Choose the mechanism」。

**两部分组成**：
1. Bash 轮询脚本：以 `.sh` 结尾，位于 `~/hooks/scripts/`，以 `#!/usr/bin/env bash` 开头，`set -euo pipefail`，并 `source "$HATCH_HOOK_RUNTIME"`。脚本在普通受跟踪 shell 执行器中运行，基础命令环境与代理设置与普通 shell 命令相同，但**没有 secrets、没有连接器凭据**。
2. Worker 指令（prompt）：`wake` 时启动的 worker 智能体收到的指令；wake 的原因与 payload 会作为事件数据自动附带。指令应要求 worker 在执行摘要中汇报发现，不要指令其写用户没要的报告文件。
来源：`hooks` 工具命名空间说明；`~/docs/chat/scheduling-and-watching.md`「Hook scripts belong under `~/hooks/scripts/`, with state under `~/hooks/state/`」。

**配置流程**：先写脚本 → `hooks.add` 注册（短稳定 id、脚本路径、worker 指令、轮询间隔）→ 新 hook 默认**禁用** → `hooks.dry_run` 测试（同步等待脚本与日志追加，只报告决策，不启动智能体）→ 反复修正直到通过 → `hooks.enable` 开始轮询。`hooks.update` 保留当前启用状态，改后同样先 dry_run。
来源：`hooks` 工具命名空间说明；`~/docs/chat/scheduling-and-watching.md`。

**轮询脚本约束（逐条）**：
- 每次运行必须以**恰好一次**终结决策结束：`silent "原因" '{"可选":"payload"}'` 或 `wake "原因" '{"可选":"payload"}'`。
- 只用公开端点或本地数据；fetch 必须有界，如 `curl --fail --silent --show-error --max-time 10 ...`；用 `jq` 解析 JSON。
- 有用的观测用 `log "observation" '{...}'` 记录；fetch 无结论时记录失败并保持 silent。
- 跨轮状态放在 `~/hooks/state/` 下；用提供的状态助手，使 dry run 不消耗检测结果；`HATCH_HOOK_DRY_RUN` 为 `1` 时是演练、为 `0` 否则；比较时明确与 `1` 比较。**注意：dry run 不隔离脚本自行管理的状态**，脚本须自行判断干预。
- 若某个结论性条件意味着以后轮询再无意义，在最终 `wake`/`silent` 之前调用 `disable_after_run`。
- **Hook 没有连接器凭据；不要把 secrets 放进检测脚本。**
- 每次检查应能结束、有请求与执行超时、避免重叠。
- 两个机制都是轮询：两次检查之间发生又撤销的变化会被漏掉；时间上也不精确，可能提前或延后数分钟；不能承诺“事情一发生立刻发现”。
来源：`hooks` 工具命名空间说明；`~/docs/chat/scheduling-and-watching.md`「Saved jobs and hooks」「Both mechanisms poll」。

**关键参数**：`poll_interval_secs` 默认 60 秒，最小 5 秒，最大 604800 秒（一周）；`script_timeout_secs` 默认 600 秒，最大 600 秒，最小 1 秒；`delivery` 默认创建所在的聊天，可改为主聊天或指定 side chat。
来源：`hooks` 工具命名空间 `hooks.add` / `hooks.update` 参数表。

**本地实证（Project A，生产在用）**：`research/project-a/examples/muse-hook/ilink-watch.sh` 每 5 秒一轮，每轮即一次 `getupdates` 长轮询（服务端 hold ≤35 秒）；先落盘到 `ilink-pending.json` 再 wake；worker 用 `mv` 原子认领到 `ilink-processing.json`；10 分钟未处理完回收；`ilink-warm-wait.sh` 守候热态（默认空闲 180 秒、总上限 1800 秒）；token 过期 / 轮询连续失败满 10 分钟才告警、之后每小时复报、恢复后报平安；双锁分工（`ilink-watch.lock` 防 hook 自身重叠，`ilink-driver.lock` 防 hook 与 daemon 互抢）。
来源：`~/workspace/muse-wechat-unified/research/project-a/examples/muse-hook/README.md`、`ilink-watch.sh`、`AGENTS.md`。

### 2. Muse Code 的 Hook（另一套机制，仅作区分）

- Muse Code 的 Hook 把 shell 命令绑定到生命周期事件，事件触发时运行命令并据结果执行检查、格式化或事前拦截。事件包括 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`PostToolBatch`、`PreLLMCall`、`PostLLMCall`、`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop`、`Notification`、`Stop`、`StopFailure`、`SessionEnd`。
- 来源有三类：项目级（`<project-root>/.muse/hooks.json`，需信任项目文件夹后才运行）、用户级（机器范围设置）、托管级（`managed_hooks_path` 指向的文件，无项目信任步骤，谁控制该文件谁就控制执行内容）。
- 一个 Hook 只绑定一个事件；启动时发现并校验，配置畸形会警告并跳过；没有 `muse hooks` 命令族或逐 hook 信任命令。
来源：https://dev.meta.ai/docs/muse-code/extending（「Wire your own shell commands into Muse Code's lifecycle」一节）；搜索结果 https://dev.meta.ai/docs/muse-code/interactive（提及 `PreCompact`/`PostCompact` hook）。

### 3. Worker / 子代理如何工作

**Hook / Cron 唤醒的 worker（个人智能体）**：
- 后台 worker 独自完成任务，然后判断结果是否需要主智能体知晓；需要时，主智能体收到一份隐藏 handoff 报告，由主智能体决定用户看到什么。worker 的报告是写给主智能体的，不是写给用户的；worker 不能要求主智能体做更多工作。
- 一次运行成功只表示工作完成，不表示任何内容已到达用户。
- 若 Muse 在运行中重启，运行会在安全时恢复，否则记为已停止，下一次按计划正常进行。
来源：`~/docs/scheduling-and-watching.md`「What a run is」；`~/docs/chat/scheduling-and-watching.md`。

**子代理（subagent）**：
- 子代理是父智能体为一个有界任务派生的子智能体；子代理之间相互隔离，**不继承父级的 transcript**；任务必须自包含（任务、期望结果、非显而易见的约束、所需事实全部写进派发消息）；完成后结果回传父级，由父级综合。
- 子代理不能再派生自己的子代理（本环境 depth 限制）；与父级共享同一台 VM 的文件系统，但对话上下文不共享。
来源：本运行环境的 subagent 机制说明（系统提示）；另见 Muse Code 侧的对应描述（下一段）。

**Muse Code 的子代理（作对照）**：
- 子代理是 lead 会话为一个有界任务派生的子智能体；默认共享 lead 的 checkout，除非 lead 为该子代理要求 worktree 隔离；隔离的子代理获得 Muse Code 管理的 Git worktree；并行子代理可能写同一批文件时应要求隔离，只读子代理留在共享 checkout。
- 一棵智能体树默认同时最多执行 8 个智能体（含 root），`agents.execution_capacity` 可设 1–64；树满时派生被拒绝；子代理可再派生孙代理，共享同一 root 树容量；取消是合作式的（未到检查点的被取消子代理会继续跑，写到一半的写操作会写完）；运行体记录每次派生、状态变化与控制动作。
- 另有后台观察者智能体（Memory recall、Skill recall、Goal tracking、Verification），只向主智能体的下一回合插入简短建议，不直接代答。
来源：https://dev.meta.ai/docs/muse-code/extending（「Distribute a large job…」「A subagent is a child agent…」等段落）。

### 4. 定时任务（cron）能力

- 种类：`runonce`（需 `at`）、`interval`（需 `every`，如 `5m`/`15m`/`1h`，`at` 可选）、`daily`（需 `time`）、`weekly`（需 `time` + `dow`）、`monthly`（需 `time` + `dom`）、`yearly`（需 `time` + `dom` + `month`）。
- **没有开始日期、结束日期，也没有“仅当满足条件才触发”的设置**；循环任务一直跑到暂停或删除为止。条件判断属于任务正文的逻辑：运行每次都会发生，由 worker 决定什么内容到达用户。
- 每个提醒/跟进任务必须有 owner：服务于既有目标时 owner 为 `goal:<goal-slug>`，否则先创建 tracked item 并以其 slug 为 owner；无 owner 的提醒 cron 是路由错误。
- 超时：`timeout_secs` 1–86400 秒；循环任务实际生效值至少为调度间隔（上限 86400 秒），未指定时默认 3600 秒；一次性任务默认 86400 秒。
- 重试默认 0；可配 `retry.on_failure` + `max_retries`，但仅针对运行时失败/超时，worker 汇报的未完成结果与已派发的 artifact 动作永不自动重试。
- 管理：`cron.run` 立即手动执行；`cron.stop` 停止在途运行（含其 worker、子代理、浏览器窗口）；`cron.status` / `cron.runs` 查状态与运行历史；回答“某次检查跑了没有”应以 `cron.runs` 为准，排期本身不是跑过的证明。
- 任务若被持久性原因阻塞（如需重连的连接器、只有用户能做的动作、站点的机器人检查、离线配对设备、忙碌的浏览器），会自行暂停，之后按计划再试；用户重连被阻塞的连接器后，任务在下次计划时间再试，或在已错过一次时立即再试。
- 时区：可省略（默认用户当前时区），或用 IANA 时区及 `@user.current` / `@user.home` / `@user.work` 符号引用。
来源：`cron` 工具命名空间说明；`~/docs/scheduling-and-watching.md`（「What you can do with jobs」等节）；`~/docs/chat/scheduling-and-watching.md`。

**Muse Code 的对照（`/loop`）**：`/loop 10m /run-tests` 或 `/loop "0 9 * * 1-5" standup` 把一条循环 prompt 排成 cron 任务；接受简写间隔或 5 字段 cron 表达式；无节奏时默认每 10 分钟；循环任务 7 天后自动过期；`fire_when_active_run: false`（某次触发时已有运行在执行则跳过，不排队、不重放）。
来源：https://dev.meta.ai/docs/muse-code/interactive（搜索结果摘要，L15–L24）。

### 5. 后台常驻进程（systemd）是否支持及约束

- **支持，但有约束**。Guest 有 systemd，但启动的是最小 `default.target`，不是通常的 `multi-user.target` 或登录会话。优先使用现有的 guest system manager；仅当其 manager、配置查找、运行目录、总线、替换后启动均已确立时才用 user service。不要假设 lingering 可用，也不要用宿主运维设施。
- 规范做法：canonical unit、程序、依赖与状态都放在持久 home 存储下；`ExecStart` 与 `WorkingDirectory` 用绝对路径；用前台进程；设置合适的 `Restart` 策略、`RestartSec` 与启动上限；用 `TimeoutStopSec` 允许优雅终止，`KillMode=control-group` 控制子进程；限定资源与日志；重启行为与程序匹配。
- **不要假设服务继承工具凭据、连接器访问或审批**；用受支持的访问路径；不要把 secrets 复制进 unit、参数、环境文件或日志。
- **恢复**：运行时负责恢复已保存的任务、子代理、cron、artifact 与可恢复的智能体工作；**自定义程序需要一条能恢复其前置条件的启动路径**，仅靠持久 unit 文件与 `Restart` 设置并不能确立这条路径。恢复时先读持久期望状态、恢复前置条件、逐个组件对账、从检查点恢复并验证实际进展。
- 验证：只看 unit 为 active 或 PID 存在，不能证明健康；要查 manager 与 unit、依赖、日志与最近输出。安静的监听器可能只是在等确认，不能据此断定崩溃。
来源：`~/docs/chat/scheduling-and-watching.md`「Services in this runtime」「Recovery after replacement」「Verification and delivery」。

**与教程的对照**：教程的桥接是“后台进程长轮询 + hook 唤醒 worker”，即监听进程与唤醒机制分离；Project A 的生产做法与之相同，但明确 hook 与 daemon 二选一并由共享驱动锁强制执行（`ilink-driver.lock`），先跑起来的驱动赢。
来源：`~/workspace/muse-wechat-unified/research/project-a/AGENTS.md`（「Hook 与 daemon 二选一」）。

### 6. 主会话与 Hook Worker 是否共享同一份记忆与文件权限

**结论：Hook / Cron worker 与主会话共享同一份记忆与同一套文件；子代理（subagent）共享文件系统，但不共享对话上下文。**

| 维度 | Hook / Cron worker | 子代理（subagent.spawn） |
|---|---|---|
| 记忆（MEMORY.md、~/memory/、记忆搜索） | 共享。是同一智能体的后台回合，记忆按用户/智能体保存，主聊天与个人 side chat 共享记忆搜索 | 不自动共享上下文。任务必须自包含；子代理不继承父级 transcript；但它可通过记忆搜索工具自行查记忆（需在任务中明确授权范围） |
| 文件（~/workspace、~/hooks/state 等） | 共享。同一台专属 VM、同一 home 目录、同一用户身份运行 | 共享同一 VM 文件系统；Muse Code 侧的对应表述是“子代理默认共享 lead 的 checkout” |
| 连接器凭据 / secrets | Hook **检测脚本本身无凭据**；worker 回合执行工具时走正常连接器与审批路径（见第 7 节） | 与父级同一 VM，但凭据仍走 Secure Vault / 连接器托管，不可由子代理直接读取或写入 |
| 对用户说话 | worker 不直接在主聊天发言；结果以隐藏 handoff 交主智能体，由主智能体决定呈现 | 结果回传父级，由父级综合后决定呈现 |

**证据链**：
- 「每个用户都有一台自己的专属电脑（VM），在对话之间一直陪着用户」——`~/docs/muse.md`「Muse is Meta's personal AI agent product」。
- 「记忆保存关于用户的持久事实与偏好，供未来对话使用；主聊天与个人 side chat 的记忆搜索会返回匹配摘录」——`~/docs/memory.md`。
- 「电脑一直开着；任务运行时用户的 App 是否打开、手机是否关机都无关；结果以聊天消息到达」——`~/docs/scheduling-and-watching.md`「Background work runs reliably」。
- 「后台 worker 独自完成任务，然后判断结果是否需要主智能体知晓；需要时主智能体收到隐藏 handoff」——`~/docs/scheduling-and-watching.md`「What a run is」。
- 「Hook 脚本位于 `~/hooks/scripts/`，状态位于 `~/hooks/state/`；Hook 没有连接器凭据；不要把 secrets 放进检测脚本」——`~/docs/chat/scheduling-and-watching.md`、`hooks` 工具命名空间说明。
- 「你的数据来源包括：过往对话、已存记忆、workspace 里的 artifact 与文件、已连接的 Meta 账号与第三方服务、配对设备；你能接触的私人信息只属于这个用户」——`~/docs/data-handling.md`。
- 子代理隔离：本运行环境的 subagent 机制说明（「子代理运行隔离：不继承父级 transcript」「把任务、期望结果、约束与所需事实写进派发消息」）；Muse Code 侧：子代理默认共享 lead 的 checkout，见 https://dev.meta.ai/docs/muse-code/extending。

**未完全由文档覆盖的点（标注为推断）**：
- 本地文档没有明文规定“子代理能否直接调用记忆搜索、能看到多少记忆”。机制上子代理与父级同 VM、同工具集，但上下文隔离；稳妥做法是在派发任务中明确写清可读的记忆/文件范围，不要默认子代理“什么都知道”。
- Hook worker 回合是否与主会话共享同一份“正在进行的对话上下文”（如刚聊到的事）：文档只保证共享持久记忆与文件，不保证共享主会话的即时上下文；worker 收到的是 hook payload + prompt，应把必需上下文写进 prompt 或让 worker 读任务队列文件。
- 微信对话本身不进主聊天（教程 FAQ 与 Project A 的 chatlog 机制一致：微信侧对话只记在桥接数据目录的 chatlog，主聊天仅收到任务执行摘要/汇报）。

### 7. 安全审批机制如何工作

- **审批卡**：当用户批准一个动作时，App 显示审批卡说明批准内容；**审批卡对智能体不可见**——智能体不能描述卡片的布局、按钮或措辞，也不能承诺哪种选择会停止未来的提示。
- **何时需要审批**：用户要求的普通任务通常不需要审批；敏感或改变状态的动作（登录、购买、发帖）需要；普通浏览器表单提交目前默认允许。聊天中的购买永远没有 lasting 默认，每次都要重新批准。
- **邮件 / 消息发送的审批**：发送邮件与消息需要审批，除非落在以下有范围的允许之内：
  - Gmail 发送、Google Calendar 邀请、Google Drive 分享给某一个人时，卡片上显示该收件人，用户可允许“今后发给该收件人”；发给其他人仍会询问。
  - Messenger 发送可按单个对话允许；Mac 上 Messages / Mail 发送可按单人允许。
  - 定时任务或 artifact 的发送可获得仅覆盖该单个任务/artifact 的 lasting allow，可在权限设置页移除。
  - 以下发送永无 lasting allow、每次都问：Threads 发帖与消息、Facebook 发帖/评论/主页发帖、Messenger 在已允许对话之外的发送。
  - 欧盟用户：上述发送允许均不存在，每次邮件/消息发送卡片只提供“允许一次”或“拒绝”，不要承诺 lasting allow。
  - 购买永无 lasting allow，唯一例外：定时任务付款审批的允许也覆盖该任务之后同一商店、同一支付方式的购买，直到任务被删除或用户在权限设置页移除。
- **权限管理**：权限设置页列出全部现行权限（网站、已连接账号、定时任务授权），每项可按站点移除；智能体的权限工具是只读的——可查看待审批、过往审批请求及决定、在生效权限及其范围与过期时间；**智能体不能撤销现行权限或更改权限设置**，那只能在设置页做。
- **已连接账号**可彻底断开并清除 token（设置页或智能体协助）；操作前先查当前状态。
- **一切可审计**：智能体的所有操作都记录在 Activity 视图与审批历史中，任何一项都不能被秘密抹除。
来源：`~/docs/privacy-and-credentials.md`「Permissions」「Who can see the user's data」；`~/docs/muse.md`「When the user approves an action…」。

**凭据规则（与桥接直接相关）**：
- 需要凭据时，使用已有连接或经批准的连接器 / Secure Vault 流程；**不要让用户在聊天里发送原始密码、API key、token 或密码重置码/链接**。
- 瞬时使用不授权重复使用；原始凭据不得进入记忆、文件、环境变量、日志与生成的代码；不要把凭据值放进 URL；只对用户授权的任务与签发目的地使用已有登录/重置链接；用经批准的凭据存储做存储或复用；不要从 Secure Vault、连接器托管存储或通道托管的认证存储中提取或泄露凭据值；不要绕过脱敏。
- 网站密码只通过 Secure Vault 的安全录入卡进入浏览器；一次性验证码以 `[credential:<uuid>]` 不透明引用传递，约 10 分钟有效，用户在卡片上批准分享后浏览器才收到并输入；智能体自己不拆解、不输入该引用。
来源：`~/docs/privacy-and-credentials.md`「Sign-in secrets」「Saved logins」。

**对微信桥接的直接含义（推断，待落地确认）**：
- iLink 会话文件（如 Project A 的 `session.json`）就是登录凭据：放本地、权限收紧、永不提交、永不发送到任何地方、不进记忆、不进 hook 检测脚本。Project A 的 AGENTS.md 亦明文要求如此。
- 发往微信的消息属于“消息发送”类动作：按审批规则，hook worker / 定时任务的发送需要“单任务 lasting allow”或每次审批。教程完全没有提审批，落地时必须先确认这条链路的审批授予方式，否则会出现“worker 已生成回复但发送被审批卡拦住”的情况。
- Hook 检测脚本（`ilink-watch.sh` 这类）不得持有 token 或凭据；它只读队列/状态目录，凭据只由 worker 回合内的 `ilink.py` 使用。

### 8. 官方通道现状（确认教程的前提说法）

- Muse 的官方消息通道目前只有 **WhatsApp**（`~/docs/chat-connections.md`：「WhatsApp is the advertised provider today」；`~/docs/muse.md` 速查表：「Messaging channels：WhatsApp」）。Discord 与短信没有此类通道。
- 个人微信没有 Muse 官方连接器；ClawBot / iLink 方案是腾讯官方 Bot 协议 + 社区或自研桥接实现，不是 Muse 官方功能。Muse 默认回复“不支持个人微信”是符合产品现状的，教程用“提供协议文档让 Muse 自行编写桥接”的方式绕过这一默认回答。
来源：`~/docs/chat-connections.md`；`~/docs/chat-connections/whatsapp.md`；`~/docs/muse.md`。

---

## 附：来源清单

| # | 来源 | 用途 |
|---|---|---|
| 1 | https://upgpts.com/tutorials/muse/muse-wechat | 第一部分全部（Project C 教程） |
| 2 | https://github.com/tencent/openclaw-weixin/blob/HEAD/docs/protocol_zh_CN.md | 教程第二步引用的协议文档（本笔记未重读，见 Project B 笔记） |
| 3 | https://developers.weixin.qq.com/doc/aispeech/knowledge/openapi/Clawbotrelated.html | 教程第二步引用的微信开放平台文档（本笔记未重读） |
| 4 | `~/docs/chat/scheduling-and-watching.md` | Hook 脚本位置/状态、systemd 服务、恢复、验证 |
| 5 | `~/docs/scheduling-and-watching.md` | 轮询本质、后台运行、cron 能力、审批阻塞 |
| 6 | `~/docs/muse.md` | 产品定位、消息通道、模型、审批卡不可见 |
| 7 | `~/docs/memory.md` | 记忆的保存与共享、遗忘 |
| 8 | `~/docs/privacy-and-credentials.md` | 凭据规则、审批与 lasting allow、权限只读 |
| 9 | `~/docs/chat-connections.md`、`~/docs/chat-connections/whatsapp.md` | 官方通道只有 WhatsApp |
| 10 | `~/docs/data-handling.md` | 数据来源与私人信息边界 |
| 11 | `hooks` / `cron` 工具命名空间说明（工具 schema） | Hook 配置参数与脚本协议、cron 种类/超时/重试/owner |
| 12 | https://dev.meta.ai/docs/muse-code/extending | Muse Code 的 Hook / 子代理 / MCP / headless（对照用） |
| 13 | https://dev.meta.ai/docs/muse-code/interactive（搜索结果摘要） | Muse Code `/loop` 与 hook 提及（对照用） |
| 14 | `~/workspace/muse-wechat-unified/research/project-a/`（`AGENTS.md`、`examples/muse-hook/README.md`、`ilink-watch.sh`、`ilink-warm-wait.sh`） | 本地生产实证：hook 驱动桥接的完整做法 |
