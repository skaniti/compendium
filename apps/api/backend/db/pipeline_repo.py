"""Period-scoped queries for the Pipeline dev view.

Every query joins ``captures`` and filters on ``c.user_id``. The period
window is on ``pages.visited_at``: ``7d``/``30d``/``90d`` bound it below by
``now - N days``; ``all`` has no lower bound (and is the only range that
counts pages whose ``visited_at`` is NULL). ``now`` is an injectable keyword
argument and is passed to SQL as a bound parameter, never ``now()``. ``tz`` is
always a bound parameter (``AT TIME ZONE %s``); callers validate it first with
``validate_tz``.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from backend.db import page_repo
from backend.db.connection import get_conn

RANGE_DAYS = {"7d": 7, "30d": 30, "90d": 90}
TOP_DOMAINS = 3

# range -> (granularity, label_key, SQL step). Constants only; never user input.
_GRANULARITY = {
    "7d": ("6h", "block", "interval '6 hours'"),
    "30d": ("day", "day", "interval '1 day'"),
    "90d": ("week", "week", "interval '1 week'"),
    "all": ("month", "month", "interval '1 month'"),
}
_BUCKET_SQL = {
    "6h": ("(date_trunc('day', {x}) + floor(extract(hour from {x}) / 6) * interval '6 hours')"),
    "day": "date_trunc('day', {x})",
    "week": "date_trunc('week', {x})",
    "month": "date_trunc('month', {x})",
}

# Flow classification (spec §13.2) — the ONLY definition; summary, timeline and pages all use it.
_EFFECTIVE_STATUS = "COALESCE(p.human_status, p.status)"
_URL_PATTERN = "p.content_summary LIKE 'URL pattern skipped%%'"
OUTCOME_SQL = f"""(CASE
  WHEN p.status = 'pending' THEN 'pending'
  WHEN p.processing_depth = 'skipped' AND (p.archive_reason = 'domain_skip' OR {_URL_PATTERN}) THEN 'rule_filter'
  WHEN p.processing_depth = 'skipped' THEN 'gate'
  WHEN p.processing_depth IN ('processed', 'surface', 'full')
       OR (p.processing_depth IS NULL AND p.status = 'active') THEN 'processed'
  ELSE 'before_gate' END)"""
_ARCHIVE_KIND = """(CASE
  WHEN p.archive_reason IN ('dedup', 'dedupe_fold') THEN 'duplicate'
  WHEN p.archive_reason = 'app_chrome_junk' THEN 'chrome'
  WHEN p.human_status = 'archived' THEN 'manual'
  ELSE 'other' END)"""
DETAIL_SQL = f"""(CASE {OUTCOME_SQL}
  WHEN 'pending' THEN 'waiting'
  WHEN 'rule_filter' THEN CASE WHEN {_URL_PATTERN} THEN 'url_pattern' ELSE 'domain' END
  WHEN 'gate' THEN COALESCE(p.skip_category, 'uncategorized')
  WHEN 'processed' THEN CASE WHEN {_EFFECTIVE_STATUS} = 'active' THEN 'active' ELSE 'later_' || {_ARCHIVE_KIND} END
  ELSE CASE WHEN p.archive_reason = 'placeholder_no_content' THEN 'placeholder' ELSE {_ARCHIVE_KIND} END
END)"""
FATE_SQL = _EFFECTIVE_STATUS
_OUTCOMES = ("before_gate", "rule_filter", "gate", "processed", "pending")


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


def _window(since: datetime | None, now: datetime) -> tuple[str, list]:
    """Window clause, capped at ``visited_at <= now`` so every section agrees.

    ``all`` still counts pages whose ``visited_at`` is NULL.
    """
    if since is None:
        return " AND (p.visited_at IS NULL OR p.visited_at <= %s)", [now]
    return " AND p.visited_at >= %s AND p.visited_at <= %s", [since, now]


def get_windowed_pages(
    user_id: int,
    range_key: str = "all",
    limit: int = 50,
    offset: int = 0,
    sort: str = "created_at",
    direction: str = "desc",
    *,
    now: datetime | None = None,
) -> tuple[list[dict], int]:
    """Window-scoped twin of ``page_repo.get_recent_pages`` (same allow-lists)."""
    if sort not in page_repo.RECENT_PAGES_SORT_COLUMNS:
        raise ValueError(f"unsupported sort column: {sort!r}")
    if direction not in ("asc", "desc"):
        raise ValueError(f"unsupported direction: {direction!r}")
    now = now or datetime.now(UTC)
    wsql, wparams = _window(since_for(normalize_range(range_key), now), now)
    order_sql = f"ORDER BY p.{sort} {direction.upper()} NULLS LAST, p.id DESC"  # allow-listed
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM pages p JOIN captures c ON p.capture_id = c.id "
            f"WHERE c.user_id = %s{wsql}",
            [user_id, *wparams],
        )
        total = cur.fetchone()[0]
        cur.execute(
            f"""
            SELECT p.id, p.title, p.domain, p.status, p.processing_depth,
                   p.archive_reason, p.skip_reasoning, p.skip_category,
                   p.visited_at, p.created_at,
                   {OUTCOME_SQL} AS outcome, {DETAIL_SQL} AS detail, {FATE_SQL} AS fate
            FROM pages p JOIN captures c ON p.capture_id = c.id
            WHERE c.user_id = %s{wsql}
            {order_sql}
            LIMIT %s OFFSET %s
            """,
            [user_id, *wparams, limit, offset],
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()], total


def _grouped_with_top_domains(
    cur, user_id: int, key_expr: str, extra_where: str, wsql: str, wparams: list
) -> list[dict]:
    """Groups by ``key_expr`` with the top ``TOP_DOMAINS`` domains each (one query)."""
    cur.execute(
        f"""
        WITH g AS (
            SELECT {key_expr} AS key, COALESCE(p.domain, '(unknown)') AS domain, COUNT(*) AS n
            FROM pages p JOIN captures c ON p.capture_id = c.id
            WHERE c.user_id = %s{wsql} AND {extra_where}
            GROUP BY 1, 2
        ), ranked AS (
            SELECT key, domain, n,
                   SUM(n) OVER (PARTITION BY key) AS total,
                   ROW_NUMBER() OVER (PARTITION BY key ORDER BY n DESC, domain) AS rn
            FROM g
        )
        SELECT key, domain, n, total FROM ranked
        WHERE rn <= %s
        ORDER BY total DESC, key, rn
        """,  # key_expr / extra_where are module constants
        [user_id, *wparams, TOP_DOMAINS],
    )
    groups: dict[str, dict] = {}
    for key, domain, n, total in cur.fetchall():
        grp = groups.setdefault(key, {"key": key, "count": int(total), "top_domains": []})
        grp["top_domains"].append({"domain": domain, "count": int(n)})
    return list(groups.values())


def get_flow_counts(user_id: int, range_key: str = "all", *, now: datetime | None = None) -> dict:
    """Windowed (outcome, detail, fate) cell counts plus top domains per outcome / detail."""
    now = now or datetime.now(UTC)
    wsql, wparams = _window(since_for(normalize_range(range_key), now), now)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {OUTCOME_SQL}, {DETAIL_SQL}, {FATE_SQL}, COUNT(*)
            FROM pages p JOIN captures c ON p.capture_id = c.id
            WHERE c.user_id = %s{wsql}
            GROUP BY 1, 2, 3
            """,  # classification SQL is a module constant
            [user_id, *wparams],
        )
        cells = [(o, d, f, int(n)) for o, d, f, n in cur.fetchall()]
        outcome_domains = _grouped_with_top_domains(
            cur, user_id, OUTCOME_SQL, "TRUE", wsql, wparams
        )
        detail_domains = _grouped_with_top_domains(
            cur, user_id, f"{OUTCOME_SQL} || ':' || {DETAIL_SQL}", "TRUE", wsql, wparams
        )
    return {"cells": cells, "outcome_domains": outcome_domains, "detail_domains": detail_domains}


def get_timeline(user_id: int, range_key: str, tz: str, *, now: datetime | None = None) -> dict:
    """Bucketed total / archived / per-outcome counts in the caller's local time.

    Buckets are generated over local wall-clock starts (so empty buckets appear
    and DST changes neither duplicate nor drop a block); each ``start`` is
    returned as an ISO timestamp carrying the local UTC offset.
    """
    range_key = normalize_range(range_key)
    zone = validate_tz(tz)
    now = now or datetime.now(UTC)
    since = since_for(range_key, now)
    granularity, label_key, step = _GRANULARITY[range_key]
    bucket = _BUCKET_SQL[granularity]
    wsql, wparams = _window(since, now)
    with get_conn() as conn, conn.cursor() as cur:
        if since is None:
            cur.execute(
                "SELECT MIN(p.visited_at) FROM pages p JOIN captures c ON p.capture_id = c.id "
                "WHERE c.user_id = %s AND p.visited_at <= %s",
                (user_id, now),
            )
            first = cur.fetchone()[0] or now
        else:
            first = since
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
        starts = [r[0] for r in cur.fetchall()]
        local = bucket.format(x="l.lx")
        src = (
            "FROM pages p JOIN captures c ON p.capture_id = c.id "
            "CROSS JOIN LATERAL (SELECT p.visited_at AT TIME ZONE %s AS lx) l"
        )
        outcome_cols = ", ".join(
            f"COUNT(*) FILTER (WHERE {OUTCOME_SQL} = '{k}') AS {k}" for k in _OUTCOMES
        )
        cur.execute(
            f"""
            SELECT {local} AS b,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE {FATE_SQL} = 'archived') AS archived,
                   {outcome_cols},
                   COUNT(*) FILTER (WHERE {OUTCOME_SQL} = 'gate'
                       OR ({OUTCOME_SQL} = 'processed' AND p.processing_depth IS NOT NULL))
                       AS reached_gate
            {src}
            WHERE c.user_id = %s AND p.visited_at IS NOT NULL{wsql}
            GROUP BY 1
            """,
            [tz, user_id, *wparams],
        )
        counts = {r[0]: r[1:] for r in cur.fetchall()}
        cur.execute(
            f"""
            SELECT {local} AS b, {DETAIL_SQL} AS cat, COUNT(*)
            {src}
            WHERE c.user_id = %s AND p.visited_at IS NOT NULL
              AND {OUTCOME_SQL} = 'gate'{wsql}
            GROUP BY 1, 2
            """,
            [tz, user_id, *wparams],
        )
        cats: dict[datetime, dict[str, int]] = {}
        for b, cat, n in cur.fetchall():
            cats.setdefault(b, {})[cat] = int(n)
    buckets = []
    for b in starts:
        total, archived, *per_outcome, reached = (
            int(v) for v in counts.get(b, (0,) * (len(_OUTCOMES) + 3))
        )
        buckets.append(
            {
                "start": b.replace(tzinfo=zone).isoformat(),
                "label_key": label_key,
                "total": total,
                "archived": archived,
                "outcomes": dict(zip(_OUTCOMES, per_outcome)),
                "reached_gate": reached,
                "categories": cats.get(b, {}),
            }
        )
    return {"range": range_key, "granularity": granularity, "buckets": buckets}
