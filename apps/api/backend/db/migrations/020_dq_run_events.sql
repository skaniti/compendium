-- 020_dq_run_events.sql
-- Per-event log for each dqBot run. Populated as claude -p streams events
-- (system:init, assistant turns, tool_results, final result). Consumed by
-- the dqBot event-log UI via GET /api/dq/runs/:id/events?since=<seq>.

CREATE TABLE dq_run_events (
    id              BIGSERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_id          INTEGER NOT NULL REFERENCES dq_runs(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    event_type      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, seq)
);

CREATE INDEX dq_run_events_user_run ON dq_run_events (user_id, run_id, seq);

ALTER TABLE dq_run_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY dq_run_events_user_isolation ON dq_run_events
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);
