-- 019_dq_helper_tables.sql
-- Adds the three tables that back dqBot: observations (working memory + dedup
-- ledger), recommendations (pending/approved/rejected inbox items), and runs
-- (per-execution telemetry). All three tables carry row-level security so
-- they behave correctly if the project is ever open-sourced as multi-tenant.
-- See docs/project-plans/_completed/2026-04-20-dq-helper/design.md for design intent.

-- ── dq_runs ──────────────────────────────────────────────────────────
CREATE TABLE dq_runs (
    id                      SERIAL PRIMARY KEY,
    user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trigger                 TEXT NOT NULL,
    started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at            TIMESTAMPTZ,
    observations_written    INTEGER NOT NULL DEFAULT 0,
    recommendations_written INTEGER NOT NULL DEFAULT 0,
    llm_cost_usd            REAL,
    status                  TEXT NOT NULL DEFAULT 'running',
    CONSTRAINT dq_run_trigger CHECK (trigger IN ('manual','schedule','recluster_event')),
    CONSTRAINT dq_run_status  CHECK (status IN ('running','completed','failed'))
);

-- ── dq_observations ──────────────────────────────────────────────────
-- Adjacent-handoff observations carry handoff_prompt_draft / handoff_status /
-- adjacency_contract_ref; core observations leave those NULL.
CREATE TABLE dq_observations (
    id                      BIGSERIAL PRIMARY KEY,
    user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_id                  INTEGER NOT NULL REFERENCES dq_runs(id) ON DELETE CASCADE,
    entity_type             TEXT NOT NULL,
    entity_id               TEXT NOT NULL,
    tag                     TEXT NOT NULL,
    issue_type              TEXT NOT NULL,
    observation             TEXT NOT NULL,
    severity                TEXT NOT NULL DEFAULT 'info',
    scope_citation          TEXT,
    adjacency_contract_ref  TEXT,
    handoff_prompt_draft    TEXT,
    handoff_status          TEXT,
    observed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT dq_obs_entity_type    CHECK (entity_type IN ('cluster','page','domain','capture','supercluster','global')),
    CONSTRAINT dq_obs_tag            CHECK (tag IN ('core','adjacent','off_topic')),
    CONSTRAINT dq_obs_severity       CHECK (severity IN ('info','warning','critical')),
    CONSTRAINT dq_obs_handoff_status CHECK (handoff_status IS NULL OR handoff_status IN ('draft','sent','dismissed'))
);

-- The dedup ledger: agent checks existence before re-investigating.
CREATE UNIQUE INDEX dq_obs_dedup
    ON dq_observations (user_id, entity_type, entity_id, issue_type);

-- ── dq_recommendations ───────────────────────────────────────────────
CREATE TABLE dq_recommendations (
    id                      BIGSERIAL PRIMARY KEY,
    user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    observation_id          BIGINT REFERENCES dq_observations(id) ON DELETE SET NULL,
    run_id                  INTEGER REFERENCES dq_runs(id) ON DELETE SET NULL,
    action_type             TEXT NOT NULL,
    headline                TEXT NOT NULL,
    rationale               TEXT NOT NULL,
    self_classification     TEXT NOT NULL,
    rank_in_run             INTEGER NOT NULL,
    affected_entity_type    TEXT NOT NULL,
    affected_entity_ids     JSONB NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'pending',
    user_note               TEXT,
    reviewed_at             TIMESTAMPTZ,
    superseded_by           BIGINT REFERENCES dq_recommendations(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT dq_rec_self_class CHECK (self_classification IN ('trivial','judgment','risky')),
    CONSTRAINT dq_rec_status     CHECK (status IN ('pending','approved','rejected','snoozed','superseded','dismissed'))
);

CREATE INDEX dq_rec_user_status ON dq_recommendations (user_id, status);
CREATE INDEX dq_rec_user_run    ON dq_recommendations (user_id, run_id);

-- ── RLS (matches pattern from 003_row_level_security.sql) ────────────
ALTER TABLE dq_runs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE dq_observations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE dq_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY dq_runs_user_isolation ON dq_runs
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);
CREATE POLICY dq_obs_user_isolation ON dq_observations
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);
CREATE POLICY dq_rec_user_isolation ON dq_recommendations
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);
