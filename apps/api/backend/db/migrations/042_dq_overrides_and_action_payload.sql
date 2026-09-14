-- 042_dq_overrides_and_action_payload.sql
-- dqBot Tier 1 (Worker K / Phase 1): machine-actionable recommendation
-- payloads + the durable dq_overrides constraint table.
--
-- Two changes that ship together because dq_overrides.source_rec_id FKs into
-- dq_recommendations, and both are foundational for the same feature (spec
-- S4/S5/S6):
--
--   1. dq_recommendations gains action_payload (per action_type structured
--      instructions -- relabel_cluster/split_cluster/merge_clusters/dedupe
--      shapes, see spec S4) plus applied_at/applied_detail (what the approve
--      path actually did, or why it degraded to record-only, see spec S5).
--      All three nullable: pre-042 rows and record-only action_types never
--      populate them.
--
--   2. dq_overrides -- durable constraints the clustering pipeline consumes
--      on every recluster (spec S6): pin_label, exclude_from_cluster,
--      never_cocluster, merge_clusters. `subject` identifies what the
--      override applies to (e.g. {"stable_id": "..."} or
--      {"stable_ids": [...]}  for merge_clusters); `payload` carries the
--      action-specific detail (e.g. {"label": "..."} for pin_label,
--      {"page_content_ids": [...]} for exclude_from_cluster). Deliberately
--      loose JSONB, same posture as dq_recommendations.affected_entity_ids --
--      the override-application pass (Phase 2/3, not this migration) is the
--      code that interprets these shapes.
--
-- RLS mirrors dq_recommendations' user-isolation idiom from
-- 019_dq_helper_tables.sql (single USING policy, applies to all commands).
--
-- dq_bot_readonly gets SELECT on dq_overrides now so the grant story stays
-- coherent with 028/040's allowlist pattern, but backend/services/
-- dq_sql_receipt.py's READONLY_ALLOWLIST is NOT extended here -- that's a
-- later phase's job (the SQL-receipt investigators don't reference
-- dq_overrides yet). Granting ahead of the allowlist is harmless: an
-- unreferenced grant, not a security hole -- the allowlist is what the
-- validator + prompts actually gate on.
--
-- Design: the 2026-07-17 dqbot-tier1-overrides plan (private), spec.md

-- == 1. dq_recommendations: action_payload + applied bookkeeping =======
ALTER TABLE dq_recommendations
    ADD COLUMN IF NOT EXISTS action_payload  JSONB,
    ADD COLUMN IF NOT EXISTS applied_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS applied_detail  JSONB;

-- == 2. dq_overrides =====================================================
CREATE TABLE IF NOT EXISTS dq_overrides (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    override_type      TEXT NOT NULL,
    subject            JSONB NOT NULL,
    payload            JSONB,
    status             TEXT NOT NULL DEFAULT 'active',
    source_rec_id      INTEGER REFERENCES dq_recommendations(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_applied_run   INTEGER,
    last_applied_at    TIMESTAMPTZ,
    apply_count        INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT dq_override_type CHECK (
        override_type IN ('pin_label', 'exclude_from_cluster', 'never_cocluster', 'merge_clusters')
    ),
    CONSTRAINT dq_override_status CHECK (status IN ('active', 'retired'))
);

CREATE INDEX IF NOT EXISTS dq_overrides_user_status ON dq_overrides (user_id, status);

-- == 3. RLS (matches dq_recommendations' pattern from 019) ==============
ALTER TABLE dq_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dq_overrides_user_isolation ON dq_overrides;
CREATE POLICY dq_overrides_user_isolation ON dq_overrides
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);

-- == 4. Read-only grant (allowlist extension deferred -- see header) ====
GRANT SELECT ON dq_overrides TO dq_bot_readonly;
