# MEMORY_SYNC_SPEC.md — M2 记忆与知识同步规范

> 状态：规范 + 存储骨架已完成；**双向读写行为测试（A/B）待登录后执行**，通过前不宣称“已完全同步”。

## 1. 两层记忆

| 层 | 存放 | 读写方 | 说明 |
| --- | --- | --- | --- |
| 原生长期记忆 | `~/MEMORY.md` + `~/memory/` | Beacon 本体（主聊天与 Hook worker 共用） | 同一智能体、同一 VM、同一份文件；Hook worker 与主会话天然共享 |
| 共享知识库 | `knowledge/knowledge.db`（SQLite FTS5）+ 原始文件 | App 与微信 worker 共用 | 原始文件留在原地，库里只存抽取文本 + 元数据 + FTS5 索引 |

原则：**不另建记忆库**。微信对话不回写主聊天；微信侧只记任务摘要与 `bridge/data/chatlog.md`。

## 2. 知识库结构

- `knowledge/schema.sql`：`docs` 表（id/source/path/title/mtime/text/meta）+ FTS5 虚拟表（content 同步触发器）+ source/path 索引。
- `knowledge/indexer.py`：按源遍历、按格式抽取文本、mtime 增量索引。支持 md/txt/csv/json/py/js/ts/html/tex/typ/yaml/sh、pdf（PyMuPDF）、docx、xlsx、pptx、epub（pandoc）。
- `knowledge/search.py`：FTS5 检索 + snippet；裸多词查询自动按 OR 处理（中文短语查询需加引号或显式 OR）。
- 正文截断上限 1MB；不支持的格式跳过并计数，不静默失败。

## 3. 内容源（待接入）

| 源 | 状态 | 接入方式 |
| --- | --- | --- |
| 项目文档（docs/、research/、bridge/） | 已索引（60 篇，2026-11-12 实测） | `indexer.py --source project-docs --root docs ...` |
| ChatGPT 资料库（321 项，GitHub） | 未接入 | 登录后克隆到本地只读目录再索引；不把原件复制进知识库 |
| Obsidian 知识库（GitHub 私有） | 未接入 | 登录后克隆到本地只读目录再索引；遵守 vault 的分支/PR 规则，不直接改 main |
| 微信对话摘要 | 未接入 | 只记任务摘要，不记全文；chatlog.md 保留在 bridge/data/ |

## 4. 记忆分类与可信度

- 事实（verified）：用户亲口说、或经工具验证；来源写清。
- 推断（inferred）：GPT 标注或 Beacon 的合理推测；不得当作事实用。
- 未知（unknown）：明确写不知道，不靠推测填补。
- 冲突：以最新、用户最新确认为准；旧条目在 `MEMORY.md` 中修正，不在旧日志里涂改（旧日志加修正注记）。
- 记忆不回写规则：微信侧对话内容不进 `MEMORY.md`，除非用户在主聊天明确要求。

## 5. 同步规则

- App 写 → Worker 读：Worker 回合开始时读最新 `MEMORY.md` / `~/memory/` 与 `knowledge.db`；不缓存旧版。
- Worker 写 → App 读：Worker 把任务结果写出到 outbox 与任务文件；需要长期记住的结论由主会话（收到 handoff 后）写入 `MEMORY.md`，Worker 不直接改记忆文件。
- 任务状态：以 `queue/` + `outbox/` 文件为准，跨端查询读同一份文件；状态机：pending → processing → done/failed；outbox：pending → sent/failed/unknown。
- 删除：用户要求删除某条记忆时，从 `MEMORY.md` 与知识库中同时删除，并在当日记录中留一条“已删”注记（不保留原文）。

## 6. A/B 双向测试协议（登录后执行，全部通过才算 M2 完成）

| 测试 | 步骤 | 通过标准 |
| --- | --- | --- |
| A1 App → 微信 | 主聊天写一条测试事实到 `MEMORY.md`（如“测试标记：微信可见”），微信发“你还记得测试标记吗？” | Worker 在微信回复中准确引用该事实 |
| A2 微信 → App | 微信发一条测试事实（如“我最近在看《X》”），Worker 处理后主聊天问“微信那边刚说了什么？” | 主会话能从 handoff/任务记录中找到该事实 |
| B1 任务状态跨端 | 微信发一个任务，主聊天问“微信任务进行到哪了？” | 主会话读 `queue/`/`outbox/` 给出准确状态 |
| B2 文件跨端 | 微信发一个文件，App 端问“微信刚发的文件内容是什么？” | 主会话读到同一文件并复述关键内容 |
| B3 知识库跨端 | 在知识库中新索引一篇文章，微信问其中内容 | Worker 用 `search.py` 检索并准确回答 |

每项记录 PASS/FAIL + 证据（消息截图/文件路径/时间戳）；任一 FAIL 即 M2 未完成，需修复后重测。

## 7. 已知限制

- FTS5 unicode61 对中文按字切分：单字与 OR 查询好用；裸多词短语需加引号（search.py 已做 OR 归一化）。
- 索引不含图片内容（OCR 文本可后续加入）；音频/视频只索引元数据与抽帧描述。
- 首次索引 ChatGPT 资料库需克隆约 1GB（含 LFS 大文件），注意磁盘与时间。
