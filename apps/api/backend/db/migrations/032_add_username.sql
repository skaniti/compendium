-- 032_add_username.sql
-- Add an optional, unique username so users can log in with either their
-- email or a username. Email login is unchanged; this is purely additive.
--
-- Nullable + UNIQUE: PostgreSQL permits multiple NULLs under a UNIQUE
-- constraint, so every existing user (no username) is unaffected; only
-- rows where a username is explicitly set are held unique. IF NOT EXISTS
-- keeps the migration safe under the re-apply-on-deploy migrate runner
-- (same convention as 027_user_aliasing).

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;
