-- 055_embedding_content_hash.sql
-- Adds an invalidation stamp to both embedding caches. The caches are keyed by
-- page_content_id (page_embeddings: + model_name; clustering_embeddings:
-- + model_key) and were never invalidated when a content row was re-fetched.
-- content_hash is the clustering_service.content_fingerprint() of the text the
-- vector was computed from; a cached row is reused only when it equals the
-- page's current fingerprint. It is NOT part of the key. NULL (every legacy
-- row) never matches, so legacy rows are re-embedded once.

ALTER TABLE page_embeddings ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE clustering_embeddings ADD COLUMN IF NOT EXISTS content_hash TEXT;
