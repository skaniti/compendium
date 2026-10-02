"""Read-only queries for the Clusters dev view.

Every query is scoped to the caller: through the table's own user_id
(clusters, recluster_runs, super_cluster_groups, featured_singletons) or
through captures for pages. cluster_edges has no user column, so edges are
reached only through the caller's clusters. This module exists instead of
reusing cluster_repo's readers because some of those take an id with no user
filter (get_cluster_page_details, get_edges): never call those with a
client-supplied id.

"In your graph" is clustering's own page set (page_repo.get_active_pages):
effective status active, COALESCE(human_status, status) = 'active'.
"""

from __future__ import annotations

from datetime import datetime

from backend.db import auth_repo, cluster_repo
from backend.db.connection import get_conn
from backend.services.cluster_view import MEMBERS_LIMIT, RUN_HISTORY_LIMIT, run_row
from backend.services.overview_summary import count_graph_superclusters

_IN_GRAPH = "COALESCE(p.human_status, p.status) = 'active'"


def _dicts(cur) -> list[dict]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_run_history(user_id: int, limit: int = RUN_HISTORY_LIMIT) -> dict:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM recluster_runs WHERE user_id = %s", (user_id,))
        total = cur.fetchone()[0]
        cur.execute(
            """
            SELECT id, status, started_at, completed_at,
                   cluster_count, noise_count, naming_cost, elapsed_seconds
            FROM recluster_runs
            WHERE user_id = %s
            ORDER BY started_at DESC NULLS LAST, id DESC
            LIMIT %s
            """,
            (user_id, limit),
        )
        items = [run_row(r, with_status=True) for r in _dicts(cur)]
    return {"total": total, "items": items}


def get_clusters(user_id: int, run_id: int) -> list[dict]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT c.id, c.cluster_name, c.cluster_slug, COUNT(pc.page_id) AS size,
                   c.mean_membership_probability, c.name_carried, c.super_cluster,
                   g.label, g.source, g.interest_tier
            FROM clusters c
            LEFT JOIN page_clusters pc ON pc.cluster_id = c.id
            LEFT JOIN super_cluster_groups g ON g.id = c.group_id AND g.user_id = c.user_id
            WHERE c.user_id = %s AND c.recluster_run = %s
            GROUP BY c.id, g.id
            ORDER BY size DESC, c.cluster_name ASC, c.id ASC
            """,
            (user_id, run_id),
        )
        rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "name": r[1],
            "slug": r[2],
            "size": int(r[3]),
            "confidence": None if r[4] is None else round(float(r[4]), 4),
            "name_carried": bool(r[5]),
            "super_cluster": r[6],
            "group": None if r[7] is None else {"label": r[7], "source": r[8], "tier": r[9]},
        }
        for r in rows
    ]


def get_page_counts(user_id: int, run_id: int, run_started_at: datetime | None) -> dict:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            WITH run_pages AS (
                SELECT DISTINCT pc.page_id
                FROM page_clusters pc
                JOIN clusters cl ON cl.id = pc.cluster_id
                WHERE cl.user_id = %(u)s AND cl.recluster_run = %(r)s
            ),
            graph AS (
                SELECT p.id, p.created_at
                FROM pages p
                JOIN captures c ON c.id = p.capture_id AND c.user_id = %(u)s
                WHERE {_IN_GRAPH}
            ),
            loose AS (
                SELECT g.id, g.created_at FROM graph g
                WHERE NOT EXISTS (SELECT 1 FROM run_pages rp WHERE rp.page_id = g.id)
            )
            SELECT
                (SELECT COUNT(*) FROM graph),
                (SELECT COUNT(*) FROM run_pages),
                (SELECT COUNT(*) FROM loose),
                (SELECT COUNT(*) FROM loose l
                   JOIN featured_singletons f
                     ON f.page_id = l.id AND f.recluster_run = %(r)s AND f.user_id = %(u)s),
                (SELECT COUNT(*) FROM loose l
                  WHERE %(s)s::timestamptz IS NOT NULL AND l.created_at > %(s)s)
            """,
            {"u": user_id, "r": run_id, "s": run_started_at},
        )
        in_graph, clustered, not_clustered, featured, since_run = cur.fetchone()
    return {
        "in_graph": in_graph,
        "clustered": clustered,
        "clustered_in_graph": in_graph - not_clustered,
        "not_clustered": not_clustered,
        "featured": featured,
        "since_run": since_run,
    }


def get_edge_weights(user_id: int, run_id: int) -> list[float]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT ce.weight
            FROM cluster_edges ce
            JOIN clusters s ON s.id = ce.source_cluster AND s.user_id = %s
            WHERE ce.recluster_run = %s AND s.recluster_run = ce.recluster_run
            """,
            (user_id, run_id),
        )
        return [float(r[0]) for r in cur.fetchall()]


def get_group_counts(user_id: int, run_id: int | None) -> dict:
    prefs = auth_repo.get_preferences(user_id)
    topics = [t["keyword"] for t in prefs.get("topic_interests", []) if t.get("keyword")]
    if run_id is None:
        return {"superclusters": 0, "topics": len(topics), "suggested": 0}
    sc_map = cluster_repo.get_super_cluster_map(user_id, run_id)
    with get_conn() as conn, conn.cursor() as cur:
        # Distinct labels: the header card's "N suggested" rule
        # (cluster_repo.get_suggested_group_count).
        cur.execute(
            """
            SELECT COUNT(DISTINCT label) FROM super_cluster_groups
            WHERE user_id = %s AND recluster_run = %s AND source = 'suggested'
            """,
            (user_id, run_id),
        )
        suggested = cur.fetchone()[0]
    return {
        "superclusters": count_graph_superclusters(sc_map, topics),
        "topics": len(topics),
        "suggested": suggested,
    }


def get_cluster_members(user_id: int, cluster_id: int, limit: int = MEMBERS_LIMIT) -> dict | None:
    """Member pages of one of the caller's clusters; None when the cluster is
    not the caller's (the route turns that into a 404)."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM clusters WHERE id = %s AND user_id = %s", (cluster_id, user_id))
        if cur.fetchone() is None:
            return None
        member_sql = """
            FROM page_clusters pc
            JOIN pages p ON p.id = pc.page_id
            JOIN captures c ON c.id = p.capture_id AND c.user_id = %s
            WHERE pc.cluster_id = %s
        """
        cur.execute("SELECT COUNT(*) " + member_sql, (user_id, cluster_id))
        total = cur.fetchone()[0]
        cur.execute(
            "SELECT p.id, p.title, p.domain, p.url "
            + member_sql
            + " ORDER BY p.title ASC NULLS LAST, p.id ASC LIMIT %s",
            (user_id, cluster_id, limit),
        )
        pages = _dicts(cur)
    return {"cluster_id": cluster_id, "total": total, "pages": pages}


def get_unclustered(
    user_id: int, run_id: int, run_started_at: datetime | None, limit: int, offset: int
) -> dict:
    base = f"""
        FROM pages p
        JOIN captures c ON c.id = p.capture_id AND c.user_id = %(u)s
        LEFT JOIN featured_singletons f
          ON f.page_id = p.id AND f.recluster_run = %(r)s AND f.user_id = %(u)s
        WHERE {_IN_GRAPH}
          AND NOT EXISTS (
              SELECT 1 FROM page_clusters pc
              JOIN clusters cl ON cl.id = pc.cluster_id
              WHERE pc.page_id = p.id AND cl.user_id = %(u)s AND cl.recluster_run = %(r)s
          )
    """
    params = {"u": user_id, "r": run_id, "s": run_started_at, "lim": limit, "off": offset}
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) " + base, params)
        total = cur.fetchone()[0]
        cur.execute(
            "SELECT p.id, p.title, p.domain, p.url, (f.page_id IS NOT NULL) AS featured, "
            "COALESCE(%(s)s::timestamptz IS NOT NULL AND p.created_at > %(s)s, FALSE) AS since_run "
            + base
            + " ORDER BY featured DESC, p.visited_at DESC NULLS LAST, p.id DESC"
            " LIMIT %(lim)s OFFSET %(off)s",
            params,
        )
        pages = _dicts(cur)
    return {"total": total, "pages": pages}
