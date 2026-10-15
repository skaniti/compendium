-- 056_dq_adjudications.sql
-- dqBot hardening R4/U3 (2026-10): a durable ledger of every verdict the cheap
-- gpt-4o-mini rival-hypothesis adjudicator (backend/services/dq_adjudicator.py)
-- hands down. Until now only aggregate counts reached dq_runs.gate_metrics, so
-- nobody could audit whether its suppression rate was right (or inverted), and
-- the gate could not remember which candidates were already suppressed.
--
-- One row per judged candidate. context is 'full' (full-run adjudication) or
-- 'gate' (nightly sensor gate's confirm step). generation is the
-- recluster_runs id the candidates were detected against (nullable: the gate
-- may not know it). run_id is nullable and SET NULL on run deletion so the
-- ledger outlives pruned runs. verdict is the INTERNAL verdict: 'confirm' =
-- the detector's finding stands, 'suppress' = false positive. polarity_conflict
-- is TRUE when the model's two boolean fields (finding_is_real /
-- membership_matches_label) were not opposites; finding_is_real still decides.
--
-- The table is WRITTEN by the standalone dq-worker (explorer image:
-- backend/db/dq_adjudications_repo.py there) and READ by the gate on the
-- same worker; it lives in this repo's migrations because production
-- migrations run from apps/api (RUN_MIGRATIONS=1 in the server compose).
-- RLS mirrors dq_overrides (042). dq_bot_readonly gets SELECT now;
-- dq_sql_receipt.py's READONLY_ALLOWLIST is NOT extended here.

CREATE TABLE IF NOT EXISTS dq_adjudications (
    id                SERIAL PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_id            INTEGER REFERENCES dq_runs(id) ON DELETE SET NULL,
    generation        INTEGER,
    context           TEXT NOT NULL,
    scope_citation    TEXT,
    entity_type       TEXT NOT NULL,
    entity_id         TEXT NOT NULL,
    issue_type        TEXT,
    label             TEXT,
    verdict           TEXT NOT NULL,
    confidence        REAL,
    reason            TEXT,
    refined_action    TEXT,
    model             TEXT,
    batch_index       INTEGER,
    polarity_conflict BOOLEAN,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT dq_adjudication_verdict CHECK (verdict IN ('confirm', 'suppress')),
    CONSTRAINT dq_adjudication_context CHECK (context IN ('full', 'gate'))
);

CREATE INDEX IF NOT EXISTS dq_adjudications_user_created
    ON dq_adjudications (user_id, created_at);
CREATE INDEX IF NOT EXISTS dq_adjudications_user_entity
    ON dq_adjudications (user_id, entity_type, entity_id, issue_type);

ALTER TABLE dq_adjudications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dq_adjudications_user_isolation ON dq_adjudications;
CREATE POLICY dq_adjudications_user_isolation ON dq_adjudications
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);

GRANT SELECT ON dq_adjudications TO dq_bot_readonly;
