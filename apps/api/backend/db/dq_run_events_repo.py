"""Repository for dq_run_events -- per-event streaming log for dqBot runs.

Populated by the orchestrator's on_event callback as claude -p streams JSONL
events (system:init, assistant turns, tool_use, tool_result, result).
Consumed by GET /api/dq/runs/:id/events for the frontend event-log panel.
"""

import json
import logging

from backend.db.connection import get_conn

logger = logging.getLogger(__name__)


def append_event(
    user_id: int,
    run_id: int,
    seq: int,
    event_type: str,
    payload: dict,
) -> dict:
    """INSERT a single event row and return id, seq, event_type, created_at."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO dq_run_events (user_id, run_id, seq, event_type, payload)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id, seq, event_type, created_at
            """,
            (user_id, run_id, seq, event_type, json.dumps(payload)),
        )
        r = cur.fetchone()
    return {
        "id": r[0],
        "seq": r[1],
        "event_type": r[2],
        "created_at": r[3],
    }


def list_events_since(
    user_id: int,
    run_id: int,
    after_seq: int = -1,
    limit: int = 500,
) -> list[dict]:
    """SELECT events WHERE run_id = %s AND seq > after_seq ORDER BY seq ASC LIMIT %s."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, run_id, seq, event_type, payload, created_at
            FROM dq_run_events
            WHERE user_id = %s AND run_id = %s AND seq > %s
            ORDER BY seq ASC
            LIMIT %s
            """,
            (user_id, run_id, after_seq, limit),
        )
        return [
            {
                "id": r[0],
                "run_id": r[1],
                "seq": r[2],
                "event_type": r[3],
                "payload": r[4],
                "created_at": r[5],
            }
            for r in cur.fetchall()
        ]


def max_seq_for_run(run_id: int) -> int:
    """SELECT COALESCE(MAX(seq), -1) for the given run_id."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT COALESCE(MAX(seq), -1) FROM dq_run_events WHERE run_id = %s",
            (run_id,),
        )
        r = cur.fetchone()
    return r[0]


# Fields lifted from a '_phase' event payload into the summary, beyond the
# always-present 'subtype'. Optional -- only copied when present so subtypes
# that don't carry them (e.g. run_claimed) don't get spurious null keys.
_PHASE_OPTIONAL_FIELDS = ("name", "candidates")


def summarize_for_run(run_id: int, phase_limit: int = 50) -> dict:
    """Aggregate a run's events for the History tab's rich detail view.

    Three queries rather than one mega-query: bounds (count + min/max
    created_at) need no filter, phases need their own event_type filter +
    LIMIT, and result needs "newest matching row only" -- combining would
    need a window function per row for no real benefit at this table size.

    Returns:
        {count, first_at, last_at, phases, result} where:
        - first_at/last_at: ISO strings, or None when count == 0.
        - phases: chronological list of {subtype, name?, candidates?, at}
          built from event_type='_phase' rows, capped at phase_limit.
        - result: {duration_s?, total_cost_usd?, num_turns?} pulled from the
          payload of the newest event_type='result' row, or None if no such
          row exists. Individual keys are omitted (not null) when the
          underlying payload field is missing -- defensive against stream
          format drift rather than asserting a fixed CC result shape.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*), MIN(created_at), MAX(created_at) "
            "FROM dq_run_events WHERE run_id = %s",
            (run_id,),
        )
        count, first_at, last_at = cur.fetchone()

        cur.execute(
            """
            SELECT payload, created_at
            FROM dq_run_events
            WHERE run_id = %s AND event_type = '_phase'
            ORDER BY seq ASC
            LIMIT %s
            """,
            (run_id, phase_limit),
        )
        phase_rows = cur.fetchall()

        cur.execute(
            """
            SELECT payload
            FROM dq_run_events
            WHERE run_id = %s AND event_type = 'result'
            ORDER BY seq DESC
            LIMIT 1
            """,
            (run_id,),
        )
        result_row = cur.fetchone()

    phases: list[dict] = []
    for payload, created_at in phase_rows:
        entry: dict = {"at": created_at.isoformat() if created_at else None}
        if isinstance(payload, dict):
            entry["subtype"] = payload.get("subtype")
            for key in _PHASE_OPTIONAL_FIELDS:
                if key in payload:
                    entry[key] = payload[key]
        phases.append(entry)

    result: dict | None = None
    if result_row is not None and isinstance(result_row[0], dict):
        payload = result_row[0]
        result = {}
        if "total_cost_usd" in payload:
            result["total_cost_usd"] = payload["total_cost_usd"]
        if "num_turns" in payload:
            result["num_turns"] = payload["num_turns"]
        if "duration_ms" in payload and payload["duration_ms"] is not None:
            result["duration_s"] = payload["duration_ms"] / 1000.0

    return {
        "count": count,
        "first_at": first_at.isoformat() if first_at else None,
        "last_at": last_at.isoformat() if last_at else None,
        "phases": phases,
        "result": result,
    }
