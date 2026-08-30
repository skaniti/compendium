"""Repository for the recluster_runs table."""

from backend.db.connection import get_conn


def start_run(user_id: int) -> int:
    """Create a new recluster run in 'running' state. Returns the run ID."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO recluster_runs (user_id, status)
                VALUES (%s, 'running')
                RETURNING id
                """,
                (user_id,),
            )
            return cur.fetchone()[0]


def complete_run(
    run_id: int,
    *,
    cluster_count: int,
    noise_count: int,
    naming_cost: float,
    elapsed_seconds: float,
) -> None:
    """Mark a recluster run as completed with stats."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE recluster_runs SET
                    status = 'completed',
                    completed_at = NOW(),
                    cluster_count = %s,
                    noise_count = %s,
                    naming_cost = %s,
                    elapsed_seconds = %s
                WHERE id = %s
                """,
                (cluster_count, noise_count, naming_cost, elapsed_seconds, run_id),
            )


def fail_run(run_id: int) -> None:
    """Mark a recluster run as failed."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE recluster_runs SET
                    status = 'failed',
                    completed_at = NOW()
                WHERE id = %s
                """,
                (run_id,),
            )


def get_latest_run(user_id: int) -> dict | None:
    """Get the most recent completed recluster run for a user."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, status, started_at, completed_at,
                       cluster_count, noise_count, naming_cost, elapsed_seconds
                FROM recluster_runs
                WHERE user_id = %s AND status = 'completed'
                ORDER BY completed_at DESC
                LIMIT 1
                """,
                (user_id,),
            )
            row = cur.fetchone()

    if row is None:
        return None

    return {
        "id": row[0],
        "status": row[1],
        "started_at": row[2],
        "completed_at": row[3],
        "cluster_count": row[4],
        "noise_count": row[5],
        "naming_cost": row[6],
        "elapsed_seconds": row[7],
    }


def get_all_runs(user_id: int) -> list[dict]:
    """Return all recluster runs for a user, most recent first."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, status, started_at, completed_at,
                       cluster_count, noise_count, naming_cost, elapsed_seconds
                FROM recluster_runs
                WHERE user_id = %s
                ORDER BY started_at DESC
                """,
                (user_id,),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


STALE_RUN_MINUTES = 120


def start_run_if_idle(user_id: int, stale_after_minutes: int = STALE_RUN_MINUTES) -> int | None:
    """Create a 'running' recluster run unless a recent 'running' run already
    exists for this user. Returns the new run id, or None when a recent run is
    in flight (caller should skip). 'running' rows older than
    ``stale_after_minutes`` are treated as crashed and do not block -- they get
    cleaned up by :func:`reap_stale_runs`.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO recluster_runs (user_id, status)
                SELECT %s, 'running'
                WHERE NOT EXISTS (
                    SELECT 1 FROM recluster_runs
                    WHERE user_id = %s
                      AND status = 'running'
                      AND started_at > now() - make_interval(mins => %s)
                )
                RETURNING id
                """,
                (user_id, user_id, stale_after_minutes),
            )
            row = cur.fetchone()
            return row[0] if row else None


def reap_stale_runs(stale_after_minutes: int = STALE_RUN_MINUTES) -> int:
    """Mark recluster runs stuck in 'running' beyond the cutoff as 'failed'.
    Returns the number reaped. Prevents a crashed run from blocking reclusters.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE recluster_runs SET status = 'failed', completed_at = now()
                WHERE status = 'running'
                  AND started_at < now() - make_interval(mins => %s)
                """,
                (stale_after_minutes,),
            )
            return cur.rowcount


def cleanup_old_runs(user_id: int, keep_latest: int = 3) -> int:
    """Archive old completed runs beyond the N most recent.

    Prior to 2026-04-06 this function used DELETE with CASCADE, which
    destroyed historical cluster results (clusters, page_clusters,
    cluster_edges). Changed to archive semantics so old runs and their
    associated data survive for potential rollback or comparison.

    Returns number of archived runs.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE recluster_runs SET status = 'archived'
                WHERE id IN (
                    SELECT id FROM recluster_runs
                    WHERE user_id = %s AND status = 'completed'
                    ORDER BY completed_at DESC
                    OFFSET %s
                )
                """,
                (user_id, keep_latest),
            )
            return cur.rowcount
