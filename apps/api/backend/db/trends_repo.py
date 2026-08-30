"""Repository for cost_events and status_snapshots tables (Trends view)."""

import json
import logging
from datetime import datetime, timedelta, timezone

from backend.db.connection import get_conn

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Inserts
# ---------------------------------------------------------------------------


def insert_cost_event(
    user_id: int,
    event_type: str,
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cost_usd: float = 0.0,
    latency_ms: float | None = None,
    metadata: dict | None = None,
) -> None:
    """Record a single LLM cost event."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO cost_events
                    (user_id, event_type, model, input_tokens, output_tokens,
                     cost_usd, latency_ms, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    user_id,
                    event_type,
                    model,
                    input_tokens,
                    output_tokens,
                    cost_usd,
                    latency_ms,
                    json.dumps(metadata or {}),
                ),
            )


def insert_status_snapshot(
    user_id: int,
    active_count: int = 0,
    pending_count: int = 0,
    archived_count: int = 0,
    cluster_count: int = 0,
    noise_count: int = 0,
    total_cost_usd: float = 0.0,
) -> None:
    """Record a point-in-time status snapshot."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO status_snapshots
                    (user_id, active_count, pending_count, archived_count,
                     cluster_count, noise_count, total_cost_usd)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    user_id,
                    active_count,
                    pending_count,
                    archived_count,
                    cluster_count,
                    noise_count,
                    total_cost_usd,
                ),
            )


# ---------------------------------------------------------------------------
# Queries — used by Trends frontend charts
# ---------------------------------------------------------------------------


def _since_clause(since: datetime | None) -> tuple[str, tuple]:
    """Build a WHERE clause fragment for time filtering."""
    if since:
        return "AND created_at >= %s", (since,)
    return "", ()


def get_cost_events(
    user_id: int,
    since: datetime | None = None,
    event_type: str | None = None,
) -> list[dict]:
    """Fetch cost events, optionally filtered by time and type."""
    clauses = ["user_id = %s"]
    params: list = [user_id]
    if since:
        clauses.append("created_at >= %s")
        params.append(since)
    if event_type:
        clauses.append("event_type = %s")
        params.append(event_type)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT * FROM cost_events WHERE {where} ORDER BY created_at",
                tuple(params),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_daily_costs(user_id: int, since: datetime | None = None) -> list[dict]:
    """Aggregate cost_events by day and event_type for charting."""
    clauses = ["user_id = %s"]
    params: list = [user_id]
    if since:
        clauses.append("created_at >= %s")
        params.append(since)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT DATE(created_at) AS day, event_type,
                       SUM(cost_usd) AS total_cost,
                       SUM(input_tokens) AS total_input_tokens,
                       SUM(output_tokens) AS total_output_tokens,
                       COUNT(*) AS call_count
                FROM cost_events
                WHERE {where}
                GROUP BY day, event_type
                ORDER BY day
                """,
                tuple(params),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_status_snapshots(
    user_id: int,
    since: datetime | None = None,
) -> list[dict]:
    """Fetch status snapshots for charting."""
    clauses = ["user_id = %s"]
    params: list = [user_id]
    if since:
        clauses.append("snapshot_at >= %s")
        params.append(since)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT * FROM status_snapshots WHERE {where} ORDER BY snapshot_at",
                tuple(params),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


# ---------------------------------------------------------------------------
# Derived queries — data from existing tables (no new tables needed)
# ---------------------------------------------------------------------------


def get_daily_page_volume(user_id: int, since: datetime | None = None) -> list[dict]:
    """Page counts per day from pages.created_at."""
    clauses = ["user_id = %s"]
    params: list = [user_id]
    if since:
        clauses.append("created_at >= %s")
        params.append(since)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT DATE(created_at) AS day, COUNT(*) AS page_count
                FROM pages WHERE {where}
                GROUP BY day ORDER BY day
                """,
                tuple(params),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_daily_skip_outcomes(
    user_id: int,
    since: datetime | None = None,
) -> list[dict]:
    """Skip gate outcomes per day (processing_depth breakdown)."""
    clauses = ["user_id = %s"]
    params: list = [user_id]
    if since:
        clauses.append("created_at >= %s")
        params.append(since)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT DATE(created_at) AS day,
                       COALESCE(processing_depth, 'pending') AS depth,
                       COUNT(*) AS cnt
                FROM pages WHERE {where}
                GROUP BY day, depth ORDER BY day
                """,
                tuple(params),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_top_skip_reasons(
    user_id: int,
    since: datetime | None = None,
    limit: int = 10,
) -> list[dict]:
    """Top skip reasons by frequency."""
    clauses = [
        "user_id = %s",
        "processing_depth = 'skipped'",
        "skip_reasoning IS NOT NULL",
    ]
    params: list = [user_id]
    if since:
        clauses.append("created_at >= %s")
        params.append(since)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT skip_reasoning AS reason, COUNT(*) AS cnt
                FROM pages WHERE {where}
                GROUP BY reason ORDER BY cnt DESC LIMIT %s
                """,
                tuple(params) + (limit,),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_daily_skip_reasons(
    user_id: int,
    since: datetime | None = None,
    top_n: int = 5,
) -> list[dict]:
    """Daily counts of top N skip reasons over time (for stacked area)."""
    clauses = [
        "user_id = %s",
        "processing_depth = 'skipped'",
        "skip_reasoning IS NOT NULL",
    ]
    params: list = [user_id]
    if since:
        clauses.append("created_at >= %s")
        params.append(since)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            # First find the top N reasons overall
            cur.execute(
                f"""
                SELECT skip_reasoning FROM pages WHERE {where}
                GROUP BY skip_reasoning ORDER BY COUNT(*) DESC LIMIT %s
                """,
                tuple(params) + (top_n,),
            )
            top_reasons = [r[0] for r in cur.fetchall()]
            if not top_reasons:
                return []

            # Then get daily counts for those reasons
            placeholders = ",".join(["%s"] * len(top_reasons))
            cur.execute(
                f"""
                SELECT DATE(created_at) AS day, skip_reasoning AS reason,
                       COUNT(*) AS cnt
                FROM pages
                WHERE {where} AND skip_reasoning IN ({placeholders})
                GROUP BY day, reason ORDER BY day
                """,
                tuple(params) + tuple(top_reasons),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_daily_skip_rate(
    user_id: int,
    since: datetime | None = None,
) -> list[dict]:
    """Daily skip rate (skipped / total evaluated pages)."""
    clauses = [
        "user_id = %s",
        "processing_depth IS NOT NULL",
        "processing_depth != 'pending'",
    ]
    params: list = [user_id]
    if since:
        clauses.append("created_at >= %s")
        params.append(since)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT DATE(created_at) AS day,
                       COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE processing_depth = 'skipped') AS skipped
                FROM pages WHERE {where}
                GROUP BY day ORDER BY day
                """,
                tuple(params),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_daily_browsing_activity(
    user_id: int,
    since: datetime | None = None,
) -> list[dict]:
    """Capture counts per day from captures.started_at."""
    clauses = ["user_id = %s"]
    params: list = [user_id]
    if since:
        clauses.append("started_at >= %s")
        params.append(since)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT DATE(started_at) AS day, COUNT(*) AS capture_count
                FROM captures WHERE {where}
                GROUP BY day ORDER BY day
                """,
                tuple(params),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_agent_tool_mix(
    user_id: int,
    since: datetime | None = None,
) -> list[dict]:
    """Per-tool agent call counts for the L5 evidence-card mix bar.

    Unnests ``cost_events.metadata->'tools_used'`` (a JSON array stored per
    agent invocation) into individual tool names and aggregates counts.

    Rows missing ``tools_used`` are skipped. Returns [] if no matches -- the
    writer-side may not yet emit ``tools_used`` (see Task 11 spot-check);
    the evidence card handles the empty list with a graceful placeholder.
    """
    clauses = [
        "user_id = %s",
        "(event_type LIKE 'agent%%' OR metadata->>'source' = 'agent')",
        "metadata ? 'tools_used'",
    ]
    params: list = [user_id]
    if since:
        clauses.append("created_at >= %s")
        params.append(since)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT tool_name, COUNT(*) AS cnt
                FROM cost_events,
                     LATERAL jsonb_array_elements_text(metadata->'tools_used') AS tool_name
                WHERE {where}
                GROUP BY tool_name
                ORDER BY cnt DESC
                """,
                tuple(params),
            )
            rows = cur.fetchall()
    return [{"tool": tool, "count": int(cnt)} for tool, cnt in rows]


def get_agent_iteration_distribution(
    user_id: int,
    since: datetime | None = None,
) -> list[dict]:
    """Per-iteration-count frequencies for agent invocations (L9 mix bar).

    Groups cost_events by `metadata->>'iterations'` cast to int.
    Rows missing the key are skipped. Returns [] if no matches.
    """
    clauses = [
        "user_id = %s",
        "(event_type LIKE 'agent%%' OR metadata->>'source' = 'agent')",
        "metadata ? 'iterations'",
    ]
    params: list = [user_id]
    if since:
        clauses.append("created_at >= %s")
        params.append(since)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT (metadata->>'iterations')::int AS iters, COUNT(*) AS cnt
                FROM cost_events
                WHERE {where}
                GROUP BY iters
                ORDER BY iters
                """,
                tuple(params),
            )
            rows = cur.fetchall()
    return [{"iterations": int(iters), "count": int(cnt)} for iters, cnt in rows]


def get_daily_latency(
    user_id: int,
    since: datetime | None = None,
) -> list[dict]:
    """Daily average latency_ms across all LLM calls (L3 evidence card sparkline).

    Mixes skip-gate, learning-gate, agent, and clustering-naming calls --
    this is an aggregate observability signal, not per-event-type.
    Rows with NULL latency_ms are excluded.
    """
    clauses = ["user_id = %s", "latency_ms IS NOT NULL"]
    params: list = [user_id]
    if since:
        clauses.append("created_at >= %s")
        params.append(since)

    where = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT DATE(created_at)::text AS day,
                       AVG(latency_ms) AS avg_latency,
                       COUNT(*) AS cnt
                FROM cost_events
                WHERE {where}
                GROUP BY day
                ORDER BY day
                """,
                tuple(params),
            )
            rows = cur.fetchall()
    return [
        {"day": day, "avg_latency_ms": float(avg or 0.0), "call_count": int(cnt or 0)}
        for day, avg, cnt in rows
    ]


def get_clustering_evolution(user_id: int) -> list[dict]:
    """Cluster/noise counts per recluster run over time."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT completed_at, cluster_count, noise_count
                FROM recluster_runs
                WHERE user_id = %s AND status = 'completed'
                ORDER BY completed_at
                """,
                (user_id,),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


# ---------------------------------------------------------------------------
# Scalar aggregates — used by the nightly snapshot orchestrator
# ---------------------------------------------------------------------------


def get_total_cost_usd(user_id: int) -> float:
    """Cumulative LLM cost for a user across all cost_events (0.0 if none)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COALESCE(SUM(cost_usd), 0) FROM cost_events WHERE user_id = %s",
                (user_id,),
            )
            return float(cur.fetchone()[0] or 0.0)


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


def since_from_range(range_key: str) -> datetime | None:
    """Convert a range selector value ('7d', '30d', '90d', 'all') to a datetime."""
    mapping = {"7d": 7, "30d": 30, "90d": 90}
    days = mapping.get(range_key)
    if days:
        return datetime.now(timezone.utc) - timedelta(days=days)
    return None
