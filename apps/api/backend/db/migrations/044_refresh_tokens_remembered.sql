-- 044_refresh_tokens_remembered.sql
-- Session expiry tuning (docs/project-plans/2026-09-09-125949-session-
-- expiry-tuning/spec.md, decision D1, amended 2026-09-10): a "remembered"
-- refresh token (90-day expiry, no idle lapse, instead of the default
-- 7-day/60-minute policy) is granted when the token is minted while the
-- request's ingress verdict is tailnet-trusted -- not a client-supplied
-- opt-in. This column persists that verdict alongside the token; it is
-- recomputed from the CURRENT ingress verdict at every mint (login and each
-- rotation), never carried forward from the previous token's own flag.
-- migrate.py records each applied migration's filename stem in
-- schema_migrations and skips versions already there
-- (backend/db/migrate.py:100-140), so IF NOT EXISTS here is defence-in-
-- depth, not something the runner requires -- same convention as
-- 032_add_username / 043_dq_run_kind_and_gate.

ALTER TABLE refresh_tokens
    ADD COLUMN IF NOT EXISTS remembered BOOLEAN NOT NULL DEFAULT FALSE;
