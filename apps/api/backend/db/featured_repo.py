"""Repository for the featured_singletons table.

featured_singletons captures the top-N HDBSCAN-noise pages per recluster run
that get surfaced in the compendium graph as starfield outliers (rendered
with page-title labels and lighter LOD; not LLM-named like real clusters).

See migration ``backend/db/migrations/023_featured_singletons.sql`` for the
schema rationale and the data-model split between clusters (groupings) and
featured_singletons (representative outliers).
"""

from backend.db.connection import get_conn


def insert_featured_singletons(rows: list[dict]) -> int:
    """Bulk-insert featured singleton rows for a recluster run.

    Each row has keys: ``user_id``, ``page_id``, ``recluster_run``,
    ``outlier_score``. Conflicts on (recluster_run, page_id) are silently
    skipped -- the table's UNIQUE constraint guards against duplicate
    promotion of a page within a single run, which would otherwise be a
    bug in the picker.

    Returns the number of rows inserted.
    """
    if not rows:
        return 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            n = 0
            for r in rows:
                cur.execute(
                    """
                    INSERT INTO featured_singletons
                        (user_id, page_id, recluster_run, outlier_score)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (recluster_run, page_id) DO NOTHING
                    """,
                    (
                        r["user_id"],
                        r["page_id"],
                        r["recluster_run"],
                        r.get("outlier_score"),
                    ),
                )
                n += cur.rowcount if cur.rowcount > 0 else 0
            return n


def list_featured_singletons_for_run(
    user_id: int,
    recluster_run_id: int | None = None,
) -> list[dict]:
    """Featured singletons for the given run (latest completed run if None).

    Joins to ``pages`` to surface the rendering metadata the graph layer
    needs without a second query: ``page_id``, ``page_title``, ``page_url``,
    ``page_domain``, ``outlier_score``. The page-level fields are what the
    graph node uses to label the singleton (page title rather than an
    LLM-synthesized cluster name -- see Round 8 design discussion).
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
                    return []
                recluster_run_id = row[0]

            cur.execute(
                """
                SELECT
                    fs.page_id,
                    p.title,
                    p.url,
                    p.domain,
                    fs.outlier_score
                FROM featured_singletons fs
                JOIN pages p ON p.id = fs.page_id
                WHERE fs.user_id = %s AND fs.recluster_run = %s
                ORDER BY fs.outlier_score DESC NULLS LAST
                """,
                (user_id, recluster_run_id),
            )
            return [
                {
                    "page_id": r[0],
                    "page_title": r[1],
                    "page_url": r[2],
                    "page_domain": r[3],
                    "outlier_score": r[4],
                }
                for r in cur.fetchall()
            ]


def count_featured_singletons_for_run(
    user_id: int,
    recluster_run_id: int,
) -> int:
    """Lightweight count of featured singletons in a run -- used for graph payloads
    that include cluster-and-singleton counts without fetching full member lists."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM featured_singletons
                WHERE user_id = %s AND recluster_run = %s
                """,
                (user_id, recluster_run_id),
            )
            return int(cur.fetchone()[0])
