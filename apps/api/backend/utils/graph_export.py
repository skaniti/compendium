"""Convert KnowledgeGraph to D3 force-layout data.

Transforms backend graph models into the JSON shape that the D3
force simulation (the web frontend's graph canvas) expects:
{
    "nodes": [{"id", "label", "parent_id", "visit_count", ...}],
    "links": [{"source", "target", "weight"}],
    "clusters": [{"id", "name", "page_ids", "super_cluster", "super_cluster_icon"}],
    "super_clusters": [{"keyword", "icon_id"}]
}
"""

from backend.models.graph import KnowledgeGraph


def to_d3_elements(graph: KnowledgeGraph, user_id: int | None = None) -> dict:
    """Convert a KnowledgeGraph into D3-format data.

    Uses the model's ``to_d3_json()`` method which already produces
    the correct shape including cluster metadata derived from page
    parent_id values.

    When *user_id* is provided, enriches the output with super-cluster
    metadata (topic assignments and icon ids) for the D3 visualization.

    Args:
        graph: The full knowledge graph.
        user_id: If set, load and attach super-cluster metadata.

    Returns:
        Dict with nodes, links, clusters, and optionally super_clusters.
    """
    d3_data = graph.to_d3_json()

    if user_id is not None:
        from backend.db import auth_repo, cluster_repo

        sc_map = cluster_repo.get_super_cluster_map(user_id)
        cluster_names = cluster_repo.get_cluster_names(user_id)
        prefs = auth_repo.get_preferences(user_id)
        topics = prefs.get("topic_interests", [])
        topic_lookup = {t["keyword"]: t for t in topics}

        # Enrich each cluster entry with super_cluster data, and replace
        # to_d3_json's slug-derived .title() display name with the DB's
        # LLM-authored cluster_name (graph.py's comment always promised
        # this overwrite; it was never actually performed until 2026-07-14
        # -- captions showed "Cricut Iron On Techniques" while the DB and
        # the SC hover tooltip said "Cricut Iron-On Techniques"). Solo
        # pseudo-clusters have no DB row, so .get() leaves them untouched.
        for cluster in d3_data["clusters"]:
            real_name = cluster_names.get(cluster["id"])
            if real_name:
                cluster["name"] = real_name
            sc = sc_map.get(cluster["id"])
            if sc and sc in topic_lookup:
                cluster["super_cluster"] = sc
                cluster["super_cluster_icon"] = topic_lookup[sc].get("icon_id")
            # Clusters without a super_cluster assignment get no extra fields

        # Add topic list for D3 color palette assignment
        d3_data["super_clusters"] = [
            {"keyword": t["keyword"], "icon_id": t.get("icon_id")} for t in topics
        ]

        # Hybrid discovered groups (batch C C1): attach group id/tier/label
        # per cluster so D3 can render tier-driven collapse (casual/binge
        # groups as one dense mass). Empty in legacy keywords mode — the
        # groups table has no rows for the run, so D3 behavior is unchanged.
        groups = cluster_repo.get_groups_for_user(user_id)
        group_by_cluster = {}
        for g in groups:
            for slug in g["cluster_slugs"]:  # d3 cluster ids ARE slugs
                group_by_cluster[slug] = g
        for cluster in d3_data["clusters"]:
            g = group_by_cluster.get(cluster["id"])
            if g:
                cluster["group_id"] = g["id"]
                cluster["group_tier"] = g["interest_tier"]
                cluster["group_label"] = g["label"]
        d3_data["groups"] = [
            {"id": g["id"], "label": g["label"], "tier": g["interest_tier"],
             "source": g["source"]}
            for g in groups
        ]

    return d3_data
