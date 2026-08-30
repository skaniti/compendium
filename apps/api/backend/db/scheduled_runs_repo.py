"""Repository for the ``scheduled_runs`` table.

Used by :mod:`backend.services.scheduler` to record the start/finish of
each nightly maintenance job. Mirrors the shape of
:mod:`backend.db.recluster_repo` on purpose — same start / complete /
fail lifecycle with an added ``skipped`` status for no-op runs.
"""

import json

from backend.db.connection import get_conn


def start_run(job_name: str, scope_user_id: int | None = None) -> int:
    """Create a new scheduled run in ``running`` state. Returns the row id."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO scheduled_runs (job_name, scope_user_id, status)
                VALUES (%s, %s, 'running')
                RETURNING id
                """,
                (job_name, scope_user_id),
            )
            return cur.fetchone()[0]


def complete_run(
    run_id: int,
    *,
    cost_usd: float = 0.0,
    elapsed_seconds: float,
    notes: dict | None = None,
) -> None:
    """Mark a scheduled run as completed with cost + notes."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE scheduled_runs SET
                    status          = 'completed',
                    finished_at     = NOW(),
                    cost_usd        = %s,
                    elapsed_seconds = %s,
                    notes           = %s
                WHERE id = %s
                """,
                (cost_usd, elapsed_seconds, json.dumps(notes or {}), run_id),
            )


def fail_run(run_id: int, error: str, elapsed_seconds: float) -> None:
    """Mark a scheduled run as failed. The error is captured in ``notes.error``."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE scheduled_runs SET
                    status          = 'failed',
                    finished_at     = NOW(),
                    elapsed_seconds = %s,
                    notes           = %s
                WHERE id = %s
                """,
                (elapsed_seconds, json.dumps({"error": error[:4000]}), run_id),
            )


def skip_run(run_id: int, reason: str) -> None:
    """Mark a scheduled run as skipped (no-op — nothing to do this cycle)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE scheduled_runs SET
                    status      = 'skipped',
                    finished_at = NOW(),
                    notes       = %s
                WHERE id = %s
                """,
                (json.dumps({"reason": reason[:400]}), run_id),
            )


def get_last_run(job_name: str) -> dict | None:
    """Return the most recent run row for ``job_name``, or None."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, job_name, scope_user_id, status,
                       started_at, finished_at, cost_usd,
                       elapsed_seconds, notes
                  FROM scheduled_runs
                 WHERE job_name = %s
              ORDER BY started_at DESC
                 LIMIT 1
                """,
                (job_name,),
            )
            row = cur.fetchone()
            if not row:
                return None
            cols = [d[0] for d in cur.description]
            return dict(zip(cols, row))
