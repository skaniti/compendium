-- 046_page_skip_category.sql
-- Standardized skip-gate category (Pipeline v2, spec 12.1). Nullable: only
-- gate-archived pages carry one; domain-filter skips and non-gate archives
-- stay NULL. The ids mirror backend/services/skip_categories.py.
-- migrate.py skips versions already recorded, so IF NOT EXISTS / the guarded
-- constraint add are defence-in-depth -- same convention as 044/045.

ALTER TABLE pages ADD COLUMN IF NOT EXISTS skip_category TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pages_skip_category_check'
    ) THEN
        ALTER TABLE pages ADD CONSTRAINT pages_skip_category_check
            CHECK (skip_category IS NULL OR skip_category IN (
    'login_wall',
    'user_specific',
    'store_listing',
    'homepage_index',
    'search_results',
    'asset_library',
    'entertainment_video',
    'disambiguation',
    'error_page',
    'content_free_stub',
    'local_file',
    'other'
            ));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pages_skip_category
    ON pages (skip_category) WHERE skip_category IS NOT NULL;
