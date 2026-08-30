-- 016_raw_html_usable.sql
--
-- Adds a derived flag that marks whether ``raw_html`` contains enough
-- article content to render meaningfully in the preview iframe.
--
-- Populated at ingest time by running ``content_extractor`` over the
-- stored HTML. JS-rendered skeletons, auth-walled stubs, and 404-ish
-- pages will extract to near-zero text and get ``raw_html_usable=false``
-- — the Dash layer then falls through to the existing plaintext
-- renderer instead of showing an empty iframe.
--
-- Default ``false`` is intentional: newly-added columns on existing
-- rows stay conservatively "unusable" until the companion backfill
-- script (``scripts/migrations/backfill_raw_html_usable.py``) evaluates
-- them. The post-migrate hook in ``backend/db/migrate.py`` spawns that
-- script automatically.

ALTER TABLE page_content
    ADD COLUMN IF NOT EXISTS raw_html_usable BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN page_content.raw_html_usable IS
    'True when raw_html contains meaningful content (trafilatura '
    'extraction yields >= 200 chars). False for JS-rendered shells '
    'and auth-walled pages where the iframe would show nothing useful.';
