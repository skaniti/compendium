"""Shared period machinery for the period-scoped dev views (Pipeline, Overview).

``range_key`` is ``7d``/``30d``/``90d`` (bounded below by ``now - N days``) or
``all`` (no lower bound). ``now`` is always passed to SQL as a bound parameter,
never ``now()``. ``tz`` is always a bound parameter (``AT TIME ZONE %s``);
callers validate it first with ``validate_tz``. Moved out of pipeline_repo when
the Overview view arrived; behaviour unchanged.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

RANGE_DAYS = {"7d": 7, "30d": 30, "90d": 90}

# range -> (granularity, label_key, SQL step). Constants only; never user input.
GRANULARITY = {
    "7d": ("6h", "block", "interval '6 hours'"),
    "30d": ("day", "day", "interval '1 day'"),
    "90d": ("week", "week", "interval '1 week'"),
    "all": ("month", "month", "interval '1 month'"),
}
BUCKET_SQL = {
    "6h": ("(date_trunc('day', {x}) + floor(extract(hour from {x}) / 6) * interval '6 hours')"),
    "day": "date_trunc('day', {x})",
    "week": "date_trunc('week', {x})",
    "month": "date_trunc('month', {x})",
}


def normalize_range(range_key: str | None) -> str:
    return range_key if range_key in RANGE_DAYS else "all"


def validate_tz(tz: str) -> ZoneInfo:
    """Return the ZoneInfo for ``tz`` or raise ValueError."""
    try:
        return ZoneInfo(tz)
    except Exception as exc:
        raise ValueError(f"invalid time zone: {tz!r}") from exc


def since_for(range_key: str, now: datetime) -> datetime | None:
    days = RANGE_DAYS.get(range_key)
    return now - timedelta(days=days) if days else None


def window(
    since: datetime | None,
    now: datetime,
    col: str = "p.visited_at",
    include_null: bool = True,
) -> tuple[str, list]:
    """Window clause on ``col`` (a module constant, never user input), capped at ``<= now``.

    With no lower bound (``all``) and ``include_null``, NULL values also count:
    Pipeline's All time counts pages whose ``visited_at`` is NULL.
    """
    if since is None:
        if include_null:
            return f" AND ({col} IS NULL OR {col} <= %s)", [now]
        return f" AND {col} <= %s", [now]
    return f" AND {col} >= %s AND {col} <= %s", [since, now]


def bucket_starts(cur, first: datetime, now: datetime, range_key: str, tz: str) -> list[datetime]:
    """Naive local wall-clock bucket starts from ``first``'s bucket through ``now``'s.

    Generated over local wall-clock time, so empty buckets appear and DST
    changes neither duplicate nor drop a block.
    """
    granularity, _label_key, step = GRANULARITY[range_key]
    bucket = BUCKET_SQL[granularity]
    cur.execute(
        f"""
        SELECT generate_series(
            (SELECT {bucket.format(x="lx")}
             FROM (SELECT %s::timestamptz AT TIME ZONE %s AS lx) f),
            (SELECT {bucket.format(x="lx")}
             FROM (SELECT %s::timestamptz AT TIME ZONE %s AS lx) n),
            {step}) AS b
        """,
        (first, tz, now, tz),
    )
    return [r[0] for r in cur.fetchall()]
