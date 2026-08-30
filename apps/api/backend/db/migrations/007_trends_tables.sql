-- 007_trends_tables.sql
-- Trends tracking: LLM cost events and periodic status snapshots.
-- Supports the Trends dev-suite view for time-series analysis.

CREATE TABLE IF NOT EXISTS cost_events (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,           -- 'skip_gate', 'cluster_naming', 'summarization'
    model           TEXT NOT NULL,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    latency_ms      REAL,
    metadata        JSONB DEFAULT '{}',      -- optional context (capture_id, page_url, etc.)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cost_events_user     ON cost_events(user_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_type     ON cost_events(event_type);
CREATE INDEX IF NOT EXISTS idx_cost_events_created  ON cost_events(created_at);

CREATE TABLE IF NOT EXISTS status_snapshots (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    active_count    INTEGER NOT NULL DEFAULT 0,
    pending_count   INTEGER NOT NULL DEFAULT 0,
    archived_count  INTEGER NOT NULL DEFAULT 0,
    cluster_count   INTEGER NOT NULL DEFAULT 0,
    noise_count     INTEGER NOT NULL DEFAULT 0,
    total_cost_usd  REAL NOT NULL DEFAULT 0,
    snapshot_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_status_snapshots_user ON status_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_status_snapshots_at   ON status_snapshots(snapshot_at);
