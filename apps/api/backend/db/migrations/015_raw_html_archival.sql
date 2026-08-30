-- 015_raw_html_archival.sql
--
-- Adds raw-HTML archival at capture time so the right-sidebar preview
-- can render the source page's own HTML + CSS inside a sandboxed iframe
-- instead of reconstructing a styled view from lossy extracted fields.
--
-- Columns added to page_content:
--   raw_html               BYTEA  — gzipped response body from the fetch.
--                                   Nullable: pre-backfill rows stay on the
--                                   plaintext renderer until the backfill
--                                   script populates them.
--   raw_html_content_type  TEXT   — e.g. 'text/html; charset=UTF-8'.
--   raw_html_fetched_at    TIMESTAMPTZ — when the HTML was captured.
--
-- New tables:
--   captured_assets        — content-addressed (sha256) image/asset store.
--                            One row per unique binary across all captures.
--   page_content_assets    — many-to-many link between page_content rows
--                            and the assets referenced by each.

ALTER TABLE page_content
    ADD COLUMN IF NOT EXISTS raw_html BYTEA,
    ADD COLUMN IF NOT EXISTS raw_html_content_type TEXT,
    ADD COLUMN IF NOT EXISTS raw_html_fetched_at TIMESTAMPTZ;

COMMENT ON COLUMN page_content.raw_html IS
    'Gzipped HTML response body captured at fetch time. Null for rows '
    'ingested before this column existed; populated by the backfill '
    'script at scripts/migrations/backfill_raw_html.py.';

CREATE TABLE IF NOT EXISTS captured_assets (
    id              BIGSERIAL PRIMARY KEY,
    sha256          CHAR(64) NOT NULL UNIQUE,
    source_url      TEXT NOT NULL,
    content_type    TEXT NOT NULL,
    byte_size       INTEGER NOT NULL,
    file_path       TEXT NOT NULL,
    downloaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE captured_assets IS
    'Content-addressed store of image/media assets referenced by archived '
    'HTML. file_path is relative to data/captures/assets/ and shards by '
    'the first two hex characters of sha256.';

COMMENT ON COLUMN captured_assets.source_url IS
    'The URL from which this binary was first downloaded. Retained for '
    'traceability; dedup key is sha256, not URL.';

CREATE TABLE IF NOT EXISTS page_content_assets (
    page_content_id BIGINT NOT NULL
        REFERENCES page_content(id) ON DELETE CASCADE,
    asset_id        BIGINT NOT NULL
        REFERENCES captured_assets(id) ON DELETE CASCADE,
    PRIMARY KEY (page_content_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_captured_assets_sha
    ON captured_assets (sha256);
CREATE INDEX IF NOT EXISTS idx_page_content_assets_page
    ON page_content_assets (page_content_id);
