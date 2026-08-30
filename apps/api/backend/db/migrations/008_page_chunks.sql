-- 008_page_chunks.sql
-- Extract RAG retrieval chunks into their own table + dedicated embedding
-- storage, disentangling the two concerns that currently share page_content.
--
-- Background: prior to this migration, the RAG indexer (backend/db/vector_store.py)
-- stored chunks by synthesizing URLs of the form ``{base_url}#chunk-{hash}`` so
-- each chunk could reuse the ``page_content.url`` UNIQUE constraint. 1,482 of
-- 3,282 page_content rows (45%, as of 2026-04-04) were actually RAG chunks,
-- not user-visited pages. This blocked the normalized_url migration (Plan 04)
-- because fragment-stripping would collapse all chunks into their parent URL
-- and orphan 17 of every 18 embeddings.
--
-- After this migration, page_content is strictly one row per canonical source
-- URL. Chunks live in page_chunks with a proper FK, and chunk embeddings live
-- in chunk_embeddings (a separate table from page_embeddings, one concern per
-- table — Option B from Plan 02's schema design doc).
--
-- The data migration (old #chunk- rows → new page_chunks rows + FK-retarget of
-- their embeddings) lives in scripts/migrations/008_migrate_chunks_to_page_chunks.py
-- and must be run AFTER this .sql migration but BEFORE any new RAG indexing
-- happens under the updated vector_store.add_documents code path.


-- Chunks are passages extracted from a source page by the RAG chunker.
-- One page_content row can have many page_chunks rows.
CREATE TABLE page_chunks (
    id                  BIGSERIAL PRIMARY KEY,
    page_content_id     INTEGER NOT NULL REFERENCES page_content(id) ON DELETE CASCADE,
    chunk_index         INTEGER NOT NULL,
    chunk_text          TEXT NOT NULL,
    section_title       TEXT,
    token_count         INTEGER,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (page_content_id, chunk_index)
);

CREATE INDEX idx_page_chunks_content ON page_chunks(page_content_id);


-- Chunk-level embeddings. Kept separate from page_embeddings (which is for
-- cluster-level, one-embedding-per-page signal) so the two consumers never
-- collide. Same vector dimensionality as page_embeddings (384 for SBERT
-- all-MiniLM-L6-v2) so we can A/B or future-proof a model swap.
CREATE TABLE chunk_embeddings (
    page_chunk_id   BIGINT NOT NULL REFERENCES page_chunks(id) ON DELETE CASCADE,
    model_name      TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
    embedding       vector(384) NOT NULL,
    computed_at     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (page_chunk_id, model_name)
);

-- IVFFlat cosine index — matches the page_embeddings convention.
-- lists=100 is appropriate for up to ~50k vectors.
CREATE INDEX idx_chunk_embeddings_ivfflat ON chunk_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
