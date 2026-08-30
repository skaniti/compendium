-- 027_user_aliasing.sql
-- Add user aliasing column for shared-compendium scenarios.
--
-- Use case: a "viewer" user authenticates with their own
-- credentials but reads the data of a different user (the "owner"). This
-- lets us hand a viewer stable read-access to a snapshot of the owner's
-- compendium without sharing the owner's password.
--
-- Behaviour:
--   - users.view_as_user_id NULL (default) -> standard user; queries scope
--     to their own user_id.
--   - users.view_as_user_id = <other user.id> -> at JWT issuance, the
--     `sub` claim is set to view_as_user_id rather than the row's own id.
--     The auth_service / login paths consult this column. All downstream
--     queries (page_clusters, cost_events, set_current_user_id row-level
--     security context, etc.) end up scoped to the aliased user_id.
--
-- Cleanup: when the aliased view is no longer needed, simply delete the aliased
-- user row. The owner is unaffected because no FKs from the aliased
-- user's data exist (they never had any data of their own).
--
-- IF NOT EXISTS used because the migration runner re-applies on every
-- deploy (known migrate.py bug, separate concern).

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS view_as_user_id INTEGER REFERENCES users(id)
        ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_view_as_user_id
    ON users(view_as_user_id) WHERE view_as_user_id IS NOT NULL;
