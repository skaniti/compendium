-- 039_embedding_gists.sql
-- Per-page LLM gists for the ctv3 clustering-text register (sc-followups
-- 2026-07-16). ctv2 embeds title + content_summary, which is the
-- capture-time first ~300 chars of extracted text (90% of clusterable
-- pages sit AT that cap — measured 2026-07-16); ctv3 replaces the head
-- sample with a 2-3 sentence topical gist (gpt-4o-mini, temp 0, seeded),
-- generated once per (page, prompt version) and cached here forever.
-- Keyed by prompt_key so a prompt revision regenerates without schema
-- surgery, mirroring clustering_embeddings.model_key.

CREATE TABLE IF NOT EXISTS embedding_gists (
    page_content_id INTEGER NOT NULL REFERENCES page_content(id) ON DELETE CASCADE,
    prompt_key      TEXT    NOT NULL,
    gist            TEXT    NOT NULL,
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (page_content_id, prompt_key)
);
