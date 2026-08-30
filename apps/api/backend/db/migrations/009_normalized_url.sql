-- 009_normalized_url.sql
-- Add nullable normalized_url columns to page_content and pages.
--
-- Plan 04 phase 1 of 3:
--   009 (this file)  — add nullable columns + indexes (this migration)
--   scripts/migrations/009_normalized_url_backfill.py — compute + backfill
--                                                       + collision merge
--   010_normalized_url_constraint.sql — NOT NULL + unique index swap
--
-- The column is added nullable here so the Python backfill script can
-- populate it idempotently across many rows. The NOT NULL tightening
-- and unique-index swap land in migration 010 after the backfill has
-- verified zero collisions remain.

ALTER TABLE page_content ADD COLUMN IF NOT EXISTS normalized_url TEXT;
ALTER TABLE pages        ADD COLUMN IF NOT EXISTS normalized_url TEXT;

-- No B-tree index on normalized_url at this stage. Very long URLs
-- (OAuth redirects, Base64 unsubscribe links) exceed PostgreSQL's
-- 2704-byte B-tree index row limit. Migration 010 creates the real
-- unique index using md5(normalized_url) — same strategy as the
-- existing page_content_url_key index (see migration 004). For the
-- intermediate backfill phase, sequential scans over ~2k rows are
-- cheap enough that no supporting index is needed.
