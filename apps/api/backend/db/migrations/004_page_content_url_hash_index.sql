-- Replace B-tree unique index on page_content.url with an MD5 hash index.
--
-- The B-tree index has a ~2704-byte key size limit. URLs with long query
-- strings (OAuth redirects, tracking params) can exceed this, causing
-- inserts to fail. An MD5 functional index has a fixed 32-byte key,
-- so it handles any URL length.
--
-- A separate hash index on url provides efficient lookups for the
-- WHERE url = %s queries in content_repo.py.

-- Step 1: Drop the old B-tree unique constraint (if it exists as a constraint).
-- If 001_initial_schema.sql was already updated to use the MD5 index,
-- this is a no-op — the index already exists in the correct form.
DO $$
BEGIN
    -- Try dropping as a constraint (original 001 created UNIQUE(url) inline)
    ALTER TABLE page_content DROP CONSTRAINT IF EXISTS page_content_url_key;
EXCEPTION WHEN undefined_object THEN
    -- Already an index, not a constraint — nothing to drop
    NULL;
END $$;

-- Step 2: Add uniqueness via MD5 hash (idempotent — skips if already exists)
CREATE UNIQUE INDEX IF NOT EXISTS page_content_url_key ON page_content (md5(url));

-- Step 3: Add a hash index for fast equality lookups (idempotent)
CREATE INDEX IF NOT EXISTS idx_page_content_url_hash ON page_content USING hash (url);
