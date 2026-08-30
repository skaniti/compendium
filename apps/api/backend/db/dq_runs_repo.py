"""Repository for dq_runs -- per-execution telemetry for dqBot."""

import json
import logging

from backend.db.connection import get_conn

logger = logging.getLogger(__name__)


def start_run(user_id: int, trigger: str) -> dict:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO dq_runs (user_id, trigger)
            VALUES (%s, %s)
            RETURNING id, user_id, trigger, started_at, status
            """,
            (user_id, trigger),
        )
        r = cur.fetchone()
    return {
        "id": r[0],
        "user_id": r[1],
        "trigger": r[2],
        "started_at": r[3],
        "status": r[4],
    }


def complete_run(
    run_id: int,
    observations_written: int,
    recommendations_written: int,
    llm_cost_usd: float,
    gate_metrics: dict | None = None,
) -> dict:
    params = [observations_written, recommendations_written, llm_cost_usd]
    gate_metrics_set_clause = ""
    if gate_metrics is not None:
        gate_metrics_set_clause = ", gate_metrics = %s"
        params.append(json.dumps(gate_metrics))
    params.append(run_id)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE dq_runs
            SET status = 'completed',
                completed_at = NOW(),
                observations_written = %s,
                recommendations_written = %s,
                llm_cost_usd = %s
                {gate_metrics_set_clause}
            WHERE id = %s
            RETURNING id, status, observations_written,
                      recommendations_written, llm_cost_usd, completed_at, gate_metrics
            """,
            params,
        )
        r = cur.fetchone()
    return {
        "id": r[0],
        "status": r[1],
        "observations_written": r[2],
        "recommendations_written": r[3],
        "llm_cost_usd": r[4],
        "completed_at": r[5],
        "gate_metrics": r[6],
    }


_FAILURE_REASON_MAX_LEN = 2000


def fail_run(run_id: int, reason: str | None) -> None:
    """Mark a run as failed and persist `reason` (migration 040's
    failure_reason column). Truncated to _FAILURE_REASON_MAX_LEN chars so a
    runaway traceback/error string doesn't bloat the row; NULL-safe (a
    missing/empty reason is stored as NULL rather than an empty string).
    """
    logger.warning("dq_runs.fail_run(id=%s): %s", run_id, reason)
    truncated = reason[:_FAILURE_REASON_MAX_LEN] if reason else None
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE dq_runs SET status='failed', completed_at=NOW(), "
            "failure_reason=%s WHERE id=%s",
            (truncated, run_id),
        )


def get_run(run_id: int, user_id: int) -> dict | None:
    """Fetch a single run by id, scoped to user_id.

    Returns the run dict or None if not found / not owned by user.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, trigger, started_at, completed_at, status,
                   observations_written, recommendations_written, llm_cost_usd,
                   failure_reason, run_kind, gate_metrics
            FROM dq_runs
            WHERE id = %s AND user_id = %s
            """,
            (run_id, user_id),
        )
        r = cur.fetchone()
    if r is None:
        return None
    return {
        "id": r[0],
        "trigger": r[1],
        "started_at": r[2],
        "completed_at": r[3],
        "status": r[4],
        "observations_written": r[5],
        "recommendations_written": r[6],
        "llm_cost_usd": r[7],
        "failure_reason": r[8],
        "run_kind": r[9],
        "gate_metrics": r[10],
    }


def reap_stale_runs(stale_after_minutes: int = 120, stale_queued_after_hours: int = 24) -> int:
    """Fail DQ runs stuck past their expected lifetime. Returns the combined
    count across both paths. Prevents a crashed run (or a dead worker) from
    blocking future runs via has_active_run_for_user.

    Two independent rules, each writing a self-describing failure_reason so
    the History tab and API surface *why* the row was reaped:
      - 'running' rows past stale_after_minutes with no heartbeat (a crashed
        or hung investigation -- the original rule).
      - 'queued' rows past stale_queued_after_hours (nothing ever claimed
        them -- the worker process was down or wedged; a claimed row moves
        to 'running' and is covered by the first rule instead).
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE dq_runs SET status='failed', completed_at=now(), "
            "failure_reason=%s "
            "WHERE status='running' AND started_at < now() - make_interval(mins => %s)",
            (f"reaped: running >{stale_after_minutes}min with no heartbeat", stale_after_minutes),
        )
        running_reaped = cur.rowcount

        cur.execute(
            "UPDATE dq_runs SET status='failed', completed_at=now(), "
            "failure_reason=%s "
            "WHERE status='queued' AND started_at < now() - make_interval(hours => %s)",
            (f"reaped: queued >{stale_queued_after_hours}h — worker down?", stale_queued_after_hours),
        )
        queued_reaped = cur.rowcount

    return running_reaped + queued_reaped


def list_runs_for_user(user_id: int, limit: int = 20) -> list[dict]:
    """Return recent runs for the runs-history pane (Task 7.3).

    Shape per row: id, trigger, started_at, completed_at, status, findings_count,
    failure_reason. findings_count is computed via a single LEFT JOIN against
    an aggregated dq_observations subquery to avoid N+1 per-row counting.
    Zero-finding completed runs return findings_count == 0 (intentional: they
    are heartbeats, not failures, and the frontend styles them distinctly).
    Ordered most-recent-first by started_at; capped by `limit`.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                r.id,
                r.trigger,
                r.started_at,
                r.completed_at,
                r.status,
                COALESCE(o.cnt, 0) AS findings_count,
                r.failure_reason,
                r.run_kind,
                r.gate_metrics
            FROM dq_runs r
            LEFT JOIN (
                SELECT run_id, COUNT(*) AS cnt
                FROM dq_observations
                GROUP BY run_id
            ) o ON o.run_id = r.id
            WHERE r.user_id = %s
            ORDER BY r.started_at DESC
            LIMIT %s
            """,
            (user_id, limit),
        )
        return [
            {
                "id": r[0],
                "trigger": r[1],
                "started_at": r[2],
                "completed_at": r[3],
                "status": r[4],
                "findings_count": r[5],
                "failure_reason": r[6],
                "run_kind": r[7],
                "gate_metrics": r[8],
            }
            for r in cur.fetchall()
        ]


def enqueue(user_id: int, trigger: str, run_kind: str = "full") -> dict:
    """Insert a 'queued' run for the worker to claim. Gating is the caller's job."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO dq_runs (user_id, trigger, status, run_kind)
            VALUES (%s, %s, 'queued', %s)
            RETURNING id, user_id, trigger, status, run_kind
            """,
            (user_id, trigger, run_kind),
        )
        r = cur.fetchone()
    return {"id": r[0], "user_id": r[1], "trigger": r[2], "status": r[3], "run_kind": r[4]}


def claim_next_queued_run() -> dict | None:
    """Atomically promote the oldest 'queued' run whose user has no 'running' row.

    FOR UPDATE ... SKIP LOCKED makes the claim safe under more than one worker.
    Resets started_at to claim time so the stale-run reaper measures from when
    the run actually started, not when it was enqueued. Returns the claimed run
    or None when nothing is claimable.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE dq_runs
            SET status = 'running', started_at = now()
            WHERE id = (
                SELECT q.id
                FROM dq_runs q
                WHERE q.status = 'queued'
                  AND NOT EXISTS (
                      SELECT 1 FROM dq_runs r
                      WHERE r.user_id = q.user_id AND r.status = 'running'
                  )
                ORDER BY q.id
                FOR UPDATE OF q SKIP LOCKED
                LIMIT 1
            )
            RETURNING id, user_id, trigger, started_at, status, run_kind
            """
        )
        r = cur.fetchone()
    if r is None:
        return None
    return {
        "id": r[0],
        "user_id": r[1],
        "trigger": r[2],
        "started_at": r[3],
        "status": r[4],
        "run_kind": r[5],
    }


def has_active_run_for_user(user_id: int) -> bool:
    """True if the user has a 'queued' OR 'running' run. Used by the enqueue
    gates (weekly + recluster) to avoid piling duplicate scheduled work."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM dq_runs WHERE user_id = %s AND status IN ('queued','running') LIMIT 1",
            (user_id,),
        )
        return cur.fetchone() is not None


def request_abort(run_id: int) -> None:
    """Flag a run for abort. The worker checks this mid-stream and kills its
    claude subprocess; the API process can no longer SIGTERM it directly."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE dq_runs SET abort_requested = TRUE WHERE id = %s", (run_id,))


def is_abort_requested(run_id: int) -> bool:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT abort_requested FROM dq_runs WHERE id = %s", (run_id,))
        row = cur.fetchone()
        return bool(row and row[0])


def set_gate_metrics(run_id: int, metrics: dict) -> None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE dq_runs SET gate_metrics = %s WHERE id = %s",
            (json.dumps(metrics), run_id),
        )


def recent_sensor_metrics(user_id: int, limit: int = 7) -> list[dict]:
    """Newest-first gate_metrics of the user's completed sensor runs (dqBot
    Tier 2: sensor-pass telemetry feeding the signal-gate decision)."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT gate_metrics FROM dq_runs
            WHERE user_id = %s AND run_kind = 'sensor'
              AND status = 'completed' AND gate_metrics IS NOT NULL
            ORDER BY id DESC LIMIT %s
            """,
            (user_id, limit),
        )
        return [r[0] for r in cur.fetchall()]


def last_full_run_completed_at(user_id: int):
    """Timestamp of the user's most recently completed full run, or None.
    Ignores sensor runs -- used by later tasks to decide staleness of the
    last filing pass."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT max(completed_at) FROM dq_runs
            WHERE user_id = %s AND run_kind = 'full' AND status = 'completed'
            """,
            (user_id,),
        )
        return cur.fetchone()[0]
