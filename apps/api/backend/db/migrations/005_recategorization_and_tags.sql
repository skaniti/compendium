-- 005_recategorization_and_tags.sql
-- Human override columns, annotations audit trail, and tagging system.
--
-- Design: LLM decisions stay in status/processing_depth. Human overrides
-- go into separate human_* columns so both labels are preserved for
-- fine-tuning and prompt improvement. COALESCE(human_*, original) gives
-- the "effective" value used by downstream queries.

-- ========================================================================
-- 1. Human override columns on pages
-- ========================================================================

ALTER TABLE pages ADD COLUMN IF NOT EXISTS human_status TEXT;
ALTER TABLE pages ADD CONSTRAINT pages_human_status_check CHECK (
    human_status IS NULL OR human_status IN ('active', 'archived')
);

ALTER TABLE pages ADD COLUMN IF NOT EXISTS human_processing_depth TEXT;
ALTER TABLE pages ADD CONSTRAINT pages_human_depth_check CHECK (
    human_processing_depth IS NULL
    OR human_processing_depth IN ('processed', 'skipped')
);

ALTER TABLE pages ADD COLUMN IF NOT EXISTS flagged_for_review BOOLEAN DEFAULT FALSE;

-- Partial index for finding pages with human overrides (disagreement queries)
CREATE INDEX idx_pages_human_override ON pages(id)
    WHERE human_status IS NOT NULL OR human_processing_depth IS NOT NULL;

-- Partial index for the review queue
CREATE INDEX idx_pages_flagged ON pages(id)
    WHERE flagged_for_review = TRUE;

-- Performance index for the critical get_active_pages() query after COALESCE
CREATE INDEX idx_pages_effective_active ON pages(capture_id)
    WHERE COALESCE(human_status, status) = 'active';

-- ========================================================================
-- 2. Human override on captures
-- ========================================================================

ALTER TABLE captures ADD COLUMN IF NOT EXISTS human_is_trivial BOOLEAN;

-- ========================================================================
-- 3. Annotations (audit trail for all human overrides and notes)
-- ========================================================================

CREATE TABLE annotations (
    id              BIGSERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL,
    entity_id       BIGINT NOT NULL,
    action          TEXT NOT NULL,
    old_value       TEXT,
    new_value       TEXT,
    note            TEXT,
    model_version   TEXT,
    prompt_version  TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT annotations_entity_type_check CHECK (
        entity_type IN ('page', 'capture')
    ),
    CONSTRAINT annotations_action_check CHECK (
        action IN (
            'override_status',
            'override_depth',
            'override_trivial',
            'clear_override',
            'note',
            'flag_for_review'
        )
    )
);
CREATE INDEX idx_annotations_entity ON annotations(entity_type, entity_id);
CREATE INDEX idx_annotations_user ON annotations(user_id);
CREATE INDEX idx_annotations_action ON annotations(action);

ALTER TABLE annotations ENABLE ROW LEVEL SECURITY;
CREATE POLICY annotations_isolation ON annotations
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);

-- ========================================================================
-- 4. Tags
-- ========================================================================

CREATE TABLE tags (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT DEFAULT '#808080',
    group_name  TEXT,
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, name)
);
CREATE INDEX idx_tags_user ON tags(user_id);
CREATE INDEX idx_tags_group ON tags(user_id, group_name);

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tags_isolation ON tags
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);

-- ========================================================================
-- 5. Entity tags (polymorphic join: tags <-> pages/captures)
-- ========================================================================

CREATE TABLE entity_tags (
    tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id   BIGINT NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tag_id, entity_type, entity_id),
    CONSTRAINT entity_tags_type_check CHECK (
        entity_type IN ('page', 'capture')
    )
);
CREATE INDEX idx_entity_tags_entity ON entity_tags(entity_type, entity_id);
CREATE INDEX idx_entity_tags_user ON entity_tags(user_id);

ALTER TABLE entity_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY entity_tags_isolation ON entity_tags
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);
