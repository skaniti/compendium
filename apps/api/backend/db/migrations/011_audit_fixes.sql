-- 011_audit_fixes.sql
-- Post-audit hygiene fixes from the 2026-04-05 schema audit.
--
-- 1. Add 'dedup' to pages.archive_reason CHECK — enables archive-over-delete
--    semantics for the dedup pipeline (cleanup scripts mark losers as
--    archived instead of hard-deleting them).
--
-- 2. Add 'archived' to recluster_runs.status CHECK — enables archiving old
--    runs instead of cascade-deleting them (which previously destroyed
--    historical cluster results).
--
-- 3. Add compound index (capture_id, visited_at) on pages — optimizes the
--    hot query path for "get all pages for capture X ordered by time."

-- 1. Expand archive_reason to include 'dedup'
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_archive_reason_check;
ALTER TABLE pages ADD CONSTRAINT pages_archive_reason_check CHECK (
    archive_reason IS NULL
    OR archive_reason IN ('skip_gate', 'manual_exclusion', 'trivial_capture', 'domain_skip', 'dedup')
);

-- 2. Expand recluster_runs status to include 'archived'
ALTER TABLE recluster_runs DROP CONSTRAINT IF EXISTS recluster_status_check;
ALTER TABLE recluster_runs ADD CONSTRAINT recluster_status_check CHECK (
    status IN ('running', 'completed', 'failed', 'archived')
);

-- 3. Compound index for time-ordered page queries within a capture
CREATE INDEX IF NOT EXISTS idx_pages_capture_visited
    ON pages(capture_id, visited_at);
