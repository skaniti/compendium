-- 002_pgvector.sql
-- Add pgvector extension and page_embeddings table for similarity search.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE page_embeddings (
    page_content_id INTEGER NOT NULL REFERENCES page_content(id) ON DELETE CASCADE,
    model_name      TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
    embedding       vector(384) NOT NULL,
    computed_at     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (page_content_id, model_name)
);

-- IVFFlat index for fast cosine similarity search.
-- lists=100 is appropriate for up to ~50k vectors; adjust if data grows.
CREATE INDEX idx_page_embeddings_ivfflat ON page_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
