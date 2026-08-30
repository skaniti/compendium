-- 037_split_proposals.sql
-- Batch C C2 (clustering rethink): nesting-derived split proposals for
-- declared supercluster groups. When a keyword group spans >=2 subgroups at
-- the finer cut of the same centroid linkage tree, the subgroups are stored
-- here as a split proposal the user can act on ("split science into
-- Weather & Volcanology / Wikipedia & Automation / ...?").
--
-- Shape: [{"label": TEXT, "cluster_db_ids": [INT], "n_clusters": INT,
--          "n_pages": INT}, ...]; NULL = no split available.

ALTER TABLE super_cluster_groups ADD COLUMN IF NOT EXISTS split_proposal JSONB;
