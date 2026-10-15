-- 054_page_content_kind.sql
-- Adds page_content.content_kind: a coarse label for what kind of page the
-- content is (e.g. auth_login, app_dashboard_ui, search_results,
-- error_or_empty, article, ...). It is filled by the ingest-time labeller that
-- a later phase adds; until then every row is NULL. NULL = unknown and is never
-- excluded from clustering (ClusteringService._filter_clusterable_pages only
-- drops the kinds listed in EXCLUDED_CONTENT_KINDS).

ALTER TABLE page_content ADD COLUMN IF NOT EXISTS content_kind TEXT;
