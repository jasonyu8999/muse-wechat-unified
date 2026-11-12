-- knowledge.db schema — shared knowledge store (M2)
-- SQLite FTS5 + original files + JSON metadata.
-- Originals stay on disk (never duplicated into the DB); the DB holds
-- extracted text + metadata + FTS5 index only.

CREATE TABLE IF NOT EXISTS docs (
  id     TEXT PRIMARY KEY,   -- sha256(source + '|' + relative_path)
  source TEXT NOT NULL,     -- e.g. 'project-docs', 'chatgpt-library', 'obsidian-vault'
  path   TEXT NOT NULL,     -- absolute path of the original file
  title  TEXT,              -- file name or first heading
  mtime  REAL NOT NULL,     -- source file mtime (re-index when it changes)
  text   TEXT NOT NULL,     -- extracted plain text (may be truncated at 1MB)
  meta   TEXT NOT NULL DEFAULT '{}'  -- JSON: size, format, tags, origin, confidence
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, text,
  content='docs', content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
  INSERT INTO docs_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;

CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source);
CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(path);
