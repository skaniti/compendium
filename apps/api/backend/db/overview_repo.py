"""Period-scoped queries for the Overview dev view.

Pages scope through ``captures c`` (``c.user_id``) and use Pipeline's window on
``visited_at`` and its fate (``pipeline_repo.FATE_SQL``), so Captured and In your
graph agree with the Pipeline tab. Captures window on ``started_at`` and spend on
``cost_events.created_at``, both capped at ``now``. ``now`` and ``tz`` are bound
parameters; callers validate ``tz`` first. Clusters are a current-state snapshot
of the latest completed recluster run (spec R2), not period-scoped.
"""

from __future__ import annotations

from datetime import UTC, datetime

from backend.db import auth_repo, cluster_repo, period, recluster_repo
from backend.db.connection import get_conn
from backend.db.pipeline_repo import FATE_SQL
from backend.services.overview_summary import PURPOSE_KEYS, count_graph_superclusters, purpose_of

DESKTOP_SOURCES = ("desktop_active", "desktop_passive")
PHONE_SOURCES = ("mobile_passive",)
_PAGES = "FROM pages p JOIN captures c ON p.capture_id = c.id"


def _windows(range_key: str, now: datetime):
    since = period.since_for(range_key, now)
    return (
        since,
        period.window(since, now),
        period.window(since, now, col="c.started_at", include_null=False),
        period.window(since, now, col="e.created_at", include_null=False),
    )


def get_headline(user_id: int, range_key: str = "all", *, now: datetime | None = None) -> dict:
    range_key = period.normalize_range(range_key)
    now = now or datetime.now(UTC)
    _since, (pw, pp), (cw, cp), (ew, ep) = _windows(range_key, now)
    aw, ap = period.window(None, now)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"SELECT COUNT(*), COUNT(*) FILTER (WHERE {FATE_SQL} = 'active') {_PAGES} "
            f"WHERE c.user_id = %s{pw}",
            [user_id, *pp],
        )
        captured, in_graph = (int(v) for v in cur.fetchone())
        cur.execute(f"SELECT COUNT(*) {_PAGES} WHERE c.user_id = %s{aw}", [user_id, *ap])
        all_time = int(cur.fetchone()[0])
        cur.execute(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE c.source IN %s), "
            "COUNT(*) FILTER (WHERE c.source IN %s) "
            f"FROM captures c WHERE c.user_id = %s{cw}",
            [DESKTOP_SOURCES, PHONE_SOURCES, user_id, *cp],
        )
        total, desktop, phone = (int(v) for v in cur.fetchone())
        cur.execute(
            "SELECT e.event_type, COALESCE(SUM(e.cost_usd::double precision), 0), COUNT(*) "
            f"FROM cost_events e WHERE e.user_id = %s{ew} GROUP BY 1",
            [user_id, *ep],
        )
        spend_rows = [(t, float(u), int(n)) for t, u, n in cur.fetchall()]
    return {
        "captured": captured,
        "in_graph": in_graph,
        "all_time_captured": all_time,
        "captures": {"total": total, "desktop": desktop, "phone": phone},
        "spend_rows": spend_rows,
    }


def get_latest_clusters(user_id: int) -> dict | None:
    run = recluster_repo.get_latest_run(user_id)
    if run is None:
        return None
    topics = [t["keyword"] for t in auth_repo.get_preferences(user_id).get("topic_interests", [])]
    sc_map = cluster_repo.get_super_cluster_map(user_id, run["id"])
    done = run["completed_at"]
    return {
        "run_completed_at": done.isoformat() if done else None,
        "clusters": int(run["cluster_count"] or 0),
        "superclusters": count_graph_superclusters(sc_map, topics),
        "topics": len(topics),
    }


def get_timeline(user_id: int, range_key: str, tz: str, *, now: datetime | None = None) -> dict:
    """Per-bucket captured / in-graph pages, captures by device and spend by purpose.

    Buckets follow Pipeline's granularity and local wall-clock starts (empty
    buckets kept). All time starts at the user's earliest page visit, capture or
    cost event (spec R11); windowed ranges start at ``since`` and report the
    pages visited before it as ``baseline`` (for running totals).
    """
    range_key = period.normalize_range(range_key)
    zone = period.validate_tz(tz)
    now = now or datetime.now(UTC)
    since, (pw, pp), (cw, cp), (ew, ep) = _windows(range_key, now)
    granularity, label_key, _step = period.GRANULARITY[range_key]
    bucket = period.BUCKET_SQL[granularity].format(x="l.lx")
    with get_conn() as conn, conn.cursor() as cur:
        if since is None:
            cur.execute(
                f"""
                SELECT LEAST(
                  (SELECT MIN(p.visited_at) {_PAGES} WHERE c.user_id = %s AND p.visited_at <= %s),
                  (SELECT MIN(c.started_at) FROM captures c WHERE c.user_id = %s AND c.started_at <= %s),
                  (SELECT MIN(e.created_at) FROM cost_events e WHERE e.user_id = %s AND e.created_at <= %s))
                """,
                (user_id, now, user_id, now, user_id, now),
            )
            first = cur.fetchone()[0] or now
            baseline = (0, 0)
        else:
            first = since
            cur.execute(
                f"SELECT COUNT(*), COUNT(*) FILTER (WHERE {FATE_SQL} = 'active') {_PAGES} "
                "WHERE c.user_id = %s AND p.visited_at < %s",
                (user_id, since),
            )
            baseline = tuple(int(v) for v in cur.fetchone())
        starts = period.bucket_starts(cur, first, now, range_key, tz)
        cur.execute(
            f"""
            SELECT {bucket}, COUNT(*), COUNT(*) FILTER (WHERE {FATE_SQL} = 'active')
            {_PAGES} CROSS JOIN LATERAL (SELECT p.visited_at AT TIME ZONE %s AS lx) l
            WHERE c.user_id = %s AND p.visited_at IS NOT NULL{pw}
            GROUP BY 1
            """,
            [tz, user_id, *pp],
        )
        pages = {b: (int(n), int(a)) for b, n, a in cur.fetchall()}
        cur.execute(
            f"""
            SELECT {bucket}, COUNT(*) FILTER (WHERE c.source IN %s), COUNT(*) FILTER (WHERE c.source IN %s)
            FROM captures c CROSS JOIN LATERAL (SELECT c.started_at AT TIME ZONE %s AS lx) l
            WHERE c.user_id = %s{cw}
            GROUP BY 1
            """,
            [DESKTOP_SOURCES, PHONE_SOURCES, tz, user_id, *cp],
        )
        caps = {b: (int(d), int(m)) for b, d, m in cur.fetchall()}
        cur.execute(
            f"""
            SELECT {bucket}, e.event_type, COALESCE(SUM(e.cost_usd::double precision), 0), COUNT(*)
            FROM cost_events e CROSS JOIN LATERAL (SELECT e.created_at AT TIME ZONE %s AS lx) l
            WHERE e.user_id = %s{ew}
            GROUP BY 1, 2
            """,
            [tz, user_id, *ep],
        )
        spend: dict[datetime, dict] = {}
        for b, event_type, usd, n in cur.fetchall():
            s = spend.setdefault(b, {"usd": dict.fromkeys(PURPOSE_KEYS, 0.0), "calls": 0})
            s["usd"][purpose_of(event_type)] += float(usd)
            s["calls"] += int(n)
    buckets = []
    for b in starts:
        n, a = pages.get(b, (0, 0))
        d, m = caps.get(b, (0, 0))
        s = spend.get(b, {"usd": dict.fromkeys(PURPOSE_KEYS, 0.0), "calls": 0})
        buckets.append(
            {
                "start": b.replace(tzinfo=zone).isoformat(),
                "label_key": label_key,
                "captured": n,
                "in_graph": a,
                "captures": {"desktop": d, "phone": m},
                "spend": {k: round(v, 6) for k, v in s["usd"].items()},
                "calls": s["calls"],
            }
        )
    return {
        "range": range_key,
        "granularity": granularity,
        "baseline": {"captured": baseline[0], "in_graph": baseline[1]},
        "buckets": buckets,
    }
