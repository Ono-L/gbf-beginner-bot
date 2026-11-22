-- グラブル初心者ナレッジのチャンク本文を保存するテーブル
-- ベクトル本体は Cloudflare Vectorize (768次元・cosine) に保存し、
-- 検索で得た chunk_id を使ってこの D1 テーブルから本文を取得します。

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  heading TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source_file
  ON knowledge_chunks (source_file);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_heading
  ON knowledge_chunks (heading);
