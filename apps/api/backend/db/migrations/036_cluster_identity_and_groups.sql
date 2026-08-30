-- 036_cluster_identity_and_groups.sql
-- Batch B of the clustering rethink (docs/project-plans/2026-07-08-180037-
-- clustering-supercluster-rethink/plan-batch-B.md).
--
-- 4a: cluster identity persistence — stable_id survives recluster runs
-- (greedy Jaccard match on member page_content_ids); name_carried marks
-- clusters whose name was inherited from the previous run instead of a
-- fresh LLM call.
--
-- 4b: hybrid superclusters — discovered groups persisted per run;
-- clusters.group_id links a cluster to its group. clusters.super_cluster
-- (migration 014) keeps holding the display label in BOTH modes so the
-- D3 Phase-1.5 layout and /api/topics counts work unchanged.

ALTER TABLE clusters ADD COLUMN IF NOT EXISTS stable_id TEXT;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS name_carried BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_clusters_stable ON clusters(user_id, stable_id);

CREATE TABLE IF NOT EXISTS super_cluster_groups (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recluster_run    INTEGER NOT NULL REFERENCES recluster_runs(id) ON DELETE CASCADE,
    label            TEXT NOT NULL,
    source           TEXT NOT NULL,           -- 'keyword' | 'suggested'
    topic            TEXT,                    -- matched topic_interests keyword, if any
    topic_similarity REAL,
    interest_tier    TEXT NOT NULL,           -- declared | recurrent | casual | binge
    evidence         JSONB,                   -- visit-recurrence evidence dict
    member_count     INTEGER NOT NULL DEFAULT 0,
    page_count       INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scg_user_run ON super_cluster_groups(user_id, recluster_run);

ALTER TABLE super_cluster_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS super_cluster_groups_isolation ON super_cluster_groups;
CREATE POLICY super_cluster_groups_isolation ON super_cluster_groups
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);

ALTER TABLE clusters ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES super_cluster_groups(id) ON DELETE SET NULL;
