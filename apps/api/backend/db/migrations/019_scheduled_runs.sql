-- 019_scheduled_runs.sql
--
-- Job-state table for the nightly scheduler.
--
-- The scheduler in ``backend/services/scheduler.py`` wakes once per day
-- at a configured local hour and runs registered maintenance jobs.
-- Each run inserts one row here so the history of scheduled work is
-- observable the same way ``recluster_runs`` is today — for debugging,
-- cost accounting, and the Trends dashboard.
--
-- Design context
-- --------------------
-- The project splits into two paths: interactive (skip gate, RAG agent,
-- supercluster create/delete) and deferred (cluster naming, supercluster
-- maintenance, learning-gate batch). Deferred jobs run here and can use
-- the OpenAI Batch API for a 50% cost discount since the user is not
-- waiting on the output.
--
-- Schema choices
-- --------------
-- - job_name TEXT: short stable id like ``nightly_maintenance``,
--   ``rag_backfill``. Multiple jobs per day supported.
-- - scope_user_id: NULL = system-wide job; non-NULL = per-user job.
-- - cost_usd REAL: mirrors recluster_runs.naming_cost so the Trends
--   view can SUM cost across scheduled work.
-- - notes JSONB: freeform details (pages processed, batch_id, errors).

CREATE TABLE IF NOT EXISTS scheduled_runs (
    id              BIGSERIAL PRIMARY KEY,
    job_name        TEXT NOT NULL,
    scope_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'running',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    cost_usd        REAL NOT NULL DEFAULT 0,
    elapsed_seconds REAL,
    notes           JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT scheduled_runs_status_check
        CHECK (status IN ('running','completed','failed','skipped'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_runs_started
    ON scheduled_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_scheduled_runs_job
    ON scheduled_runs (job_name, started_at DESC);
