-- 047_skip_category_web_app.sql
-- Adds the 'web_app' skip category (Pipeline v2 fix round). Recreates the
-- CHECK from 046 with the new id; the ids mirror
-- backend/services/skip_categories.py. Idempotent: drop-if-exists then add.

ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_skip_category_check;
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
    'web_app',
    'other'
    ));
