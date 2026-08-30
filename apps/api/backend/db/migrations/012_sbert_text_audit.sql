-- Migration 012: Add SBERT text audit columns to page_content
--
-- These columns record exactly what text was fed to the SBERT model for each
-- page's embedding, and which code path produced it. Populated lazily by
-- _compute_embeddings on the next clustering run.
--
-- sbert_text:        The exact string fed to SentenceTransformer.encode()
-- sbert_text_source: Which branch of _build_sbert_text / get_primary_text_from_dict
--                    produced the text (e.g. "RedditContent", "page_summary_fallback",
--                    "url_path_fallback")

ALTER TABLE page_content ADD COLUMN IF NOT EXISTS sbert_text TEXT;
ALTER TABLE page_content ADD COLUMN IF NOT EXISTS sbert_text_source TEXT;
