"""Postgres tests for the Overview repo (windows, fate, buckets, user scoping)."""

from datetime import UTC, datetime, timedelta

import pytest


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        from backend.config.settings import settings

        connect(settings.test_database_url).close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import auth_repo, capture_repo, overview_repo, page_repo, pipeline_repo, user_repo
from backend.db.connection import get_conn

NOW = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _clean_tables():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE graph_cache, cluster_edges, page_clusters, clusters, super_cluster_groups, "
            "recluster_runs, cost_events, pages, page_content, captures, users CASCADE"
        )
    yield


def _user(email):
    return user_repo.create_user(email, name="Overview User")


def _capture(user_id, cid, started, source="desktop_active"):
    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=cid,
        source=source,
        started_at=started,
        ended_at=started + timedelta(minutes=30),
    )


def _page(cap, n, visited, **cols):
    (pid,) = page_repo.insert_pages(
        cap["id"],
        [
            {
                "url": f"https://example.org/p{cap['id']}-{n}",
                "title": f"P{n}",
                "domain": "example.org",
                "visited_at": visited,
            }
        ],
    )
    if cols:
        sets = ", ".join(f"{k} = %s" for k in cols)
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(f"UPDATE pages SET {sets} WHERE id = %s", (*cols.values(), pid))
    return pid


def _cost(user_id, event_type, usd, at):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO cost_events (user_id, event_type, model, cost_usd, created_at) VALUES (%s, %s, 'm', %s, %s)",
            (user_id, event_type, usd, at),
        )


def _run(user_id, completed_at, cluster_count, supers):
    """A completed run with one cluster per (slug, super_cluster) in ``supers``."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO recluster_runs (user_id, status, completed_at, cluster_count, noise_count) "
            "VALUES (%s, 'completed', %s, %s, 0) RETURNING id",
            (user_id, completed_at, cluster_count),
        )
        run_id = cur.fetchone()[0]
        for slug, sc in supers:
            cur.execute(
                "INSERT INTO clusters (user_id, cluster_slug, cluster_name, recluster_run, super_cluster) "
                "VALUES (%s, %s, %s, %s, %s)",
                (user_id, slug, slug, run_id, sc),
            )
    return run_id


def _seed(uid):
    """Two desktop + one phone capture; 5 pages: 2 active (one by human override),
    1 archived, 1 visited 40 days ago (active), 1 with NULL visit; spend in and out of the window."""
    c1 = _capture(uid, "c1", NOW - timedelta(days=1))
    c2 = _capture(uid, "c2", NOW - timedelta(days=2), "desktop_passive")
    c3 = _capture(uid, "c3", NOW - timedelta(days=3), "mobile_passive")
    _page(
        c1, 1, NOW - timedelta(days=1), status="active", processing_depth="processed", user_id=uid
    )
    _page(
        c2,
        2,
        NOW - timedelta(days=2),
        status="archived",
        processing_depth="skipped",
        archive_reason="skip_gate",
        human_status="active",
        user_id=uid,
    )
    _page(c3, 3, NOW - timedelta(days=3), status="archived", archive_reason="dedup", user_id=uid)
    _page(
        c1, 4, NOW - timedelta(days=40), status="active", processing_depth="processed", user_id=uid
    )
    _page(c1, 5, None, status="pending", user_id=uid)
    _page(
        c1, 6, NOW + timedelta(hours=1), status="active", processing_depth="processed", user_id=uid
    )  # future: never counts
    _cost(uid, "skip_gate", 0.002, NOW - timedelta(days=1))
    _cost(uid, "agent_query", 0.01, NOW - timedelta(days=5))
    _cost(uid, "cluster_naming", 0.5, NOW - timedelta(days=60))
    _cost(uid, "agent_query", 7.0, NOW + timedelta(hours=1))  # future: never counts


def test_window_edges():
    uid = _user("a@example.com")["id"]
    _seed(uid)
    h7 = overview_repo.get_headline(uid, "7d", now=NOW)
    assert (h7["captured"], h7["in_graph"], h7["all_time_captured"]) == (3, 2, 5)
    assert h7["captures"] == {"total": 3, "desktop": 2, "phone": 1}
    assert sorted(h7["spend_rows"]) == [
        ("agent_query", pytest.approx(0.01), 1),
        ("skip_gate", pytest.approx(0.002), 1),
    ]
    hall = overview_repo.get_headline(uid, "all", now=NOW)
    assert hall["all_time_usd"] == pytest.approx(0.512)
    assert h7["all_time_usd"] == pytest.approx(0.512)
    assert (hall["captured"], hall["in_graph"]) == (
        5,
        3,
    )  # NULL visit counts in All time; the future page never does


def test_headline_matches_pipeline():
    uid = _user("a@example.com")["id"]
    _seed(uid)
    for rk in ("7d", "30d", "90d", "all"):
        h = overview_repo.get_headline(uid, rk, now=NOW)
        cells = pipeline_repo.get_flow_counts(uid, rk, now=NOW)["cells"]
        assert h["captured"] == sum(n for *_, n in cells), rk
        assert h["in_graph"] == sum(n for _, _, fate, n in cells if fate == "active"), rk


def test_other_users_never_count():
    a = _user("a@example.com")["id"]
    b = _user("b@example.com")["id"]
    _seed(b)
    _run(b, NOW - timedelta(days=1), 9, [("x", "Cooking")])
    auth_repo.update_preferences(b, {"topic_interests": [{"keyword": "Cooking"}]})
    h = overview_repo.get_headline(a, "all", now=NOW)
    assert (h["captured"], h["in_graph"], h["all_time_captured"]) == (0, 0, 0)
    assert h["captures"] == {"total": 0, "desktop": 0, "phone": 0} and h["spend_rows"] == []
    assert overview_repo.get_latest_clusters(a) is None
    tl = overview_repo.get_timeline(a, "30d", "UTC", now=NOW)
    assert all(
        b_["captured"] == 0 and b_["calls"] == 0 and b_["captures"] == {"desktop": 0, "phone": 0}
        for b_ in tl["buckets"]
    )
    assert tl["baseline"] == {"captured": 0, "in_graph": 0}
    tla = overview_repo.get_timeline(a, "all", "UTC", now=NOW)
    assert len(tla["buckets"]) == 1 and tla["buckets"][0]["start"].startswith("2026-09-01")
    assert tla["buckets"][0]["captured"] == 0 and tla["buckets"][0]["calls"] == 0
    assert tla["buckets"][0]["captures"] == {"desktop": 0, "phone": 0}
    assert all(v == 0 for v in tla["buckets"][0]["spend"].values())


def test_latest_clusters_counts_graph_superclusters():
    uid = _user("a@example.com")["id"]
    _run(uid, NOW - timedelta(days=30), 3, [("old", "Cooking")])
    _run(
        uid,
        NOW - timedelta(days=1),
        4,
        [("a", "Cooking"), ("b", "Cooking"), ("c", "Physics"), ("d", "Suggested")],
    )
    auth_repo.update_preferences(
        uid,
        {
            "topic_interests": [
                {"keyword": "Cooking"},
                {"keyword": "Physics"},
                {"keyword": "Unused"},
            ]
        },
    )
    c = overview_repo.get_latest_clusters(uid)
    assert c["clusters"] == 4 and c["superclusters"] == 2 and c["topics"] == 3
    assert c["run_completed_at"].startswith("2026-09-19")


def test_timeline_reconciles_and_keeps_empty_buckets():
    uid = _user("a@example.com")["id"]
    _seed(uid)
    tl = overview_repo.get_timeline(uid, "30d", "UTC", now=NOW)
    assert tl["granularity"] == "day" and len(tl["buckets"]) == 31
    assert sum(b["captured"] for b in tl["buckets"]) == 3  # NULL visit and future page excluded
    assert sum(b["in_graph"] for b in tl["buckets"]) == 2
    assert tl["baseline"] == {"captured": 1, "in_graph": 1}  # the 40-day-old page
    assert sum(b["captures"]["desktop"] + b["captures"]["phone"] for b in tl["buckets"]) == 3
    assert sum(b["calls"] for b in tl["buckets"]) == 2
    assert sum(b["spend"]["chat"] for b in tl["buckets"]) == pytest.approx(0.01)
    assert sum(1 for b in tl["buckets"] if b["captured"] == 0) == 28
    assert set(tl["buckets"][0]["spend"]) == {"gates", "clustering", "chat", "other"}


def test_timeline_all_starts_at_first_datum_with_zero_baseline():
    uid = _user("a@example.com")["id"]
    _seed(uid)
    tl = overview_repo.get_timeline(uid, "all", "UTC", now=NOW)
    assert tl["baseline"] == {"captured": 0, "in_graph": 0}
    assert tl["buckets"][0]["start"].startswith(
        "2026-07-01"
    )  # the 60-day-old cost event is the earliest datum
    assert tl["buckets"][-1]["start"].startswith("2026-09-01")


def test_timeline_local_offsets():
    uid = _user("a@example.com")["id"]
    _seed(uid)
    tl = overview_repo.get_timeline(uid, "7d", "Asia/Kolkata", now=NOW)
    assert tl["granularity"] == "6h" and all(b["start"].endswith("+05:30") for b in tl["buckets"])


def test_empty_user():
    uid = _user("a@example.com")["id"]
    h = overview_repo.get_headline(uid, "all", now=NOW)
    assert h == {
        "captured": 0,
        "in_graph": 0,
        "all_time_captured": 0,
        "captures": {"total": 0, "desktop": 0, "phone": 0},
        "spend_rows": [],
        "all_time_usd": 0.0,
    }
    tl = overview_repo.get_timeline(uid, "all", "UTC", now=NOW)
    assert len(tl["buckets"]) == 1 and tl["buckets"][0]["captured"] == 0
