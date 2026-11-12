# 项目 A 研究笔记：wechat-ilink-muse-bridge（Muse Hook + iLink 核心架构）

- **仓库**：https://github.com/gfydfhcf/wechat-ilink-muse-bridge
- **本地克隆**：`~/workspace/muse-wechat-unified/research/project-a/`（只读研究，未安装、未登录、未生成二维码、未碰凭据）
- **版本**：v1.3.2（`VERSION = "1.3.2"`），HEAD 提交 `f74de42`（Preserve local BRIDGE override across update-to）
- **LICENSE**：**MIT**，Copyright (c) 2026 gfydfhcf
- **语言/依赖**：Python 3.10+，纯标准库 + 唯一硬依赖 `cryptography`（媒体 AES 加解密）；CI 跑 Python 3.10/3.11/3.12，`python -m py_compile` + `unittest discover`
- **定位**：把 Muse 个人助理本体（有长期记忆、目标管理、主动提醒）接进微信；基于腾讯官方 iLink / ClawBot 协议（`ilinkai.weixin.qq.com`），扫码授权，不逆向、不挂个人号
- **研究时间**：2026-11-12；已完整阅读 README.md、AGENTS.md、ilink.py（3724 行）、daemon.py（550 行）、examples/muse-hook/（README + ilink-watch.sh 381 行 + ilink-warm-wait.sh 75 行）、SECURITY.md、tests/（35 个文件）、.github/workflows/ci.yml，并实跑测试套件验证

---

## 1. 整体架构

```
微信用户 ──消息──> iLink 服务器
                      │  getupdates 长轮询（服务端 hold ≤35s）
                      ▼
              ilink.py poll（两段式：只拉取，不推进游标）
                      │  批次原子落盘
                      ▼
        ilink-pending.json ──> worker（Muse agent 本体）认领并处理
                      │  合并连发、生成回复
                      ▼
              ilink.py send ──> 微信
主动推送：任意程序 ──> ilink.py proactive（缓存的 context_token）──> 微信
```

核心是一个**无框架的单一 Python 客户端 `ilink.py`**（CLI 工具，约 30 个子命令），两种轮询驱动二选一：

| 驱动 | 定位 | 入口 |
| --- | --- | --- |
| Muse hook（生产在用） | 利用 Muse 运行时的 agent 调度，不另起常驻进程 | `examples/muse-hook/ilink-watch.sh`，每 ~5s 跑一轮 |
| 独立 daemon（示例驱动） | 任何服务器/VPS 上的常驻长轮询循环 | `daemon.py`（`--echo` / `--llm` 演示 handler） |

两种驱动只能二选一，由共享驱动锁强制执行（见 §6）。Docker 部署是第三条路线（daemon 挂在自有 VPS/NAS 上 24h 跑，不依赖 Muse 环境；登录态与媒体放在 `./data` 卷）。

### 数据目录（默认 `./data/`，`ILINK_DATA_DIR` 覆盖；全部是私密数据）

| 文件 | 内容 |
| --- | --- |
| `session.json` | 登录凭证 `bot_token`、游标 `cursor`（get_updates_buf）、`login_at`、`baseurl`；**等同密码**，已进 `.gitignore` |
| `owner.json` | `{"owner_id": "<主号>", "owner_ids": ["<id>", ...]}` 主人白名单 |
| `contacts.json` | `from_user_id -> {context_token, typing_ticket, updated_at}`（主动推送与 typing 的票据缓存） |
| `seen_ids.json` | 最近 500 条已投递 `message_id`（入站去重） |
| `quote_cache.json` | 引用原文缓存 `by_id` + `by_svr`（见 §9） |
| `send_ledger.json` / `send_ledger.lock` | 幂等发送账本 + 进程间锁（见 §8） |
| `send_audit.jsonl` | 每条发送审计记录（上限 1000 行；只记 id/结果/错误类型，**不记正文、不记 token**） |
| `unknown_senders.json` | 被白名单挡下的发信人（待批名单，最多 100 条，只记 id/次数/时间，不记内容） |
| `media/` | 下载/待发的媒体文件；`chatlog.md` 对话记录；`poll.log`（上限 500 行）；`alert-state.json` 告警状态机；`rescan_notified` 过期标记；`bind_state.json` 绑定进度 |

Hook 状态目录另在 `~/hooks/state/`（`ILINK_HOOK_STATE_DIR`，旧变量 `ILINK_HOOK_STATE` 兼容）：`ilink-pending.json`、`ilink-processing.json`、`ilink-warm.json`、`ilink-heartbeat`、`ilink-watch.lock`、`ilink-driver.lock`、`ilink-commit-pending.json`、`ilink-watchdog-state.json`。

**贯穿全仓的两条铁律**：
- **stdout 是机器可读通道**：`poll` 的 stdout 必须是纯 JSON，所有诊断/警告一律走 stderr（代码注释明确说明，hook 用 jq 解析、daemon 用 `json.loads`，多一行就坏一批）。
- **原子写**：所有状态文件都用 tmp + `os.replace` 原子写，敏感文件权限 0600。

---

## 2. Muse Hook 唤醒机制到底怎么工作

这是本项目最核心的设计：**hook 脚本只做"轮询 + 落盘 + 唤醒"，不做任何模型推理；worker 就是 Muse agent 本体**（被唤醒后在自己的回合里用真实工具干活，再调 `ilink.py send` 回微信）。

### 2.1 每一轮 hook（`ilink-watch.sh`，每 ~5s 触发一次）

顺序非常讲究（顺序本身就是正确性的一部分）：

1. **单实例锁**：`exec 9>ilink-watch.lock` + `flock -n`，拿不到就安静退出（防重叠触发互相覆盖）。
2. **共享驱动锁**：`exec 8>ilink-driver.lock` 非阻塞尝试，拿不到说明 daemon 在跑，本轮安静退出——**且必须在 touch 心跳之前检查**，否则被挡住的 hook 也会刷新心跳，误导 daemon 以为 hook 还活着。
3. **touch 心跳**：`ilink-heartbeat`（看门狗的唯一依据；安静轮次不写 poll.log，只有心跳能证明 hook 活着）。
4. **补交 commit**：若上一轮 commit 失败留下了 `ilink-commit-pending.json`，先补交；补交成功前**不 poll**（否则新旧批次交叠出重复处理）；账本损坏则隔离丢弃（游标停在原地，下轮原样重拉，不丢消息）。
5. **崩溃回收**：`ilink-processing.json` 的 **ctime** 超过 10 分钟且 pending 为空时，`mv` 回 pending。关键细节：必须用 ctime 而非 mtime——`mv` 认领保留 mtime（消息落盘时间），若消息在 pending 里积压超 10 分钟，认领瞬间就会被误判过期打回 pending，形成乒乓循环；ctime 才是真正的"被认领时间"。pending 非空时不回收（否则 mv 会覆盖未处理的新批次 = 永久丢失）。
6. **pending 非空分支**：直接 wake（不再拉新消息），并立即点亮 typing（仅当发信人是 owner）；若积压已超 10 分钟且距上次告警 ≥1 小时，wake payload 带 `stuck_alert`。
7. **warm 检查**：若 `ilink-warm.json` 心跳新鲜（≤45s）且未过总上限，说明已有上下文就绪的 worker 在守候——只落盘、不重复 wake。
8. **长轮询一轮**：`timeout 120 python3 ilink.py poll`（服务端 hold ≤35s；120s 封顶防病态媒体批次拖住队列数十分钟）。
9. **分支处理**（按输出前缀）：
   - `TOKEN_STALE*`：-14 退避窗口内，静默，不告警、不记故障；
   - `NO_TOKEN*` / `TOKEN_EXPIRED*`：过期告警状态机（首报立即 wake + touch `rescan_notified`；之后每小时复报一次，payload 带 `repeat/hours`）；
   - `POLL_ERROR*` 或非法 JSON/缺 `msgs` 字段：**一律按轮询故障处理**——进程硬崩溃（空输出）若不进本分支会被误判成"没有新消息"，故障永远不告警；连续失败满 10 分钟才 wake `poll_failing`（防抖动误报），之后每小时复报；
   - 成功：先做恢复记账（曾告警过的异常恢复后 wake `recovered` 报平安；短暂抖动未告警的静默清除）；有新消息则原子落盘 pending（`jq -c '{msgs}'` 写 tmp 再 `mv`），**落盘那一刻立即点亮 typing**（不等 worker 冷启动），再调 `ilink.py commit` 提交游标（见 2.4 的 commit 账本）。
10. **每小时一次后台 `version-check --notify`**（不阻塞消息处理；未订阅只打印 `NO_SUBSCRIBERS`）。

hook 依赖 Muse 运行时提供的环境：`source "$HATCH_HOOK_RUNTIME"` 提供 `wake` / `silent` / `log` 三个 shell 函数，`$HATCH_HOOK_DRY_RUN` 标记 dry-run（dry-run 不写状态、不落盘、不提交）。

### 2.2 worker 被唤醒后的契约（AGENTS.md 的工作流）

1. **原子认领**：`mv ilink-pending.json ilink-processing.json`——多个重复唤醒里只有一个能拿到队列，其余安静退出。
2. **立即续租**：认领后马上 `touch` processing 文件，之后长耗时工作期间约每 60s 再 touch 一次。hook 按 ctime 超 10 分钟回收；活着但慢的 worker 停 touch 会被误判死亡，批次被重新唤醒导致双 worker 各回一遍。**第一次 touch 是强制的**，周期性 touch 是保命的。
3. **读消息**：image/file 条目带已下载的 `media_path`——worker 要真的打开看/读（PDF/Office/文本/代码），大文件（~50KB+）先回一句短收据再采样读，并引用至少一个只有真读才能知道的细节；只有 `media_error` 或格式确实不可读时才说打不开；视频内容目前看不到。
4. **先查两件事再回正经话**：① 订阅关键词（精确匹配 `订阅`/`订阅更新`/`取消订阅`，或 24h 内 welcome 提问标记下的肯定/否定回答）→ 调 `subscribe`/`unsubscribe`，回复就是一句确认，不叠加闲聊；② 更新安装（24h 内 `update_offer.json` 标记 + 肯定回答，或关键词 `安装更新`）→ 先 `version-check`，有新版才 `update-to <tag>`，并按输出组织汇报（成功必须说明"AGENTS.md 不能自动升级，改了就去看 AGENTS.md.new"；失败说明已回滚）。
5. **发送前复查（连发合并）**：回复组织好、真正发出之前再看一眼 pending，有新消息就合并进来、按最新上下文重组，只回一条；最多 3 轮。内容自然分段时可拆成 2–3 个短气泡（先接一句、再说正事、最后问一句），绝不把一句话硬切两半，也绝不一消息一回复。
6. **幂等发送**：`ilink.py send <to> <ctx> - --key <批次首条 message_id>`；多气泡时 key 加气泡序号后缀（`<id>-1`、`<id>-2`），否则后几个气泡会被账本当重复拦住。**绝不手动重试失败的发送**（客户端已用同一 client_id 重试一次）。
7. **typing 续期**：组织超过 30s 刷新一次 typing，发完停掉。
8. **回复后守候**：跑 `ilink-warm-wait.sh` 而不是直接结束回合（见 §5）。

### 2.3 结果如何回到微信

worker 调 `ilink.py send`（回复）或 `proactive`（主动推送）→ `ilink.py` 发 `POST ilink/bot/sendmessage`（`message_type=2, message_state=2`，带入站消息的 `context_token`，`client_id` 随机生成或由账本复用）→ 服务端返回 `message_id` 即确认；媒体则先走 `getuploadurl` + AES 加密 + CDN 上传再发（见 §10）。发送成功后把 `message_id` 记进引用缓存（自己发的消息之后也可被引用）。

### 2.4 两段式 poll / commit（交付语义：至少一次 at-least-once）

- `ilink.py poll` **只拉取、不推进游标、不记去重 id**，输出 `{"msgs": [...], "filtered": {...}, "commit": {"cursor": ..., "ids": [...]}}`。
- 调用方（hook/daemon）把批次**可靠落盘/入队后**，才把 `commit` 块通过 stdin 交给 `ilink.py commit`。
- `commit` 的写入顺序是 **先记 seen ids，再推进游标**：死在中间时，未推进的游标让服务端重投，seen ids 把重投过滤掉——重复轮询，不重复回复。旧顺序（先游标后 seen）会在 seen 写丢时让重投变成"新消息"。
- hook 还有一层 commit 账本：调 commit 前先把 payload 原子落盘到 `ilink-commit-pending.json`，成功才删；失败时下一轮开头先补交，补交成功前不 poll。
- 崩溃窗口内的同一批消息会被重投（可能重复，绝不静默丢失）；防线是 seen 去重 + 发送账本。

---

## 3. 长轮询

- 端点 `POST ilink/bot/getupdates`，body `{"get_updates_buf": <游标>, "base_info": {"channel_version": "1.0.2"}}`，请求头 `AuthorizationType: ilink_bot_token` + `Authorization: Bearer <bot_token>` + `X-WECHAT-UIN`（随机 uint32 的 base64）。
- 服务端 hold 连接最长 35s，有消息立即返回；hook 每轮 `timeout 120` 封顶，daemon 的 `poll_once` 子进程 timeout 180s。
- 游标 `get_updates_buf` 持久化在 `session.json` 的 `cursor` 字段；首次为空串；只有非空的新游标才保存。
- 失败处理：网络异常 → `POLL_ERROR:<异常>`（hook 记入告警状态机）；业务码 `-14` → token stale/过期状态机（见 §12）；daemon 侧指数退避（1s 起，封顶 30s），poll 子进程本身超时也不杀 daemon，只记 `POLL_EXCEPTION` 继续循环。
- 注意：`channel_version` 用的是 `"1.0.2"`，与腾讯协议文档示例的 `2.4.8` / 当前插件 3.x 不同——项目生产实测可用，但这是与官方插件版本的显式差异，复用时要先验证服务端是否仍接受。

## 4. 消息持久化

- 全部落在 `ILINK_DATA_DIR` 的 JSON 文件（见 §1 表），不引入 SQLite/数据库；写操作一律 tmp + `os.replace` 原子替换，敏感文件 0600。
- **contacts 缓存**：每次 poll 收到 owner 消息就合并更新 `context_token`（用 `setdefault().update()` 合并而非整体替换，否则会丢掉同条目里缓存的 `typing_ticket`）；损坏文件降级为空缓存 + stderr 警告，不 crash。
- **聊天记录**：worker 把对话记进 `chatlog.md`（`[日期] 用户：/我：` 行格式），`rotate-chatlog` 按月归档往月行到 `chatlog-YYYY-MM.md`，当月行保留（读最后 30 行的习惯不受影响；幂等，缺文件不报错）。
- **媒体保留**：`prune-media` 默认 30 天 + 500MB 上限，先删过期、再按 mtime 从旧到新删到上限；**引用缓存仍指向的文件豁免**（两 pass 都不删）；单个文件不可删只跳过、不致命；支持 `--dry-run`。
- **损坏隔离策略分两级**：quote/contacts 这类"丢了只影响体验"的缓存损坏 → 降级为空 + 警告继续跑；send ledger 这类"丢了会重复发消息"的账本损坏 → **fail-closed**，拒绝发送等人来处理（见 §8）。

## 5. Warm Wait（回复后守候，连聊免冷启动）

`ilink-warm-wait.sh`：worker 回复后不退出，守候默认空闲 180s、连聊总上限 1800s，每 5s 检查一次：

- 维护标记 `$STATE_DIR/ilink-warm.json`：`{since, activity, heartbeat, until}`；`since` 跨 successive wait 继承（总上限覆盖整个 warm session，死会话留下的标记因 cap 已过会立刻结束本次调用）。
- 输出恰好一行：`NEW_MESSAGES`（pending 里有批次 → worker 直接认领处理，**不重读记忆/上下文文件**，上下文已在内存里；但发送前仍要复查 pending、照常记 chatlog，处理完再 wait）、`IDLE_TIMEOUT`（180s 无人说话 → 删标记、安静退出）、`TOTAL_CAP`（30 分钟总上限到 → 退出，下条消息重新冷启动唤醒）。
- hook 侧：`warm_alive()` 判定心跳 ≤45s 且未过 `until` → 只落盘不重复 wake；**带 `recovered` 的 wake 例外照常发**（免得恢复通知被吞；双 worker 靠 mv 原子认领仲裁）。
- 自愈：worker 死了，心跳过期，hook 自动恢复正常 wake。

## 6. 单驱动锁

两把锁，分工不同，都用 `flock`（Unix；Windows 无 fcntl 时 daemon 锁退化）：

- **`ilink-driver.lock`**（状态目录下，hook 与 daemon 共享）：daemon 启动时常驻持有；hook 每轮非阻塞尝试。先跑起来的驱动赢，后到的安静让路。daemon 启动还有第二道门：若 hook 心跳 `ilink-heartbeat` 新鲜（默认 120s 内）直接拒绝启动（退出码 2）——因为 hook 只在每轮短暂持锁，光查锁会在两轮间隙让 daemon 偷走驱动权。daemon 自己绝不 touch 心跳（那是 hook 的存活信号）。状态目录不可用时 daemon 退到数据目录的锁并明确警告（hook 看不到这把锁，是已知局限）；连退路都没有才无锁继续跑并警告。
- **`ilink-watch.lock`**：只防 hook 自己重叠（每轮持 fd 到脚本结束；不要用 `flock` 命令包裹子命令，会漏段落）。

**前提**：两个驱动必须指向同一个状态目录，锁才共享；`ilink.py health` 检查的也是同一目录。

## 7. 连发消息合并

问题：用户连发几条，iLink 会拆成多个响应；逐条回显得机械，还会慢一拍答非所问。同类 SDK 都不做这个。

- **daemon**：`collect_burst()`，`MERGE_WINDOW`（默认 25s）是**空闲窗口而非总上限**——每轮 poll 回来新消息就把 deadline 再推后 25s；空 poll（服务端一次完整长轮询无消息）即判定 burst 结束。窗口是近似的（只在 poll 之间检查，一次长轮询可超窗）。burst 内按 `message_id` 去重（每轮 poll 都在 commit 之前，游标未推进，服务端可能从旧游标重放；无 id 的条目永不丢弃；只有真正的新消息才延长窗口，重放不延长）。handler 收到的是按用户分组的一整轮 burst，回复用**最后一条的 `context_token`**。
- **hook/worker**：不做固定等待，而是**发送前复查** pending——回复组织好、真正发出之前再看一眼，有新消息就合并进来按最新上下文重组，最多 3 轮；最后只回一条（内容自然分段时可拆 2–3 个短气泡）。
- 回复形态（AGENTS.md 契约）：短句优先、长句拆短句、先给结论再说细节、说大白话、不用模板套话（无"首先/其次/最后"、无"总之"、无"作为 AI 助手"）、不重复上一条回复的开头、情绪不跳变、隔夜隔天自然接续；复杂技术内容允许长句保真，短句默认不压倒准确；发出前按语气、长度、用词、结构、情感直接度自检一遍。

## 8. 幂等发送（发送防重复）

背景：2026-10-23 诊断发现，重复发送的根因是**两次独立的发送调用各带新 `client_id`**，服务端按 `client_id` 的去重拦不住；2026-10-27 凌晨还出过一次事故：worker 拼发送命令漏了正文占位符 `-`，防重复的 `--key` 滑进正文位置被原样发给用户（截图 `docs/key-incident.jpg`）。

实现（`send_ledger.json` + `send_ledger.lock` + `send_audit.jsonl`）：

- `--key <id>`（约定用批次首条消息的 `message_id`）：同一 key 的重复调用直接打印 `SEND_ALREADY_SENT`，不调 API。
- **先落意图再发送**：首次调用在账本里持久化 `{client_id, at, status: "intent"}`（固定一个 client_id），**只有确认成功才翻转为 `status: "sent"`**；应用层失败/异常都保留 intent，重试复用同一 `client_id`——服务端按 client_id 去重（2026-10-23 实测验证），于是"发了但没收到回执"的窗口也被兜住。重试带不同正文时用户最多收到第一份正文（去重重试不重投）。
- **进程间锁**：整个"查账本 → 写意图 → 调 API → 标记已发送"临界区持 `flock`（线程内可重入；fcntl 不可用时锁退化为 no-op，仅剩意图/client_id 复用兜底，且文档明确写出）；拿不到锁直接 `LOCK_ERROR` 退出 1，**绝不无锁发送**。
- **fail-closed**：账本损坏（JSON 解析失败/顶层非对象）抛 `LedgerCorrupt`，发送在任何 API 调用前中止；**不自动隔离、不回退空账本**（空账本会忘掉已记录的成功，下一次重试就用新 client_id 重发）。恢复靠人工检查后移走文件。账本写失败同样不报成功——调用方报告未确认（非零退出、无 `SEND_OK`），驱动不 commit 批次，重试复用同一 client_id，服务端去重兜底只投递一次。
- 账本条目 TTL 24h，写时剪枝；无 `status` 字段但 `result: "ok"` 的旧条目视为已发送（向后兼容）。
- **发送重试策略**：网络层异常用同一 client_id 最多重试一次（间隔 5s）；应用层明确失败（`code != 0` 且非 -14）不重试；**绝不手动重试失败的发送**（worker 契约）；`code == -14` 一律走 token 过期/ stale 状态机。
- **正文守卫**（`_validate_send_text`，事故后补的）：空正文、以 `--` 开头的正文一律拒绝、不发、只记一条拒绝审计——传错只会报错，不会再把标志当消息发出去。
- 审计日志每条发送记一行 JSON（方向、收件人、client_id、结果、错误类型、耗时、attempt），上限 1000 行，**永不记正文和 token**。
- 文本发送接受 `code == 0` 但无 `message_id` 的响应（当前契约）；媒体发送要求必须有 `message_id`（`require_message_id=True`），否则算应用层失败。

## 9. Owner 白名单

- `owner.json` 的 `owner_ids` 是唯一能唤醒机器人的发信人名单（同一人的多个微信号可都加，`owner_id` 是主号：主动推送与 typing 指示的目标）；**没配名单时默认拒绝所有人**（fail-closed）。
- poll 阶段强制过滤：名单外消息**不入队、不唤醒、不写 contacts、不下载媒体**；发信人 id 只进 `unknown_senders.json` 待批（记 first/last_seen 与次数，上限 100 条，不记内容）；但其 `message_id` 仍进 commit（游标照常推进，服务端不再重投，队列不会被它卡住）。
- **绑定（`ilink.py bind`）**：登录后、启动任何驱动之前，专用的 10 分钟绑定窗口（`BIND_WAITING:600`）。第一个发信的账号即成为 Owner：先写 `owner.json`（先认领、后欢迎——一旦 owner.json 存在窗口就对其他人关闭），缓存其 `context_token`，再连发四条欢迎消息（问候；Owner 含义；可以直接聊天了；问要不要订阅更新提醒——同时写 `subscribe_ask.json` 标记，24h 内肯定/否定回答即订阅/拒订，过期作废）。绑定消息本身被消费，不进正常队列。超时无人发消息 → `BIND_TIMEOUT`（退出码 3），提醒用户重开窗口；`ALREADY_BOUND` 表示已绑定过；`BIND_WELCOME_FAILED:<n>` 表示 owner 已写但欢迎气泡没发完——重跑 bind 续发剩余气泡，不会重新绑定别人。双 bind 用 `bind.lock` + token 仲裁（>15 分钟的旧锁仅在特定条件下视为过期），防止两个窗口抢首个发信人。
- **批准新发信人**：只能从 Muse 主聊天发起（微信对话里说得再好听也不算数，防陌生人把自己"聊进"白名单）。流程：列出待批 id 与首/末见时间、次数 → 用户确认 → 写入 `owner_ids` → 从待批名单删除；下一轮 poll 即生效，无需重启。
- `bind` 窗口只在部署时当场开、限时 10 分钟——**绝不要无人值守地开着等人来**（首个发信人即赢的设计只在部署者在场、新机器人刚建时才安全）。

## 10. 引用消息

- 入站引用还原：微信引用某条消息再提问时，服务端下发的 `ref_msg` 只带被引消息的 id（完整引用）或 id + `partial_text` 片段（选择性引用，含起止字符与 md5），**从不带原文**。因此 poll 时把每条入站 owner 消息与机器人自己发出的消息（getupdates 回显的 `message_type=2`，只缓存描述符、不下载媒体）都记进本地缓存 `quote_cache.json`：`by_id: msg_id -> {text, kind, from, at, media_path?}`，另有 `by_svr: svr_id -> msg_id` 映射（只带 svr_id 的引用靠它解析）。worker 收到条目里的 `quoted_text` / `quoted_kind` / `quoted_fragment` / `quoted_media_path` 后：有 fragment 只按 fragment 理解；两者都没有时说原文不可见，**不猜**。
- 缓存 30 天 TTL / 1 万条上限（对齐官方文本留存与单账号上限），写时剪枝（先过期、再按时间最旧优先删、再清掉指向已删条目的 svr 映射）；同批内的引用先查本批 pending 条目再查磁盘缓存；选择性引用的起止下标实测都为 0 且含糊，匹配用字符而非下标，fragment 在缓存未命中时也照常透出（至少部分可读）。
- 机器人自己发的消息也在发送成功后立即进缓存（拿服务端回的 `message_id` 登记），不用等下轮 poll 回显。
- 缓存损坏 → 降级为空 + stderr 警告（不 fail-closed：丢缓存只丢未来某次引用的还原，绝不会导致重复发送）。
- **出站引用发不出去（通道侧不支持，2026-10-26 实测）**：往 sendmessage 加 `ref_msg` 两种形式（`message_item.msg_id` 嵌套、直接放 `msg_id` 平铺）都试过，服务端两次都返回 message_id 照常投递，但微信里只显示成普通消息、上方没有被引原文；三家独立 SDK 的 sendmessage 结构里也没有引用字段。结论：发送结构里根本没有引用这个概念。项目因此不实现出站引用，也不用"正文前贴原文"冒充引用。入站与出站不对称：入站完整引用只带被引消息的 msg_id（svr_id 只是备用查找路径）。

## 11. 主动推送

- `ilink.py proactive <user_id> -`（正文走 stdin）：先用 contacts 里缓存的 `context_token` 发；失败则**去掉 token 重试一次**（同一 client_id）。触发无 token 重试的条件：任一非 ok 结果，或 `ret == -2` / errmsg 含 `prepare failed`（stale context_token 的特征，即使 code == 0 也重试）。
- 无缓存 token 时直接 `NO_CONTEXT_TOKEN`（需要先收到过一条该用户的消息）。`context_token` 约 24h 有效（SDK 侧经验值）。
- 媒体主动推送同理（`proactive-image/file/video`）。任何程序都能调——提醒、日程、服务器告警都走这条路。

## 12. 健康监控、错误恢复与回滚

### 健康自检
- `ilink.py health`：登录时长、token 在线探活（`getconfig` 取 typing ticket——无副作用、不碰游标）、队列积压、最近轮询错误、去重记录数、白名单人数、待批人数、账本可读性；退出码 **0 正常 / 1 警告 / 2 损坏**，可直接接监控；`--offline` 跳过在线探活。损坏的 pending 队列按"损坏"报，永不报成"空"（否则卡死的批次看起来像排空的队列）。
- `ilink.py stats`：纯本地快照（不调服务端）：今日对话行数、今日发送成败、账本/引用缓存/媒体用量、登录时长、队列积压；缺文件计零，退出码恒为 0。
- `ilink.py smoke-test [--no-send]`：端到端链路检查（登录探活、接收就绪、真实 proactive 文本 + 1×1 透明 PNG 图片走生产路径发给 owner、账本可读）；每项打印 `SMOKE <name>: PASS/FAIL/SKIP`，全过才 `SMOKE_OK`；注意：故意不用 `--key`（每次必须真发，否则重复运行会打印 `SEND_ALREADY_SENT`、什么也证明不了）；诊断用的 -14 不得调用 `_report_token_status`（会翻转 stale 状态机）。

### 看门狗
- `ilink.py watchdog`（默认 30 分钟）：hook 每轮 touch `ilink-heartbeat`；心跳过期或从未存在 → 判 hook 已死；`ilink-watchdog-state.json` 记录告警跃迁，cron 每 15 分钟跑一次，**只报第一次过期（`WATCHDOG_ALERT`）与恢复（`WATCHDOG_RECOVERED`），重复过期静默（`WATCHDOG_STALE`）**；桥有意停用时 touch `ilink-watchdog-off` 即可静音，恢复时删掉。退出码 0 新鲜/恢复/已禁用，1 过期。

### 告警闭环（hook 的 `alert-state.json` 状态机）
- token 过期：首次立即 wake 报一次，之后每小时复报（`repeat/hours`）；恢复后自动清除过期标记（旧版标记永不清除会导致下一次过期不再通知，已修复）。
- 轮询连续失败：满 10 分钟才报（防抖动误报），之后每小时复报；曾告警的异常恢复后 wake `recovered` 报一句平安；短暂抖动未告警的静默清除。
- worker 卡住超 10 分钟：自动回收队列并告警（`stuck_alert`，每小时至多一次）；队列排空且无人处理中时清状态。
- 原则：**不只报坏也报好**；每小时复报封顶；`token_expired` 只通知用户重扫一次（`rescan_notified` 标记），不反复打扰。

### Token stale（-14）退避
- 官方 session-guard 把 -14 定为 "stale" 而非 "expired"：先暂停、同 token 重试，只在 -14 持续超过 1 小时窗口才宣布过期。实现：`token_stale.json` 记首次 -14 时间；窗口内 poll 报 `TOKEN_STALE`（退出 3，hook 静默继续轮询）；超窗报 `TOKEN_EXPIRED`（退出 2）；任何一次成功调用清除标记。旧行为是第一次 -14 就喊重扫，会让一次服务端抖动白白折腾用户重扫。

### 入站去重
- `seen_ids.json` 最近 500 条 `message_id`（写时保留 `max(500, 本批大小)`，防止一批大于上限时早期的 id 在游标落盘前就被滚掉）；无 `message_id` 的消息无法去重、直接放行；去重只发生在 poll（唯一入站路径），hook 与 daemon 都受保护。

### 错误恢复与回滚
- 交付语义 at-least-once（见 §2.4）；daemon 侧 handler 异常不杀进程、不 commit（游标不推进，下轮重投），连续 5 次失败只报一次 `HANDLE_FAILING` 并继续退避，**中毒批次永不自动 commit**（丢了就违反 at-least-once）。
- **自更新 `update-to <tag>`**（两阶段）：① 下载全部文件并校验（`py_compile` 级别的 Python 源码校验 + shell 的 `bash -n` 校验；版本号必须匹配 tag；Release notes 里 `ilink.py sha256: <hash>` 行比对——没这行只警告、不校验）；② 备份（`.bak-<tag>`）+ 原子替换 + 从磁盘重新校验，失败则回滚并打印 `ROLLED_BACK`。只装 Release tag，不装 main 最新代码，不认任意链接；拒绝降级；状态文件一律不碰；hook 脚本可选 `--hook-dir` 一并更新；`AGENTS.md` 变了则下载到 `AGENTS.md.new` 备查（契约无法自动升级，需人工对照改——更新通知里必须写明）；本地 `BRIDGE` 目录覆盖在更新中保留（`_preserve_bridge`）。`rollback` 从最新 `.bak-*` 恢复，全部目标先校验通过才换，当前文件先另存 `.bak-pre-rollback-<epoch>`（回滚本身也可逆），换完后尽力跑一次 `health --offline` 报 verdict（不影响退出码）。
- `preflight`：登录前环境预检（Python ≥3.10、`cryptography` 可导入、到 `ilinkai.weixin.qq.com` 的网络可达——任何 HTTP 响应都算通、仅传输失败算不通、数据/媒体目录可写），不登录、不碰状态。
- `version-check`：查上游最新 Release；`--notify` 只发已订阅主人、每版本一次（`version_notify.json` + 进程锁防并发通知）；订阅状态 `subscribe`/`unsubscribe` 命令管理，通知写 `update_offer.json` 标记供 worker 识别安装意图。

## 13. 登录鉴权

- `ilink.py qrcode`：`GET ilink/bot/get_bot_qrcode?bot_type=3`，`qrcode_img_content` 是 data URI 时解码存为 `data/qrcode.<ext>` 并打印 `QR_IMAGE:<路径>`，是 http URL 时打印 `QR_URL:<url>`，同时打印 `QR_CODE:<qrcode>`。
- `ilink.py login <qrcode>`：轮询 `GET ilink/bot/get_qrcode_status?qrcode=...`（35s 超时），最长 300s。状态分支：`confirmed` → 保存 `bot_token`/`baseurl`/`login_at` 到 `session.json`，打印 `LOGIN_OK`；`expired` → 自动刷新二维码（最多 3 次，**不延长总 deadline**——旧实现 3 次刷新会把 300s 拖成 1200s）；`binded` / `binded_redirect` → 有 `bot_token` 即视为成功；`redirect` / `redirect_url` → 跟随一次并接受跟随后返回的 confirmed；`need_verify` / `verify_url` → 打印验证 URL 让人去微信里完成，需输码时从 stdin 读一行随下次轮询提交（`verify_code` 参数）；`canceled` → 失败；超时 → `LOGIN_TIMEOUT`。
- 登录态寿命不确定：社区早期经验约 24h，项目生产实测一次登录稳定运行 3 天以上未过期（2026-10），可能因账号而异；过期需重新扫码（"过期只通知一次"，重扫还得人来）。

## 14. 媒体收发（图片回传的关键路径）

### 发送（`_upload_media` + `_media_item`）
1. `POST ilink/bot/getuploadurl`：`filekey`（随机 128bit hex）、`media_type`（注意：**这是另一套枚举**，1=IMG、2=VID、3=FILE、4=VOICE，与消息 item 类型 2=IMAGE、3=VOICE、4=FILE、5=VIDEO 不同，必须映射 `{2:1, 3:4, 4:3, 5:2}`）、`rawsize`、`rawfilemd5`（明文 MD5）、`filesize`（加密后大小）、`aeskey`（16 字节密钥的 **hex 字符串**）、`no_need_thumb: true`。
2. AES-128-ECB + PKCS#7 加密全文，`Content-Type: application/octet-stream` POST 到返回的 `upload_full_url`（优先）或拼出的 CDN URL（`{CDN}/upload?encrypted_query_param=...&filekey=...`）；成功标志是响应头 `x-encrypted-param` 非空（即下载参数）。
3. `sendmessage` 带媒体 item：`CDNMedia.aes_key` 用 **base64(hex 字符串)**——与 getuploadurl 的 hex 形式不一致，是协议坑之一（代码注释明确标出）。图片 item 另带 `mid_size`（密文大小）、视频 `video_size`、文件 `file_name` + `md5` + `len`（明文字节数的十进制字符串）。
4. 媒体发送要求响应必须带 `message_id`，否则算失败；单文件上限 100MB（协议要求整文件一次加密上传，整读进内存，超了直接拒绝，宁可 upfront 拒绝也不让大文件吃光进程内存）。

### 接收（`download_media_item`）
- 取 `media.full_url`（优先）或按 `encrypt_query_param` 拼 CDN 下载地址；AES 密钥优先 `image_item.aeskey`（hex），其次 `media.aes_key`（base64，解出 16 字节原文或 32 字节 hex 再转）；AES-128-ECB + PKCS#7 解密。
- **断点续传**：HTTP Range 分段下载（`_http_get_range`，`Content-Range` / `Content-Length` 算总长），中断后从已下载字节数续传，最多 4 次、指数退避（2s、4s、6s、8s）；弱网下整图重下经常死在 90%，续传是实测刚需。`IncompleteRead` 内部消化为 `complete=False` 继续续传；206 且已有内容才追加，否则以本次响应为准；超 100MB 拒绝（与发送侧同一上限）。
- 语音入站带微信自动转写文本（`voice_item.text`）；文件按原文件名取扩展名保存；所有下载失败只记 `MEDIA_ERROR:<原因>` 到 stderr，**绝不污染 poll 的 stdout JSON**；下载失败的条目记 `media_error`，worker 据此判断而非猜测。

### 已知媒体限制
- **发不出语音条（官方限制）**：可收语音（带转写），但发的语音条会被 iLink 通道服务端静默丢弃（接口返回成功、客户端永不显示），项目与多个独立 SDK 均实测复现；社区已在腾讯官方仓库提需求（Tencent/openclaw-weixin #91、#282），至今未开放。项目已实现并保留 `send-voice`（SILK@24kHz 全链路），官方一旦支持即可启用；此前想让机器人"出声"，把音频当文件或视频发。
- **工具调用进度消息发不出去**：协议定义了类型 11/12（`tool_call_start_item` / `tool_call_result_item`），官方插件每次调工具各发一条；按官方 `reply-progress-sender.ts` 原样构造发送（信封与官方 `send.ts` 逐项一致，带/不带 `run_id` 两种都试过），服务端两次都回 HTTP 200 但包体为空、不给 `message_id`；同一套信封发普通文本则正常返回 `message_id`。结论：服务端根本没给这类消息建消息。worker 干活时只能用"正在输入"圆点表示进度。

## 15. Typing 指示（"正在输入"）

- `getconfig` 取 `typing_ticket`（需 `ilink_user_id` + `context_token`），缓存在 contacts 里 **TTL 9 分钟**；`sendtyping` 的 `status` 1=开始、2=取消；ticket 失效时强制刷新后重试一次。
- 点亮时机三层：hook 落盘那一刻立即点亮（不等 worker 冷启动）；worker 组织回复期间每 30s+ 刷新；发完取消。daemon 侧 handler 发回复前点亮、发完取消（finally 保证）。
- 失败是装饰性的：调用方忽略失败，绝不影响正常回复流程。

## 16. 哪些设计可以直接复用、哪些只能借鉴思想需独立实现

### 可直接复用（MIT 许可，抄代码/抄参数都行；但要按我们自己的数据目录与唤醒运行时适配）

- **iLink 协议层全部细节**：`getupdates` 长轮询参数与游标语义、headers（`AuthorizationType` / `X-WECHAT-UIN`）、`sendmessage` 信封（`message_type=2, message_state=2, context_token`）、`getuploadurl` + AES-128-ECB + CDN 上传全链路（含两处枚举/编码不一致的坑：getuploadurl 的 media_type 映射、aeskey hex vs aes_key base64(hex)）、`getconfig`/`sendtyping`、媒体 Range 断点续传、-14 的 stale/expired 区分、QR 登录的状态分支（expired 自动刷新、binded、redirect、verify_code）。
- **两段式 poll/commit 与 at-least-once 语义**：先落盘再 commit、seen 先于游标、commit 账本补交——这是整套可靠性的地基。
- **发送幂等账本**：intent → sent 两阶段 + 固定 client_id + 进程间 flock + fail-closed 损坏处理 + 审计日志 + 正文守卫（防 `--key` 事故重演）。
- **Owner 白名单 + 10 分钟绑定窗口 + 待批名单**：deny-by-default、主聊天批准、绑定先认领后欢迎。
- **引用缓存**：by_id + by_svr 双索引、30 天/1 万条、fragment 透出、损坏降级。
- **告警闭环状态机**：过期首报+每小时复报、poll 失败 10 分钟才报、恢复报平安、stuck_alert；`health` / `watchdog` / `smoke-test` / `stats` / `preflight` 五件套运维命令。
- **连发合并**：发送前复查（hook 式）或空闲窗口收集（daemon 式，MERGE_WINDOW=25s 可直接抄）。
- **Warm Wait**：180s 空闲 / 1800s 总上限 / 45s 心跳新鲜度，标记文件协议可直接照搬。
- **单驱动锁**：`ilink-driver.lock` + 心跳门，防 hook 与 daemon 双跑。
- **Markdown 渲染实测结论**（Android 微信客户端 2026-10-25 三轮确认）：能渲染标题/粗体/行内代码/代码块/列表/链接/表格/删除线/引用/分割线；任务列表退化、图片语法只剩 alt、公式不成式、斜体中文不明显。
- **测试资产**：35 个测试文件、264 个测试（含 hook 集成、账本、去重、驱动锁、引用缓存、回滚、媒体续传等回归测试），可作为我们自己实现的对照清单。

### 只能借鉴思想、需独立实现（因为运行时/ worker 身份不同）

- **Hook 脚本本身**：它依赖 Muse hook 运行时的 `$HATCH_HOOK_RUNTIME`（提供 `wake` / `silent` / `log`）与"每 ~5s 触发一次"的调度——我们的 Beacon 运行时的唤醒原语不同（cron/hook 机制、唤醒投递方式），**不能直接照搬脚本**，要按我们自己的运行时重写"轮询-落盘-唤醒"这一层；但它的状态机设计（pending/processing/warm/heartbeat/alert-state 文件协议）可以直接借用。
- **worker 契约（AGENTS.md）**：它是写给"被唤醒的 Muse agent"的操作手册——认领、续租、发送前复查、订阅/更新关键词处理、拟人化回复形态。我们要按 Beacon 的实际能力（Gmail/日历/目标/提醒等真实工具、中文沟通）重写自己的 worker 契约，不能照抄它的订阅/更新流程（那是它自己的版本管理）。
- **daemon.py 的 `--llm` handler**：只是 OpenAI 兼容接口的示例，无工具调用、无长期记忆；我们的 worker 是 Beacon 本体，不需要这个。
- **自更新机制**（`update-to` / `rollback` / `version-check --notify`）：面向"从上游 Release 自动升级本桥"的场景；我们的桥若作为一次性部署给用户，是否要、以及如何做版本管理，需要单独决策（且 AGENTS.md 不能自动升级的教训说明：契约文件要与代码分开管理）。
- **Docker 部署**：面向自有 VPS/NAS 24h 常驻；我们的部署环境是 Muse 的 VM（非 24/7、重启后需恢复），启动与恢复路径要按我们的运行时设计（hook 驱动 + 看门狗 cron，而不是 `restart: unless-stopped`）。
- **数据目录布局**：`ILINK_DATA_DIR` 与 `~/hooks/state` 的双目录划分是它的约定；我们的桥要与 Beacon 现有目录结构（`~/workspace/...`、goals、hidden_files）协调，不能生搬。

## 17. 坑与限制（按"会不会在我们这边复现"排序）

1. **发不出语音条、发不出工具进度消息、出站引用发不出去**——三者都是 iLink 通道侧限制（实测确认），不是实现问题；我们的桥同样会遇到，产品层面不要承诺这三项。
2. **登录态寿命不确定**（24h 传闻 vs 生产 3 天+ 实测），过期必须人重新扫码；"过期只通知一次"、stale 窗口 1 小时是必备设计，否则会反复打扰用户。
3. **`--key` 事故**：worker 拼命令漏占位符会把标志当正文发出去；正文守卫（空正文/以 `--` 开头拒绝）必须有；`send` 的正文走 stdin 时占位符 `-` 的处理要小心。
4. **只能收到主动发给机器人的消息**：看不到主号消息、通讯录、朋友圈——协议根本没有这些端点；不要对用户承诺"在微信里读你的聊天记录"这类事。
5. **出口网络要稳**：长轮询会被跨国链路偶发切断，`POLL_ERROR` 是常客；退避重连 + 10 分钟才告警的防抖是必需的。
6. **daemon 是示例驱动、非生产级**：处理完才提交游标，崩溃窗口内同一批消息会被重投（至少一次、可能重复）；生产必须用 hook 驱动（落盘队列、崩溃恢复、告警闭环）。
7. **`channel_version: "1.0.2"` 与官方插件版本脱节**（协议文档示例 2.4.8，当前插件 3.x）：项目生产可用，但复用时要先验证服务端是否仍接受该版本声明。
8. **单批次队列**：pending 文件一次只装一批；有未处理批次时 hook 不再拉新消息（新消息要等 worker 认领处理完才轮询到）——高频连聊时延迟会叠加，Warm Wait 是缓解手段。
9. **引用缓存的冷启动缺口**：缓存建立之前的旧消息无法事后补（服务端没有按 id 取原文的接口）；机器人自发消息靠发送成功后登记，poll 回显只记描述符。
10. **媒体整读进内存**：发送/下载都整文件进内存，100MB 上限是硬性保护；大文件、弱网、/tmp 小 tmpfs 都要考虑（下载续传能缓解弱网，不能缓解内存）。
11. **AGENTS.md（worker 契约）不能自动升级**：代码能自动升，契约不行；凡改了契约的版本，更新程序只把新版下载为 `AGENTS.md.new` 备查，需人工对照改。
12. **hook 脚本依赖 jq 与 flock**：`jq` 用于所有 JSON 处理（损坏隔离、计数、状态机读写），`flock` 依赖 Unix；换环境要先确认这两者可用。
13. **测试套件实跑结果**：264 个测试中 255 通过，**9 个失败全部源于本机未安装 `cryptography`**（媒体加解密/上传的 6 个错误 + preflight 的 3 个失败，preflight 含 cryptography 可导入检查）——不是仓库缺陷；部署前 `pip install -r requirements.txt` 是必需步骤。本次研究未安装任何东西，仓库 `git status` 干净。
14. **安全红线**（SECURITY.md）：`data/session.json` 是登录凭证，等同密码；绝不提交数据目录、session 文件、登录二维码、未打码聊天记录；token 一旦泄露立即重新扫码并清理泄露副本（含 git 历史）；漏洞走 GitHub 私密报告通道，不公开提 issue。
15. **微信内斜杠命令不做**：微信输入 `/` 不弹出命令菜单，斜杠命令只是普通文字、无发现入口；精确动作（订阅/安装更新）用精确关键词匹配。
