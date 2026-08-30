-- 021_dq_recommendations_promoted_at.sql
-- Adds promoted_at to track user-initiated manual promotion of rank-6+ recs
-- into the active inbox. list_pending orders by (promoted_at DESC NULLS LAST,
-- rank_in_run ASC) so promoted recs surface at the top of the top-5.
-- Replaces the v1 UI-owned dq-bot-promoted-ids Store (see Layer-4 Task 4.4
-- commit for context).

ALTER TABLE dq_recommendations
    ADD COLUMN promoted_at TIMESTAMPTZ;

-- No index needed at current corpus size; revisit if list_pending becomes slow.
