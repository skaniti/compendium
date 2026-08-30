"""Build a KnowledgeGraph from PostgreSQL data.

Queries active pages + clusters from the database and constructs a flat graph:
- Level-1 page nodes (each with parent_id = cluster slug for hull grouping)
- No root node, no topic cluster nodes -- clusters are metadata, not graph nodes
- Cluster similarity edges from cluster_edges table
"""

import logging
import re
from datetime import datetime

from backend.db import cluster_repo, featured_repo, page_repo
from backend.models.graph import (
    GraphEdge,
    GraphNode,
    KnowledgeGraph,
)

logger = logging.getLogger(__name__)


def _slugify(text: str) -> str:
    """Convert text to a URL-safe slug for node IDs."""
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def build_graph_from_db(
    user_id: int,
    visited_after: datetime | None = None,
) -> KnowledgeGraph:
    """Build a flat KnowledgeGraph from PostgreSQL data.

    Creates page nodes (level=1) with cluster metadata stored as parent_id.
    Edges come from the cluster_edges table.

    parent_id allocation:
      * Pages in a real HDBSCAN cluster -> ``parent_id`` = cluster slug,
        ``kind="cluster"``.
      * Pages selected as featured singletons -> ``parent_id="_solo_<page_id>"``,
        ``kind="singleton"`` (each becomes its own 1-page faux-cluster so the
        force layout scatters them across the nebula instead of bucketing them
        into one region; page-title labels are still rendered).
      * Pages that are HDBSCAN noise but not featured, OR pages that the
        pre-clustering filter excluded (boilerplate-summary, URL-fallback,
        duplicate, etc.) -> ``parent_id="_solo_<page_id>"``, ``kind="unclustered"``
        (also rendered as 1-page faux-clusters but without page-title labels;
        contribute to nebula visual density without cluttering it with
        low-confidence labels).

    The "solo" parent_id pattern was introduced 2026-04-27 to address the
    "lost nebula density" issue after the featured-singletons split:
    bucketing every non-clustered page into ``_unclustered`` / ``_singletons``
    collapsed them into 1-2 visual regions; per-page faux-clusters preserve
    each page's spatial position while keeping the data model clean
    (clusters table stays the home of real groupings; featured_singletons
    table stays the home of curated outliers).

    Args:
        user_id: The user whose data to build the graph from.
        visited_after: If set, only include pages visited at or after this
            datetime. Default is None (all time). Enables the frontend
            time-window filter (e.g. "last 30 days").

    Returns:
        A KnowledgeGraph ready for frontend consumption.
    """
    nodes: dict[str, GraphNode] = {}

    # Load active pages with their cluster assignments
    active_pages = page_repo.get_active_pages(user_id)
    clusters = cluster_repo.get_clusters_for_user(user_id)

    # Apply time-window filter if requested
    if visited_after is not None:
        active_pages = [
            p for p in active_pages if p.get("visited_at") and p["visited_at"] >= visited_after
        ]

    # Build page_id -> cluster_slug mapping
    page_to_cluster: dict[int, str] = {}
    cluster_slug_to_name: dict[str, str] = {}
    for c in clusters:
        cluster_slug_to_name[c["cluster_slug"]] = c["cluster_name"]
        for page_id in c.get("page_ids", []):
            page_to_cluster[page_id] = c["cluster_slug"]

    # Featured singletons: HDBSCAN-noise pages selected by outlier_score for
    # the starfield. Stored separately from clusters; rendered with their
    # page title (no LLM-synthesized cluster name) and a different LOD.
    # See backend/db/migrations/023_featured_singletons.sql.
    featured = featured_repo.list_featured_singletons_for_run(user_id)
    page_to_outlier: dict[int, float] = {
        f["page_id"]: f["outlier_score"]
        for f in featured
        if f.get("outlier_score") is not None
    }
    featured_page_ids: set[int] = {f["page_id"] for f in featured}

    for page in active_pages:
        title = page.get("title") or ""
        if not title:
            continue

        leaf_id = _slugify(title)
        # Three buckets per page:
        #   clustered  -> real cluster slug, kind="cluster"
        #   featured   -> _solo_<page_id> faux-cluster, kind="singleton"
        #   unclustered-> _solo_<page_id> faux-cluster, kind="unclustered"
        # See module docstring for the rationale behind the per-page faux
        # cluster pattern (nebula visual density + spatial scattering).
        if page["id"] in page_to_cluster:
            cluster_slug = page_to_cluster[page["id"]]
            node_kind = "cluster"
            outlier_score = None
        elif page["id"] in featured_page_ids:
            cluster_slug = f"_solo_{page['id']}"
            node_kind = "singleton"
            outlier_score = page_to_outlier.get(page["id"])
        else:
            cluster_slug = f"_solo_{page['id']}"
            node_kind = "unclustered"
            outlier_score = None
        capture_text_id = page.get("capture_text_id", "")

        # Compute visited_at ISO string for the time-window filter
        visited_at = page.get("visited_at")
        visited_iso = visited_at.isoformat() if visited_at else None

        if leaf_id in nodes:
            leaf_node = nodes[leaf_id]
            leaf_node.visit_count += 1
            if capture_text_id and capture_text_id not in leaf_node.capture_ids:
                leaf_node.capture_ids.append(capture_text_id)
            if page["url"] and page["url"] not in leaf_node.page_urls:
                leaf_node.page_urls.append(page["url"])
            # Keep the earliest visited_at across all visits to this node
            if visited_iso and (
                leaf_node.first_visited_at is None or visited_iso < leaf_node.first_visited_at
            ):
                leaf_node.first_visited_at = visited_iso
        else:
            leaf_node = GraphNode(
                id=leaf_id,
                label=title,
                level=1,
                kind=node_kind,
                parent_id=cluster_slug,
                page_urls=[page["url"]] if page.get("url") else [],
                capture_ids=[capture_text_id] if capture_text_id else [],
                visit_count=1,
                first_visited_at=visited_iso,
                outlier_score=outlier_score,
            )
            nodes[leaf_id] = leaf_node

    # Load cluster similarity edges from DB
    edges: list[GraphEdge] = []
    db_edges = cluster_repo.get_edges(user_id)
    for e in db_edges:
        edges.append(
            GraphEdge(
                source_id=e["source_slug"],
                target_id=e["target_slug"],
                edge_type="similarity",
                weight=e["weight"],
            )
        )

    n_singleton = sum(1 for n in nodes.values() if n.kind == "singleton")
    n_unclustered = sum(1 for n in nodes.values() if n.kind == "unclustered")
    n_cluster = len(nodes) - n_singleton - n_unclustered
    logger.info(
        f"Graph built from DB: {len(nodes)} nodes "
        f"({n_cluster} clustered, {n_singleton} featured singletons "
        f"[solo faux-clusters], {n_unclustered} unclustered "
        f"[solo faux-clusters, label-suppressed]), "
        f"{len(edges)} edges, {len(clusters)} clusters"
    )

    return KnowledgeGraph(
        nodes=list(nodes.values()),
        edges=edges,
    )
