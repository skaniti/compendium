-- 029_user_roles.sql
-- Add a role column to users for permission-based feature gates.
--
-- Three roles:
--   * 'admin' -- elevated access. Currently exposes the "copy current
--     tuner config" affordance so the admin can capture tuned values
--     and bake them into code defaults. Future admin-only surfaces
--     should gate on this column.
--   * 'demo'  -- the public demo account. Reserved for any UX that
--     should differ when a non-owner is exploring the compendium
--     (e.g. suppress destructive actions, surface a different splash).
--   * 'user'  -- default for everyone else (and aliased viewers,
--     since the viewer's effective identity is the primary's anyway).
--
-- Backfill is handled by backend/scripts/bootstrap_user.py: re-run that
-- script after applying this migration to flag your BOOTSTRAP_EMAIL
-- user as 'admin' and the demo user as 'demo'. The column default
-- ('user') keeps existing rows in a safe state until bootstrap runs.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

-- Use a separate ALTER for the CHECK so a re-run after partial failure
-- doesn't fight an already-attached column. Drop-if-exists keeps the
-- migration idempotent.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
    ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'demo', 'user'));

COMMENT ON COLUMN users.role IS
    'Permission tier: admin (elevated), demo (public demo account), user (default).';
