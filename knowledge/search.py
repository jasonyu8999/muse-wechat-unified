#!/usr/bin/env python3
"""Search the shared knowledge store (M2).

Usage:
  ~/workspace/muse-wechat-unified/.venv/bin/python knowledge/search.py \
      --db knowledge/knowledge.db "微信 桥接" --limit 5

FTS5 query syntax: plain words are ANDed; use OR / "phrase" for more
control. Returns title, source, path, snippet.
"""
import argparse
import json
import sqlite3


def search(db_path, query, limit=5, source=None):
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    sql = (
        "SELECT d.title, d.source, d.path, d.meta, "
        "snippet(docs_fts, 1, '[', ']', '...', 32) AS snip "
        "FROM docs_fts f JOIN docs d ON d.rowid = f.rowid "
        "WHERE docs_fts MATCH ? "
    )
    params = [query]
    if source:
        sql += "AND d.source = ? "
        params.append(source)
    sql += "ORDER BY rank LIMIT ?"
    params.append(limit)
    rows = db.execute(sql, params).fetchall()
    db.close()
    return [dict(r) for r in rows]


def normalize_query(query):
    """Plain multi-word queries become OR queries.

    FTS5 treats a bare token sequence as a phrase query, which fails
    for Chinese multi-word input (e.g. "微信 桥接" never matches, because
    the two words rarely sit adjacent). A search box should OR plain
    terms; explicit FTS5 syntax (OR/AND/quotes/parentheses) is left alone.
    """
    q = query.strip()
    if not q:
        return q
    if any(op in q for op in (" OR ", " AND ", '"', "(", ")", "*", "^")):
        return q
    parts = q.split()
    if len(parts) <= 1:
        return q
    return " OR ".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("query")
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--source", default=None)
    args = ap.parse_args()
    results = search(args.db, normalize_query(args.query), args.limit, args.source)
    if not results:
        print("no matches")
        return
    for r in results:
        meta = json.loads(r["meta"])
        print("- " + r["title"] + " [" + r["source"] + "] (" + meta.get("format", "") + ")")
        print("  " + r["path"])
        print("  " + r["snip"])


if __name__ == "__main__":
    main()
