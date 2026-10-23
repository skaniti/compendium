-- 060_page_content_assets_page_url.sql
-- captured_assets is unique per (user_id, sha256), so its source_url is the URL
-- of whichever capture archived the bytes first. A page that references the same
-- bytes under a different URL links that row, and the preview renderer (which
-- matches <img src> against URLs) then falls back to the original site.
-- page_url records the URL THIS page used for the linked asset (filled by the
-- archiver). NULL means "the same as captured_assets.source_url" (every link made
-- before this migration; backend/scripts/backfill_asset_page_urls.py recovers the ones that differ).

ALTER TABLE page_content_assets ADD COLUMN IF NOT EXISTS page_url TEXT;

COMMENT ON COLUMN page_content_assets.page_url IS
    'Absolute URL the page used for this asset; differs from '
    'captured_assets.source_url when the same bytes were archived from another '
    'URL first. NULL = same as source_url (links made before migration 060). '
    'The preview renderer matches on both.';
