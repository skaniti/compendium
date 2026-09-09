-- 044_refresh_tokens_remembered.sql
-- Session expiry tuning (docs/project-plans/2026-09-09-125949-session-
-- expiry-tuning/spec.md, decision D1): a "remember this device" login opts
-- into a 90-day refresh token with no idle lapse instead of the default
-- 7-day/60-minute policy. This column persists that flag alongside the
-- token so rotation can carry it forward. migrate.py records each applied
-- migration's filename stem in schema_migrations and skips versions already
-- there (backend/db/migrate.py:100-140), so IF NOT EXISTS here is
-- defence-in-depth, not something the runner requires -- same convention as
-- 032_add_username / 043_dq_run_kind_and_gate.

ALTER TABLE refresh_tokens
    ADD COLUMN IF NOT EXISTS remembered BOOLEAN NOT NULL DEFAULT FALSE;
