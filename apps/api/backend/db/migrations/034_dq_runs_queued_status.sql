-- DQ worker runtime: dq_runs becomes a job queue.
--
-- 1. Add 'queued' to dq_runs.status CHECK — the pre-'running' state a row sits
--    in between enqueue (any trigger path) and the worker claiming it.
-- 2. Add abort_requested — set by the /abort endpoint; the worker checks it
--    mid-stream and kills its own claude subprocess (cross-process abort, since
--    the subprocess no longer lives in the API process).

ALTER TABLE dq_runs DROP CONSTRAINT IF EXISTS dq_run_status;
ALTER TABLE dq_runs ADD CONSTRAINT dq_run_status CHECK (
    status IN ('queued', 'running', 'completed', 'failed')
);

ALTER TABLE dq_runs ADD COLUMN IF NOT EXISTS abort_requested BOOLEAN NOT NULL DEFAULT FALSE;
