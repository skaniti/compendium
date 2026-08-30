-- 014_super_cluster.sql
-- Add super_cluster assignment column to clusters table.
-- Nullable TEXT: stores the user's topic keyword string (e.g., "Earth Science").
-- NULL means the cluster is ungrouped (no topic matched above threshold).

ALTER TABLE clusters ADD COLUMN IF NOT EXISTS super_cluster TEXT;

CREATE INDEX IF NOT EXISTS idx_clusters_super_cluster
    ON clusters(super_cluster) WHERE super_cluster IS NOT NULL;
