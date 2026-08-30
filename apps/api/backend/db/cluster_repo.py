"""Repository for clusters, page_clusters, and cluster_edges tables."""

from backend.db.connection import get_conn


def save_clusters(
    user_id: int,
    recluster_run_id: int,
    clusters: list[dict],
) -> dict[str, int]:
    """Insert clusters for a recluster run.

    *clusters* is a list of dicts with keys: cluster_slug, cluster_name, and
    optionally stable_id / name_carried (cluster identity persistence,
    migration 036 — absent keys write NULL/FALSE, i.e. legacy behavior) and
    mean_membership_probability (mean per-cluster HDBSCAN membership
    confidence, migration 038 — absent/None writes NULL, i.e. historical
    rows or a sklearn install without probabilities_).
    Returns mapping of cluster_slug → DB id.
    """
    slug_to_id: dict[str, int] = {}

    with get_conn() as conn:
        with conn.cursor() as cur:
            for c in clusters:
                cur.execute(
                    """
                    INSERT INTO clusters (user_id, cluster_slug, cluster_name,
                                          recluster_run, stable_id, name_carried,
                                          mean_membership_probability)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        user_id,
                        c["cluster_slug"],
                        c["cluster_name"],
                        recluster_run_id,
                        c.get("stable_id"),
                        bool(c.get("name_carried", False)),
                        c.get("mean_membership_probability"),
                    ),
                )
                slug_to_id[c["cluster_slug"]] = cur.fetchone()[0]

    return slug_to_id


def get_previous_run_membership(user_id: int) -> list[dict]:
    """Clusters of the latest COMPLETED run with member page_content_ids.

    Feeds cluster identity matching (batch B 4a): the next run's clusters are
    Jaccard-matched against these member sets. Returns
    [{"id", "cluster_name", "stable_id", "content_ids": set[int]}, ...];
    empty list when the user has no completed run yet.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT c.id, c.cluster_name, c.stable_id,
                       array_agg(p.page_content_id)
                           FILTER (WHERE p.page_content_id IS NOT NULL)
                FROM clusters c
                JOIN recluster_runs r ON r.id = c.recluster_run
                LEFT JOIN page_clusters pc ON pc.cluster_id = c.id
                LEFT JOIN pages p ON p.id = pc.page_id
                WHERE c.user_id = %s
                  AND r.id = (
                      SELECT id FROM recluster_runs
                      WHERE user_id = %s AND status = 'completed'
                      ORDER BY completed_at DESC LIMIT 1
                  )
                GROUP BY c.id
                """,
                (user_id, user_id),
            )
            return [
                {
                    "id": r[0],
                    "cluster_name": r[1],
                    "stable_id": r[2],
                    "content_ids": set(r[3] or []),
                }
                for r in cur.fetchall()
            ]


def save_super_cluster_groups(
    user_id: int,
    recluster_run_id: int,
    groups: list[dict],
) -> dict[int, int]:
    """Insert discovered groups for a run (hybrid supercluster mode).

    *groups*: [{"group_index", "label", "source", "topic", "topic_similarity",
    "interest_tier", "evidence" (dict), "member_count", "page_count"}, ...].
    Returns {group_index: DB id}.
    """
    import json as _json

    index_to_id: dict[int, int] = {}
    with get_conn() as conn:
        with conn.cursor() as cur:
            for g in groups:
                cur.execute(
                    """
                    INSERT INTO super_cluster_groups
                        (user_id, recluster_run, label, source, topic,
                         topic_similarity, interest_tier, evidence,
                         member_count, page_count, split_proposal)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        user_id,
                        recluster_run_id,
                        g["label"],
                        g["source"],
                        g.get("topic"),
                        g.get("topic_similarity"),
                        g["interest_tier"],
                        _json.dumps(g.get("evidence") or {}),
                        g.get("member_count", 0),
                        g.get("page_count", 0),
                        (
                            _json.dumps(g["split_proposal"])
                            if g.get("split_proposal") else None
                        ),
                    ),
                )
                index_to_id[g["group_index"]] = cur.fetchone()[0]
    return index_to_id


def update_cluster_groups(user_id: int, assignments: dict[int, int | None]) -> None:
    """Set clusters.group_id for a run's clusters ({cluster_id: group_db_id})."""
    if not assignments:
        return
    with get_conn() as conn:
        with conn.cursor() as cur:
            for cluster_id, group_id in assignments.items():
                cur.execute(
                    "UPDATE clusters SET group_id = %s WHERE id = %s AND user_id = %s",
                    (group_id, cluster_id, user_id),
                )


def update_group_acceptance(
    user_id: int,
    group_id: int,
    keyword: str,
) -> list[int]:
    """Mark a suggested group as accepted under *keyword* (batch B 4d).

    Sets source='accepted', topic=keyword, label=keyword on the group and
    relabels its member clusters' ``super_cluster`` so the graph reflects the
    acceptance immediately (no recluster needed). Returns member cluster ids.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE super_cluster_groups
                SET source = 'accepted', topic = %s, label = %s
                WHERE id = %s AND user_id = %s
                """,
                (keyword, keyword, group_id, user_id),
            )
            cur.execute(
                """
                UPDATE clusters SET super_cluster = %s
                WHERE group_id = %s AND user_id = %s
                RETURNING id
                """,
                (keyword, group_id, user_id),
            )
            return [r[0] for r in cur.fetchall()]


def get_groups_for_user(
    user_id: int,
    recluster_run_id: int | None = None,
    source: str | None = None,
) -> list[dict]:
    """Discovered groups for a run (latest completed when run id is None),
    optionally filtered by source ('keyword' | 'suggested'). Includes member
    cluster ids/names for display."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            if recluster_run_id is None:
                cur.execute(
                    """
                    SELECT id FROM recluster_runs
                    WHERE user_id = %s AND status = 'completed'
                    ORDER BY completed_at DESC LIMIT 1
                    """,
                    (user_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return []
                recluster_run_id = row[0]

            cur.execute(
                """
                SELECT g.id, g.label, g.source, g.topic, g.topic_similarity,
                       g.interest_tier, g.evidence, g.member_count, g.page_count,
                       array_agg(c.id) FILTER (WHERE c.id IS NOT NULL),
                       array_agg(c.cluster_name) FILTER (WHERE c.id IS NOT NULL),
                       g.split_proposal,
                       array_agg(c.cluster_slug) FILTER (WHERE c.id IS NOT NULL)
                FROM super_cluster_groups g
                LEFT JOIN clusters c ON c.group_id = g.id
                WHERE g.user_id = %s AND g.recluster_run = %s
                  AND (%s::TEXT IS NULL OR g.source = %s)
                GROUP BY g.id
                ORDER BY g.page_count DESC
                """,
                (user_id, recluster_run_id, source, source),
            )
            return [
                {
                    "id": r[0],
                    "label": r[1],
                    "source": r[2],
                    "topic": r[3],
                    "topic_similarity": r[4],
                    "interest_tier": r[5],
                    "evidence": r[6] or {},
                    "member_count": r[7],
                    "page_count": r[8],
                    "cluster_ids": r[9] or [],
                    "cluster_names": r[10] or [],
                    "split_proposal": r[11],
                    "cluster_slugs": r[12] or [],
                }
                for r in cur.fetchall()
            ]


def save_page_clusters(page_cluster_pairs: list[tuple[int, int]]) -> None:
    """Bulk-insert page↔cluster associations.

    *page_cluster_pairs* is a list of (page_id, cluster_id) tuples.
    """
    if not page_cluster_pairs:
        return

    with get_conn() as conn:
        with conn.cursor() as cur:
            for page_id, cluster_id in page_cluster_pairs:
                cur.execute(
                    "INSERT INTO page_clusters (page_id, cluster_id) VALUES (%s, %s) "
                    "ON CONFLICT DO NOTHING",
                    (page_id, cluster_id),
                )


def save_edges(
    recluster_run_id: int,
    edges: list[dict],
) -> None:
    """Insert cluster similarity edges.

    *edges* is a list of dicts with keys: source_cluster_id, target_cluster_id, weight.
    """
    if not edges:
        return

    with get_conn() as conn:
        with conn.cursor() as cur:
            for e in edges:
                cur.execute(
                    """
                    INSERT INTO cluster_edges (source_cluster, target_cluster, weight, recluster_run)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                    """,
                    (
                        e["source_cluster_id"],
                        e["target_cluster_id"],
                        e["weight"],
                        recluster_run_id,
                    ),
                )


def get_clusters_for_user(user_id: int, recluster_run_id: int | None = None) -> list[dict]:
    """Get clusters for a user, optionally filtered to a specific run.

    If recluster_run_id is None, returns clusters from the latest completed run.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            if recluster_run_id is None:
                # Find latest completed run
                cur.execute(
                    """
                    SELECT id FROM recluster_runs
                    WHERE user_id = %s AND status = 'completed'
                    ORDER BY completed_at DESC LIMIT 1
                    """,
                    (user_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return []
                recluster_run_id = row[0]

            cur.execute(
                """
                SELECT c.id, c.cluster_slug, c.cluster_name, c.recluster_run,
                       c.super_cluster,
                       array_agg(pc.page_id) FILTER (WHERE pc.page_id IS NOT NULL) AS page_ids
                FROM clusters c
                LEFT JOIN page_clusters pc ON pc.cluster_id = c.id
                WHERE c.user_id = %s AND c.recluster_run = %s
                GROUP BY c.id
                ORDER BY c.cluster_name
                """,
                (user_id, recluster_run_id),
            )
            return [
                {
                    "id": r[0],
                    "cluster_slug": r[1],
                    "cluster_name": r[2],
                    "recluster_run": r[3],
                    "super_cluster": r[4],
                    "page_ids": r[5] or [],
                }
                for r in cur.fetchall()
            ]


def get_cluster_page_details(cluster_id: int) -> list[dict]:
    """Get title and domain for pages belonging to a cluster."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.title, p.domain
                FROM pages p
                JOIN page_clusters pc ON pc.page_id = p.id
                WHERE pc.cluster_id = %s
                ORDER BY p.title
                """,
                (cluster_id,),
            )
            return [{"id": r[0], "title": r[1], "domain": r[2]} for r in cur.fetchall()]


def get_noise_pages(user_id: int) -> list[dict]:
    """Pages not assigned to any cluster in the latest completed run."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT rr.id FROM recluster_runs rr
                WHERE rr.user_id = %s AND rr.status = 'completed'
                ORDER BY rr.completed_at DESC LIMIT 1
                """,
                (user_id,),
            )
            row = cur.fetchone()
            if not row:
                return []
            run_id = row[0]

            cur.execute(
                """
                SELECT p.id, p.title, p.domain, p.url
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s AND p.status = 'active'
                  AND p.id NOT IN (
                      SELECT pc.page_id FROM page_clusters pc
                      JOIN clusters cl ON pc.cluster_id = cl.id
                      WHERE cl.recluster_run = %s
                  )
                ORDER BY p.visited_at DESC
                """,
                (user_id, run_id),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]


def get_noise_stats(user_id: int, recluster_run_id: int) -> tuple[int, int]:
    """Return (noise_count, total_member_count) for one run.

    "Noise" here means singleton clusters (size == 1), mirroring
    ``frontend/dash/callbacks/graph.py``'s ``update_hbar_cluster_stats``
    live query (lines ~245-258) -- deliberately distinct from the
    ``recluster_runs.noise_count`` column, which is a snapshot captured at
    completion time and can drift from the live page_clusters state.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) FILTER (WHERE size = 1) AS noise,
                    COALESCE(SUM(size), 0)          AS total
                FROM (
                    SELECT pc.cluster_id, COUNT(*) AS size
                    FROM page_clusters pc
                    JOIN clusters c ON c.id = pc.cluster_id
                    WHERE c.user_id = %s AND c.recluster_run = %s
                    GROUP BY pc.cluster_id
                ) s
                """,
                (user_id, recluster_run_id),
            )
            noise, total = cur.fetchone()
    return noise or 0, total or 0


def get_suggested_group_count(user_id: int, recluster_run_id: int) -> int:
    """COUNT(DISTINCT label) of ``source='suggested'`` super_cluster_groups
    for a run -- mirrors the "M suggested" segment of
    ``update_hbar_cluster_stats`` (frontend/dash/callbacks/graph.py:265-273).
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(DISTINCT label)
                FROM super_cluster_groups
                WHERE user_id = %s AND recluster_run = %s
                  AND source = 'suggested'
                """,
                (user_id, recluster_run_id),
            )
            return cur.fetchone()[0] or 0


def get_edge_weight_stats(user_id: int) -> dict:
    """Edge weight statistics (min, max, mean, count) for latest run."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT rr.id FROM recluster_runs rr
                WHERE rr.user_id = %s AND rr.status = 'completed'
                ORDER BY rr.completed_at DESC LIMIT 1
                """,
                (user_id,),
            )
            row = cur.fetchone()
            if not row:
                return {"count": 0}
            run_id = row[0]

            cur.execute(
                """
                SELECT COUNT(*), MIN(weight), MAX(weight), AVG(weight)
                FROM cluster_edges WHERE recluster_run = %s
                """,
                (run_id,),
            )
            r = cur.fetchone()
            return {
                "count": r[0] or 0,
                "min": round(float(r[1]), 3) if r[1] is not None else None,
                "max": round(float(r[2]), 3) if r[2] is not None else None,
                "mean": round(float(r[3]), 3) if r[3] is not None else None,
            }


def get_edges(user_id: int, recluster_run_id: int | None = None) -> list[dict]:
    """Get cluster edges for a user's latest (or specified) recluster run."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            if recluster_run_id is None:
                cur.execute(
                    """
                    SELECT id FROM recluster_runs
                    WHERE user_id = %s AND status = 'completed'
                    ORDER BY completed_at DESC LIMIT 1
                    """,
                    (user_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return []
                recluster_run_id = row[0]

            cur.execute(
                """
                SELECT ce.id, cs.cluster_slug AS source_slug, ct.cluster_slug AS target_slug,
                       ce.weight, ce.recluster_run
                FROM cluster_edges ce
                JOIN clusters cs ON ce.source_cluster = cs.id
                JOIN clusters ct ON ce.target_cluster = ct.id
                WHERE ce.recluster_run = %s
                ORDER BY ce.weight DESC
                """,
                (recluster_run_id,),
            )
            return [
                {
                    "id": r[0],
                    "source_slug": r[1],
                    "target_slug": r[2],
                    "weight": r[3],
                    "recluster_run": r[4],
                }
                for r in cur.fetchall()
            ]


def update_super_clusters(
    user_id: int,
    assignments: dict[int, str | None],
) -> None:
    """Batch-update super_cluster column on clusters.

    *assignments* maps cluster DB id → topic keyword string (or None to clear).
    """
    if not assignments:
        return

    with get_conn() as conn:
        with conn.cursor() as cur:
            for cluster_id, topic in assignments.items():
                cur.execute(
                    "UPDATE clusters SET super_cluster = %s " "WHERE id = %s AND user_id = %s",
                    (topic, cluster_id, user_id),
                )
        conn.commit()


def get_super_cluster_map(
    user_id: int,
    recluster_run_id: int | None = None,
) -> dict[str, str | None]:
    """Return {cluster_slug: super_cluster_value} for the latest completed run."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            if recluster_run_id is None:
                cur.execute(
                    """
                    SELECT id FROM recluster_runs
                    WHERE user_id = %s AND status = 'completed'
                    ORDER BY completed_at DESC LIMIT 1
                    """,
                    (user_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return {}
                recluster_run_id = row[0]

            cur.execute(
                """
                SELECT cluster_slug, super_cluster
                FROM clusters
                WHERE user_id = %s AND recluster_run = %s
                """,
                (user_id, recluster_run_id),
            )
            return {r[0]: r[1] for r in cur.fetchall()}


def get_cluster_names(
    user_id: int,
    recluster_run_id: int | None = None,
) -> dict[str, str]:
    """Return {cluster_slug: cluster_name} for the latest completed run.

    Same run resolution as get_super_cluster_map above. Consumers use this
    to replace slug-derived display names (KnowledgeGraph.to_d3_json's
    ``cid.replace('_',' ').title()`` fallback) with the LLM-authored
    ``clusters.cluster_name`` -- casing/hyphenation differ ("Cricut Iron-On
    Techniques" vs "Cricut Iron On Techniques").
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            if recluster_run_id is None:
                cur.execute(
                    """
                    SELECT id FROM recluster_runs
                    WHERE user_id = %s AND status = 'completed'
                    ORDER BY completed_at DESC LIMIT 1
                    """,
                    (user_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return {}
                recluster_run_id = row[0]

            cur.execute(
                """
                SELECT cluster_slug, cluster_name
                FROM clusters
                WHERE user_id = %s AND recluster_run = %s
                      AND cluster_name IS NOT NULL
                """,
                (user_id, recluster_run_id),
            )
            return {r[0]: r[1] for r in cur.fetchall()}


def get_top_clusters_for_keyword(
    user_id: int,
    keyword: str,
    limit: int = 5,
) -> list[dict]:
    """Top *limit* member clusters of a supercluster keyword.

    Scoped to the latest completed recluster run (same run resolution as
    get_super_cluster_map above). Ordered by mean_membership_probability
    DESC NULLS LAST (the tooltip's "importance" metric, migration 038 --
    NULLS LAST so pre-migration/pre-probabilities_ runs still rank sanely),
    then page_count DESC, then cluster_name for a fully deterministic tie
    order.

    Uses COUNT(pc.page_id) rather than get_clusters_for_user's
    array_agg(pc.page_id) -- we only need the count here, so materializing
    the full page-id array per cluster (as get_clusters_for_user does for
    its page_ids field) would be pure waste for this call site.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id FROM recluster_runs
                WHERE user_id = %s AND status = 'completed'
                ORDER BY completed_at DESC LIMIT 1
                """,
                (user_id,),
            )
            row = cur.fetchone()
            if row is None:
                return []
            recluster_run_id = row[0]

            cur.execute(
                """
                SELECT c.cluster_name, COUNT(pc.page_id) AS page_count,
                       c.mean_membership_probability
                FROM clusters c
                LEFT JOIN page_clusters pc ON pc.cluster_id = c.id
                WHERE c.user_id = %s AND c.recluster_run = %s
                      AND c.super_cluster = %s
                GROUP BY c.id, c.cluster_name, c.mean_membership_probability
                ORDER BY c.mean_membership_probability DESC NULLS LAST,
                         page_count DESC, c.cluster_name
                LIMIT %s
                """,
                (user_id, recluster_run_id, keyword, limit),
            )
            return [
                {
                    "cluster_name": r[0],
                    "page_count": r[1],
                    "mean_membership_probability": r[2],
                }
                for r in cur.fetchall()
            ]
