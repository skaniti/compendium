-- 017_app_logs.sql
--
-- Persistent log store for the Dash Live Log Stream view.
--
-- The in-process ring buffer in ``backend/api/log_buffer.py`` handles
-- the live tail (1s polling, last ~2000 records). This table is the
-- write-through history layer: every record the buffer captures is
-- also appended here by a background batched writer, so questions like
-- "what happened to capture X yesterday?" become answerable across
-- restarts.
--
-- Volume notes
-- ------------
-- At current pipeline scale (~50 records per capture, captures every
-- few minutes) we expect a few thousand inserts per day. The TTL prune
-- task in main.py deletes rows older than 14 days nightly so the table
-- stays bounded in the low-five-figures of rows.
--
-- Schema choices
-- --------------
-- - id BIGSERIAL: monotonic, matches the buffer cursor semantics
-- - ts TIMESTAMPTZ: precise wall-clock for time-range queries
-- - level/component/capture_id are the three filter facets
-- - extras JSONB: catches request_id, duration_ms, status_code from the
--   observability middleware without needing per-field columns
--
-- Indexes
-- -------
-- - ts DESC: covers the dominant "show last N minutes" query
-- - capture_id (partial): NULL is the common case, so filter NULLs out
-- - level (partial): only WARN/ERROR/CRITICAL — fast triage queries
--
-- See the matching repo at ``backend/db/log_repo.py``.

CREATE TABLE IF NOT EXISTS app_logs (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL,
    level       TEXT NOT NULL,
    logger      TEXT NOT NULL,
    component   TEXT,
    message     TEXT NOT NULL,
    capture_id  TEXT,
    exc_text    TEXT,
    extras      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS app_logs_ts_idx
    ON app_logs (ts DESC);

CREATE INDEX IF NOT EXISTS app_logs_capture_idx
    ON app_logs (capture_id)
    WHERE capture_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS app_logs_level_attention_idx
    ON app_logs (ts DESC)
    WHERE level IN ('WARNING', 'ERROR', 'CRITICAL');

COMMENT ON TABLE app_logs IS
    'Persistent log store for the Dash Live Log Stream. Write-through '
    'from backend.api.log_buffer.RingBufferHandler. TTL pruned nightly.';
