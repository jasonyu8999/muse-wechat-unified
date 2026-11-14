#!/usr/bin/env python3
"""Search the shared knowledge store (M2).

Usage:
  ~/workspace/muse-wechat-unified/.venv/bin/python knowledge/search.py \
      --db knowledge/knowledge.db "微信 桥接" --limit 5

FTS5 query syntax: plain words are ANDed; use OR / "phrase" for more
control. Returns title, source, path, snippet.

Chinese queries: FTS5 unicode61 cannot match 2-character Chinese words
reliably ('微信' finds 6 of 28 docs, '桥接' 0 of 10), and trigram needs
3+ characters, so a query made only of CJK terms is searched as a
substring (LIKE) instead — exact ground truth at this scale (473 docs,
~25ms/query). Everything else still uses FTS5.
"""
import argparse
import json
import re
import sqlite3

CJK_RE = re.compile(r"^[\u4e00-\u9fff]+$")


def _cjk_terms(query):
    """Split a normalized query into terms; return them if every term is
    pure CJK (no FTS operators, no Latin/digits), else None.

    normalize_query() already turns a plain multi-word query into
    "term OR term", so "微信 桥接" arrives here as ["微信", "桥接"].
    """
    q = query.strip()
    if not q:
        return None
    terms = [t.strip() for t in q.split(" OR ")]
    if not terms or any(not CJK_RE.match(t) for t in terms):
        return None
    return terms


def _snippet(text, terms, window=40):
    """~window chars around the first occurrence of any term, with the
    term wrapped in [ ], in the style of the FTS snippet()."""
    best = None
    for t in terms:
        i = text.find(t)
        if i != -1 and (best is None or i < best[0]):
            best = (i, t)
    if best is None:
        return ""
    i, t = best
    start = max(0, i - window)
    end = min(len(text), i + len(t) + window)
    frag = text[start:end].replace("\n", " ")
    rel = i - start
    frag = frag[:rel] + "[" + t + "]" + frag[rel + len(t):]
    return ("..." if start > 0 else "") + frag + ("..." if end < len(text) else "")


def _like_search(db, terms, limit, source=None):
    """Substring search for pure-CJK queries. Title hits rank first."""
    conds, params = [], []
    for t in terms:
        like = "%" + t + "%"
        conds.append("(d.title LIKE ? OR d.text LIKE ?)")
        params.extend([like, like])
    sql = (
        "SELECT d.title, d.source, d.path, d.meta, d.text "
        "FROM docs d WHERE (" + " OR ".join(conds) + ") "
    )
    if source:
        sql += "AND d.source = ? "
        params.append(source)
    title_conds = " OR ".join(["d.title LIKE ?"] * len(terms))
    sql += "ORDER BY CASE WHEN (" + title_conds + ") THEN 0 ELSE 1 END, d.rowid LIMIT ?"
    params.extend(["%" + t + "%" for t in terms])
    params.append(limit)
    rows = db.execute(sql, params).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["snip"] = _snippet(d["text"], terms) or d["title"]
        del d["text"]
        out.append(d)
    return out


def search(db_path, query, limit=5, source=None):
    query = normalize_query(query)
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    try:
        terms = _cjk_terms(query)
        if terms:
            return _like_search(db, terms, limit, source)
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
        return [dict(r) for r in rows]
    finally:
        db.close()


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
    results = search(args.db, args.query, args.limit, args.source)
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
