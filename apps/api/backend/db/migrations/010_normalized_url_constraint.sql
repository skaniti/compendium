-- 010_normalized_url_constraint.sql
-- Finalize the normalized_url migration:
--   1. Mark the column NOT NULL (safe after the backfill has populated
--      every row).
--   2. Drop the old md5(url) unique index.
--   3. Create the new md5(normalized_url) unique index.
--   4. Drop the intermediate non-unique index used during the backfill.
--
-- Run ONLY after scripts/migrations/009_normalized_url_backfill.py has
-- been executed with --execute and reported zero collisions. If this
-- migration errors out, the backfill script left orphaned rows — do
-- not force-apply, investigate instead.

ALTER TABLE page_content ALTER COLUMN normalized_url SET NOT NULL;
ALTER TABLE pages        ALTER COLUMN normalized_url SET NOT NULL;

DROP INDEX IF EXISTS page_content_url_key;

CREATE UNIQUE INDEX page_content_normalized_url_key
    ON page_content (md5(normalized_url));

-- Drop the intermediate non-unique index — the new unique index covers
-- its use cases.
DROP INDEX IF EXISTS idx_page_content_normalized_url_nonunique;
