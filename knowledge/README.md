# knowledge/ — 共享知识库（M2）

SQLite FTS5 + 原始文件 + JSON 元数据。原始文件留在原地，库里只存抽取文本与索引。

## 文件

- `schema.sql` — 表结构（docs + docs_fts + 触发器 + 索引）
- `indexer.py` — 索引器（增量，mtime 变化才重索引）
- `search.py` — 检索器（FTS5 + snippet；裸多词自动 OR）
- `knowledge.db` — 索引数据库（2026-11-12 实测：60 篇，项目文档 + 研究笔记 + 桥接文件）

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

- FTS5 unicode61 对中文按字切分：单字、OR、加引号的短语都好用；裸多词已由 search.py 归一化为 OR。
- 正文截断上限 1MB；图片只索引元数据（OCR 文本后续可加）。
