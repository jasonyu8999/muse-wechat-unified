# knowledge/ — 共享知识库（M2）

SQLite FTS5 + 原始文件 + JSON 元数据。原始文件留在原地，库里只存抽取文本与索引。

## 文件

- `schema.sql` — 表结构（docs + docs_fts + 触发器 + 索引）
- `indexer.py` — 索引器（增量，mtime 变化才重索引）
- `search.py` — 检索器（FTS5 + snippet；裸多词自动 OR）
- `knowledge.db` — 索引数据库（2026-11-14：473 篇，Obsidian 250、ChatGPT 资料库 163、研究 51、项目文档 5、桥接 4；不进 git）

## 用法

```bash
VENV=~/workspace/muse-wechat-unified/.venv/bin/python
# 索引（可重复跑，增量）
$VENV knowledge/indexer.py --db knowledge/knowledge.db \
  --source project-docs --root docs \
  --source research --root research \
  --source bridge --root bridge
# 检索
$VENV knowledge/search.py --db knowledge/knowledge.db "微信 桥接" --limit 5
$VENV knowledge/search.py --db knowledge/knowledge.db '"微信桥接"' --limit 5
```

## 待接入的内容源

- ChatGPT 资料库（GitHub，321 项）：登录后克隆到本地只读目录再索引。
- Obsidian 知识库（GitHub 私有）：登录后克隆到本地只读目录再索引；遵守 vault 分支/PR 规则。

## 检索注意

- 纯中文查询走子串搜索：FTS5 unicode61 对两字中文词不可靠（“微信”只找到 6/28 篇，“桥接” 0/10 篇），trigram 又至少要 3 个字；所以 search.py 对纯中文词（单个或 OR 连接的多个）直接用 LIKE 子串匹配，实测“微信/桥接/外国投资者/微信桥接”全部等于真实数，473 篇约 25ms/次。英文、混合查询和显式 FTS 语法仍走 FTS5。
- 删除/改名清理：indexer.py 每次跑完会删掉源文件已不存在的行（FTS 触发器同步清理索引）；根目录不存在时不清理，防止误删整个源。
- 正文截断上限 1MB；图片只索引元数据（OCR 文本后续可加）。
