-- 058_page_labels.sql
-- Label-first grouping, part L: one structured label per page_content row and
-- labeller version (model@prompt). Labels are content-level, like
-- page_content.content_kind, which the labeller also fills. user_id is the
-- owner of the page that triggered the label (denormalised like pages.user_id).
-- source: 'model' | 'owner' (owner corrections are gold) | 'import'.

CREATE TABLE IF NOT EXISTS page_labels (
    id                BIGSERIAL PRIMARY KEY,
    page_content_id   INTEGER NOT NULL REFERENCES page_content(id) ON DELETE CASCADE,
    user_id           INTEGER,
    labeller_version  TEXT NOT NULL,
    category          TEXT NOT NULL,
    subtopic          TEXT NOT NULL,
    entity            TEXT,
    specificity       TEXT,
    content_kind      TEXT,
    knowledge_value   TEXT NOT NULL,
    evidence_level    TEXT,
    language          TEXT,
    flags             JSONB NOT NULL DEFAULT '[]'::jsonb,
    private_sensitive BOOLEAN,
    confidence        REAL,
    source            TEXT NOT NULL DEFAULT 'model',
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (page_content_id, labeller_version)
);

CREATE INDEX IF NOT EXISTS idx_page_labels_user_version
    ON page_labels (user_id, labeller_version);
