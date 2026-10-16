-- 059_shelves.sql
-- Label-first grouping: a "shelf" is a stable, canonical subtopic. Page labels
-- (migration 058) carry a free-text subtopic; the shelf service canonicalises
-- those strings into shelves so the same topic keeps one identity (stable_id)
-- from run to run. centroid is an untyped vector: its dimension follows the
-- embedder (embedder_key records which one).

CREATE TABLE IF NOT EXISTS shelves (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    stable_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    centroid vector,
    embedder_key TEXT,
    n_pages INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    merged_into BIGINT REFERENCES shelves(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shelves_user_status ON shelves (user_id, status);

CREATE TABLE IF NOT EXISTS shelf_pages (
    shelf_id BIGINT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
    page_content_id INTEGER NOT NULL REFERENCES page_content(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    subtopic TEXT NOT NULL,
    method TEXT NOT NULL,
    similarity REAL,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (page_content_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shelf_pages_shelf ON shelf_pages (shelf_id);

CREATE TABLE IF NOT EXISTS shelf_strings (
    user_id INTEGER NOT NULL,
    subtopic_norm TEXT NOT NULL,
    shelf_id BIGINT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, subtopic_norm)
);
CREATE INDEX IF NOT EXISTS idx_shelf_strings_shelf ON shelf_strings (shelf_id);
