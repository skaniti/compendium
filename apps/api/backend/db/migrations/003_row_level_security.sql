-- 003_row_level_security.sql
-- Enable row-level security on user-scoped tables.
-- Application must SET app.current_user_id on each connection.

-- Denormalize user_id onto pages for efficient RLS (avoids join through captures)
ALTER TABLE pages ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_pages_user ON pages(user_id);

-- Backfill user_id from captures
UPDATE pages SET user_id = c.user_id
FROM captures c
WHERE pages.capture_id = c.id AND pages.user_id IS NULL;

-- Captures
ALTER TABLE captures ENABLE ROW LEVEL SECURITY;
CREATE POLICY captures_isolation ON captures
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);

-- Pages
ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY pages_isolation ON pages
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);

-- Clusters
ALTER TABLE clusters ENABLE ROW LEVEL SECURITY;
CREATE POLICY clusters_isolation ON clusters
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);

-- Recluster runs
ALTER TABLE recluster_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY recluster_runs_isolation ON recluster_runs
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);

-- Graph cache
ALTER TABLE graph_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY graph_cache_isolation ON graph_cache
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);
