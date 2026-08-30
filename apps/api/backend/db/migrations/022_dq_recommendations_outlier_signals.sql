-- 022_dq_recommendations_outlier_signals.sql
-- Adds outlier_signals to dq_recommendations for dqBot-authored callouts
-- describing why a given rec is unusual among its siblings. Rendered by the
-- batch-approve modal's peel-out list and as subtle inline hints on inbox
-- cards. Nullable -- legacy recs and recs where dqBot didnt flag anything
-- leave this NULL; the frontend falls back to the count-based heuristic when
-- empty.
--
-- Shape: a JSON object with a 'labels' array of short strings, e.g.
--   {"labels": ["23 pages (median 5)", "arxiv-heavy (78% single domain)"]}
-- Schema is deliberately loose -- these are display hints, not structured
-- data the backend needs to reason about.

ALTER TABLE dq_recommendations
    ADD COLUMN outlier_signals JSONB;
