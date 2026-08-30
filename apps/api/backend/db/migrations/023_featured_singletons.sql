-- 023_featured_singletons.sql
-- Adds the featured_singletons table -- the data-model home for "starfield"
-- outlier pages that didn't cluster but are surfaced in the compendium graph
-- as featured singletons (with page-title labels, not LLM-synthesized cluster
-- names).
--
-- Replaces the prior _promote_noise_to_singletons behavior in
-- backend/services/clustering_service.py: instead of promoting every HDBSCAN
-- noise point to its own cluster row in the clusters table (which produced
-- 76 single-page "clusters" in recluster 81 and conflated outliers with
-- groupings in the data model), we now select a curated subset by HDBSCAN
-- outlier_score (top-N where N = round(N_real_clusters * 0.20)) and store
-- them in this dedicated table.
--
-- Mental model: clusters group pages; featured_singletons highlight
-- representative outliers. They're rendered with different LOD on the graph
-- (singletons show titles only by default, with details on hover).
--
-- Pages referenced here are not necessarily exclusive of cluster membership
-- in some other run -- but within a given recluster_run, a page is either
-- in a cluster or in featured_singletons, never both.

CREATE TABLE featured_singletons (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page_id         BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    recluster_run   INTEGER NOT NULL REFERENCES recluster_runs(id) ON DELETE CASCADE,
    outlier_score   DOUBLE PRECISION,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (recluster_run, page_id)
);

CREATE INDEX idx_featured_singletons_recluster ON featured_singletons(recluster_run);
CREATE INDEX idx_featured_singletons_user ON featured_singletons(user_id);
