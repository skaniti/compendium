-- 040_dq_readonly_grants_and_run_forensics.sql
-- Re-apply migration 028's dq_bot_readonly grants + add failure_reason to dq_runs.
--
-- Why re-apply grants that "already ran": migration 028 created the role and
-- GRANTed it SELECT on the receipt allowlist. On compendium-server (and the
-- local Docker mirror), the schema_migrations ledger arrived pre-populated
-- via a dump/restore, so 028's *SQL* never actually executed there -- the
-- ledger just says it did. pg_dump DOES emit the per-table GRANT statements,
-- but they error out at restore time when the grantee role doesn't exist in
-- the target cluster (roles are cluster-level; a plain pg_dump/pg_restore of
-- one database never creates them), and pg_restore presses on past those
-- errors. The role was later created without its grants, leaving every SQL
-- receipt since the 2026-06-27 server move failing `permission denied`.
-- This migration is a superset of 028's grant block, re-run unconditionally
-- and idempotently -- safe whether or not 028 truly executed on a given
-- database, and it heals the drift without needing a manual one-off GRANT
-- script.
--
-- Also adds dq_runs.failure_reason so fail_run() (see dq_runs_repo.py) has
-- somewhere to persist *why* a run failed instead of discarding the reason.
--
-- Design + audit: the 2026-07-17 dqbot-tier0-repairs plan (private), spec.md

-- == 1. Read-only role for SQL receipts (idempotent re-create) =========
DO $$ BEGIN
    CREATE ROLE dq_bot_readonly NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Must mirror the allowlist in backend/services/dq_sql_receipt.py.
GRANT SELECT ON
    pages, clusters, page_clusters, annotations, captures,
    dq_observations, dq_recommendations, dq_runs, dq_run_events,
    dq_vocab_issue_types
TO dq_bot_readonly;

GRANT USAGE ON SCHEMA public TO dq_bot_readonly;

ALTER ROLE dq_bot_readonly SET statement_timeout = '5s';

-- == 2. Run forensics: persist the failure reason on dq_runs ============
ALTER TABLE dq_runs ADD COLUMN IF NOT EXISTS failure_reason TEXT;
