"""Repository for the app_logs persistent log store.

Backs the history half of the Live Log Stream — the in-memory ring
buffer in ``backend/api/log_buffer.py`` handles live tail, and this
module handles "what happened earlier" queries.

Design
------
- ``insert_batch`` uses ``execute_values`` for one round-trip per batch.
  Logs come in bursts (a capture emits ~50 records in a few seconds);
  one INSERT per record would amplify connection-pool pressure during
  pipeline runs without buying anything.
- ``query`` mirrors the ring buffer's filter surface (level, component,
  capture_id, search) so the endpoint can dispatch to either backing
  store transparently.
- ``prune_older_than`` is the TTL hook called nightly from main.py.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from psycopg2.extras import execute_values

from backend.db.connection import get_conn

# The max rows a single ``query`` call can return. Higher than this and
# the Dash page should paginate; we don't expect that to happen for the
# default 24h windows but the cap is defensive.
QUERY_HARD_LIMIT = 5000


def insert_batch(records: list[dict[str, Any]]) -> int:
    """Insert a batch of log records. Returns the number actually written.

    Records are dicts shaped like the ring buffer's ``snapshot()`` output
    (see ``log_buffer._record_to_dict``). Unknown keys land in ``extras``.
    """
    if not records:
        return 0

    rows = []
    for r in records:
        # Pull out the structured fields; everything else goes to extras
        ts_val = r.get("ts")
        ts_dt = (
            datetime.fromtimestamp(ts_val, tz=timezone.utc)
            if isinstance(ts_val, (int, float))
            else (ts_val or datetime.now(tz=timezone.utc))
        )
        extras = {
            k: v
            for k, v in r.items()
            if k
            not in (
                "id",
                "ts",
                "level",
                "logger",
                "component",
                "message",
                "capture_id",
                "exc_text",
            )
        }
        rows.append(
            (
                ts_dt,
                r.get("level", "INFO"),
                r.get("logger", ""),
                r.get("component"),
                r.get("message", ""),
                r.get("capture_id"),
                r.get("exc_text"),
                json.dumps(extras) if extras else None,
            )
        )

    with get_conn() as conn:
        with conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO app_logs
                    (ts, level, logger, component, message, capture_id, exc_text, extras)
                VALUES %s
                """,
                rows,
            )
    return len(rows)


def query(
    *,
    since_ts: datetime | None = None,
    until_ts: datetime | None = None,
    level: str | None = None,
    component: str | None = None,
    capture_id: str | None = None,
    search: str | None = None,
    limit: int = 1000,
) -> list[dict[str, Any]]:
    """Query historical logs with filter facets.

    Returns records in oldest-first order so the frontend can append them
    to its render list without re-sorting. Bounded by ``QUERY_HARD_LIMIT``
    regardless of the requested ``limit``.
    """
    limit = max(1, min(limit, QUERY_HARD_LIMIT))

    where: list[str] = []
    params: list[Any] = []

    if since_ts:
        where.append("ts >= %s")
        params.append(since_ts)
    if until_ts:
        where.append("ts <= %s")
        params.append(until_ts)
    if level:
        order = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}
        threshold = order.get(level.upper(), 20)
        wanted = [name for name, val in order.items() if val >= threshold]
        where.append("level = ANY(%s)")
        params.append(wanted)
    if component:
        where.append("component = %s")
        params.append(component)
    if capture_id:
        where.append("capture_id = %s")
        params.append(capture_id)
    if search:
        where.append("(message ILIKE %s OR logger ILIKE %s)")
        like = f"%{search}%"
        params.extend([like, like])

    sql = "SELECT id, ts, level, logger, component, message, capture_id, exc_text, extras FROM app_logs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    # Newest first to enforce LIMIT, then we'll reverse for client convenience
    sql += " ORDER BY ts DESC LIMIT %s"
    params.append(limit)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()

    out: list[dict[str, Any]] = []
    for row in reversed(rows):  # flip to oldest-first
        rid, ts, level_, logger_, component_, message, cap_id, exc_text, extras = row
        record: dict[str, Any] = {
            "id": rid,
            "ts": ts.timestamp() if ts else None,
            "level": level_,
            "logger": logger_,
            "component": component_,
            "message": message,
            "capture_id": cap_id,
        }
        if exc_text:
            record["exc_text"] = exc_text
        if extras:
            extras_dict = extras if isinstance(extras, dict) else json.loads(extras)
            for k, v in extras_dict.items():
                record.setdefault(k, v)
        out.append(record)
    return out


def prune_older_than(days: int) -> int:
    """Delete rows older than ``days`` days. Returns rows deleted."""
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM app_logs WHERE ts < %s", (cutoff,))
            return cur.rowcount or 0


def distinct_components(since_ts: datetime | None = None) -> list[str]:
    """Return the set of components seen since ``since_ts`` (or all-time)."""
    sql = "SELECT DISTINCT component FROM app_logs WHERE component IS NOT NULL"
    params: list[Any] = []
    if since_ts:
        sql += " AND ts >= %s"
        params.append(since_ts)
    sql += " ORDER BY component"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return [row[0] for row in cur.fetchall()]
