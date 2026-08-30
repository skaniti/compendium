-- Clustering embedding cache, model- and text-contract-versioned.
--
-- page_embeddings (migration 002) is hard-typed vector(384) with an IVFFlat
-- index serving find_similar — it cannot hold candidate embeddings of other
-- dimensions (text-embedding-3-small = 1536). This table is the cache for the
-- clustering pipeline's gated embedding upgrade (clustering-rethink increment
-- 1; see docs/project-plans/2026-07-08-180037-clustering-supercluster-rethink/).
--
-- model_key encodes BOTH the embedding model and the text-contract version
-- that produced the input text (e.g. 'text-embedding-3-small@ctv2'), so a
-- recipe change invalidates the cache without a schema change (findings F4).
--
-- embedding is deliberately UNTYPED vector: dimension-flexible across models.
-- No ANN index — clustering reads all rows for a user's corpus (seq scan);
-- nothing does nearest-neighbor lookups against this table.

CREATE TABLE IF NOT EXISTS clustering_embeddings (
    page_content_id INTEGER NOT NULL REFERENCES page_content(id) ON DELETE CASCADE,
    model_key       TEXT NOT NULL,
    dim             INTEGER NOT NULL,
    embedding       vector NOT NULL,
    computed_at     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (page_content_id, model_key)
);
