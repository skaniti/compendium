-- 031_user_scope_captured_assets.sql
-- User-scope the captured_assets table so personal and demo data live in
-- separate on-disk subdirectories under one app instance.
--
-- Background: the laptop-server-setup deployment runs ONE app stack with
-- TWO users (personal + demo). Pre-031, captured_assets was a globally
-- sha256-keyed cache shared across all users -- one row, one file, multiple
-- referrers. That blocked the deployment's backup strategy: restic needs
-- to back up the personal user's assets without dragging the demo user's
-- bytes along (the demo data is reproducible from the curation script,
-- per plan section 21.5).
--
-- After 031: same image captured by both users = two rows + two copies on
-- disk. Explicit tradeoff for clean per-user separation.
--
-- The on-disk layout becomes:
--   data/captures/assets/user_<id>/<aa>/<sha>.<ext>
-- New captures write to the user-subdir layout. Pre-031 rows keep their
-- existing file_path values pointing at the unscoped layout -- retrieval
-- uses file_path from the DB so old files keep working without a disk
-- migration. New rows get the user-subdir prefix from asset_archiver.

-- Add user_id column. Nullable initially so the backfill can run; we'll
-- set NOT NULL at the end after the backfill completes.
ALTER TABLE captured_assets ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);

-- Backfill from page_content_assets -> page_content -> pages -> user_id.
-- Most rows resolve cleanly because every captured asset was originally
-- fetched in the context of a single user's capture. The DISTINCT guards
-- against an asset being linked to multiple pages of the SAME user.
UPDATE captured_assets ca
SET user_id = sub.user_id
FROM (
    SELECT DISTINCT pca.asset_id, p.user_id
    FROM page_content_assets pca
    JOIN pages p ON p.page_content_id = pca.page_content_id
) sub
WHERE ca.id = sub.asset_id AND ca.user_id IS NULL;

-- Edge case: an asset linked to pages from MULTIPLE users (rare but
-- possible if the old global cache served two users). The UPDATE above
-- picks one user_id deterministically (DISTINCT loses the tie); the row
-- becomes that user's. The other user's page still references the row,
-- which is fine at the DB level but breaks RLS isolation. Surface the
-- count so we can detect and remediate manually if seen:
DO $$
DECLARE
    cross_user_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO cross_user_count
    FROM (
        SELECT pca.asset_id
        FROM page_content_assets pca
        JOIN pages p ON p.page_content_id = pca.page_content_id
        GROUP BY pca.asset_id
        HAVING COUNT(DISTINCT p.user_id) > 1
    ) x;
    IF cross_user_count > 0 THEN
        RAISE NOTICE '031_user_scope_captured_assets: % asset(s) referenced by pages from multiple users; one user_id picked deterministically. Manual remediation may be required.', cross_user_count;
    END IF;
END $$;

-- Orphan rows (no page reference yet) get tagged to whatever user_id is
-- set on the migration-running connection (i.e., the BOOTSTRAP_EMAIL
-- user via migrate.py). Falls back to user id 1 if the session variable
-- isn't set, which is the legacy dev user.
UPDATE captured_assets
SET user_id = COALESCE(
    NULLIF(current_setting('app.current_user_id', true), '')::INTEGER,
    1
)
WHERE user_id IS NULL;

-- Now we can enforce NOT NULL.
ALTER TABLE captured_assets ALTER COLUMN user_id SET NOT NULL;

-- Drop the global UNIQUE (sha256) constraint and replace with composite.
-- pg_constraint lookup keeps this idempotent across re-runs of migrate.py.
DO $$
DECLARE
    constr_name TEXT;
BEGIN
    SELECT conname INTO constr_name
    FROM pg_constraint
    WHERE conrelid = 'captured_assets'::regclass
      AND contype = 'u'
      AND conkey = ARRAY[
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'captured_assets'::regclass AND attname = 'sha256')
      ];
    IF constr_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE captured_assets DROP CONSTRAINT %I', constr_name);
    END IF;
END $$;

ALTER TABLE captured_assets DROP CONSTRAINT IF EXISTS captured_assets_user_sha_unique;
ALTER TABLE captured_assets ADD CONSTRAINT captured_assets_user_sha_unique
    UNIQUE (user_id, sha256);

-- Replace the global sha256 index with a composite for the per-user lookup
-- pattern (WHERE user_id = %s AND sha256 = %s).
DROP INDEX IF EXISTS idx_captured_assets_sha;
CREATE INDEX IF NOT EXISTS idx_captured_assets_user_sha
    ON captured_assets (user_id, sha256);

-- RLS: matches the pattern in migration 003 for captures/pages/clusters.
ALTER TABLE captured_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS captured_assets_isolation ON captured_assets;
CREATE POLICY captured_assets_isolation ON captured_assets
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);

COMMENT ON COLUMN captured_assets.user_id IS
    'Owner of this asset. Per-user partitioning so personal vs demo data '
    'live in separate on-disk subdirectories and the restic backup of '
    'personal data does not drag in demo bytes. Pre-031 rows backfilled '
    'from the page_content_assets join.';
