-- 030_drop_view_as_user_id.sql
-- Remove the user-aliasing column added in migration 027.
--
-- Background: the column powered an "aliased view" pattern --
-- a separate user with their own credentials whose queries scope to a
-- primary user's data. The use case ended; no future use is planned. The
-- bootstrap script and auth/JWT
-- code paths that read this column are removed alongside this migration.
--
-- Postgres drops the implicit FK and the partial index on view_as_user_id
-- automatically when the column itself is dropped, so no separate DROP
-- INDEX / DROP CONSTRAINT statements are needed.
--
-- Safe to apply on installations that never provisioned a viewer -- the
-- column is always NULL in those, and DROP COLUMN on a NULL-only column
-- is a metadata-only operation. Installations that DID have a viewer row
-- keep the row in `users` (just without its aliasing pointer); delete
-- it manually if cleanup is desired.

ALTER TABLE users DROP COLUMN IF EXISTS view_as_user_id;
