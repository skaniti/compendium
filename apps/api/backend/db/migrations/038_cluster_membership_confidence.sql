-- 038_cluster_membership_confidence.sql
-- Per-cluster mean HDBSCAN membership confidence (2026-07-13 SC tooltip
-- "importance" metric pick). hdb.probabilities_ gives each member point's
-- soft-clustering strength in [0, 1]; mean_membership_probability is the
-- average over a cluster's member points (noise, label -1, excluded).
--
-- Nullable: historical rows were written before probabilities_ capture
-- existed and have no way to backfill (the per-run labels/probabilities
-- array isn't retained once a run completes) -- they stay NULL forever.

ALTER TABLE clusters ADD COLUMN IF NOT EXISTS mean_membership_probability REAL;
