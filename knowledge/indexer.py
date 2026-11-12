#!/usr/bin/env python3
"""Indexer for the shared knowledge store (M2).

Walks source directories, extracts plain text per format (using the
project venv libs + pandoc/LibreOffice where needed), and upserts into
knowledge.db (SQLite FTS5). Originals are never copied or modified.

Usage:
  ~/workspace/muse-wechat-unified/.venv/bin/python knowledge/indexer.py \
      --db knowledge/knowledge.db \
      --source project-docs --root docs \
      --source research --root research

Re-run is incremental: a file is re-indexed only when its mtime changed.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys

MAX_TEXT_CHARS = 1_000_000
TEXT_EXTS = {".md", ".markdown", ".txt", ".csv", ".json", ".py", ".js", ".ts", ".html", ".htm", ".tex", ".typ", ".yaml", ".yml", ".toml", ".sh"}

SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")


def extract_text(path, ext):
    """Return extracted plain text for one file, or None if unsupported."""
    try:
        if ext in TEXT_EXTS:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        if ext == ".pdf":
            import fitz
            doc = fitz.open(path)
            return "\n".join(page.get_text() for page in doc)
        if ext == ".docx":
            import docx
            d = docx.Document(path)
            return "\n".join(p.text for p in d.paragraphs)
        if ext == ".xlsx":
            import openpyxl
            wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
            lines = []
            for ws in wb.worksheets:
                for row in ws.iter_rows(values_only=True):
                    lines.append("\t".join("" if c is None else str(c) for c in row))
            return "\n".join(lines)
        if ext == ".pptx":
            import pptx
            prs = pptx.Presentation(path)
            lines = []
            for slide in prs.slides:
                for shape in slide.shapes:
                    if shape.has_text_frame:
                        lines.append(shape.text)
            return "\n".join(lines)
        if ext == ".epub":
            out = subprocess.run(
                ["pandoc", path, "-t", "plain"], capture_output=True, text=True, timeout=60
            )
            return out.stdout if out.returncode == 0 else None
    except Exception as e:
        print(f"  ! extract failed {path}: {e}", file=sys.stderr)
        return None
    return None


def file_id(source, rel):
    return hashlib.sha256(f"{source}|{rel}".encode()).hexdigest()


def index_source(db, source, root):
    root = os.path.abspath(root)
    indexed = skipped = failed = 0
    for dirpath, _dirs, files in os.walk(root):
        for name in sorted(files):
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root)
            ext = os.path.splitext(name)[1].lower()
            if ext not in TEXT_EXTS and ext not in {".pdf", ".docx", ".xlsx", ".pptx", ".epub"}:
                skipped += 1
                continue
            mtime = os.path.getmtime(path)
            size = os.path.getsize(path)
            fid = file_id(source, rel)
            row = db.execute("SELECT mtime FROM docs WHERE id = ?", (fid,)).fetchone()
            if row and row[0] == mtime:
                skipped += 1
                continue
            text = extract_text(path, ext)
            if text is None:
                failed += 1
                continue
            title = name
            if ext in {".md", ".txt"} and text.startswith("# "):
                title = text.split("\n", 1)[0][2:].strip() or name
            meta = json.dumps({"size": size, "format": ext.lstrip("."), "rel": rel}, ensure_ascii=False)
            db.execute(
                "INSERT OR REPLACE INTO docs (id, source, path, title, mtime, text, meta) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (fid, source, path, title, mtime, text[:MAX_TEXT_CHARS], meta),
            )
            indexed += 1
    db.commit()
    print(f"[{source}] indexed={indexed} skipped={skipped} failed={failed} root={root}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--source", action="append", required=True)
    ap.add_argument("--root", action="append", required=True)
    args = ap.parse_args()
    if len(args.source) != len(args.root):
        ap.error("--source and --root must appear in pairs")
    db_path = os.path.abspath(args.db)
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    db = sqlite3.connect(db_path)
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        db.executescript(f.read())
    for source, root in zip(args.source, args.root):
        index_source(db, source, root)
    total = db.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
    print(f"total docs in db: {total}")
    db.close()


if __name__ == "__main__":
    main()
