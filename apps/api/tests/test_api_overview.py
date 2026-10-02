"""HTTP tests for the Overview dev-view routes."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        from backend.config.settings import settings

        connect(settings.test_database_url).close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import capture_repo, page_repo, user_repo
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


@pytest.fixture
def client():
    from backend.api.main import app, verify_api_key

    user = _user("ov@example.com")
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    yield TestClient(app), user
    app.dependency_overrides.pop(verify_api_key, None)


def test_empty_user(client):
    tc, _ = client
    body = tc.get("/api/overview/summary").json()
    assert body == {
        "range": "all",
        "pages": {"captured": 0, "in_graph": 0, "all_time_captured": 0},
        "captures": {"total": 0, "desktop": 0, "phone": 0},
        "spend": {"usd": 0.0, "calls": 0, "all_time_usd": 0.0, "purposes": []},
        "clusters": None,
    }
    tl = tc.get("/api/overview/timeline").json()
    assert (
        tl["range"] == "all"
        and tl["granularity"] == "month"
        and tl["baseline"] == {"captured": 0, "in_graph": 0}
    )


def test_summary_shape(client):
    tc, user = client
    uid = user["id"]
    cap = _capture(uid, "c1", NOW - timedelta(days=1))
    _page(
        cap, 1, NOW - timedelta(days=1), status="active", processing_depth="processed", user_id=uid
    )
    _cost(uid, "skip_gate", 0.0031, NOW - timedelta(days=1))
    _run(uid, NOW - timedelta(days=1), 7, [("a", "Cooking")])
    from backend.db import auth_repo

    auth_repo.update_preferences(uid, {"topic_interests": [{"keyword": "Cooking"}]})
    body = tc.get("/api/overview/summary", params={"range": "all", "tz": "Europe/London"}).json()
    assert body["pages"] == {"captured": 1, "in_graph": 1, "all_time_captured": 1}
    assert body["spend"]["purposes"][0]["key"] == "gates" and body["spend"]["usd"] == pytest.approx(
        0.0031
    )
    assert body["spend"]["all_time_usd"] == pytest.approx(0.0031)
    assert body["clusters"]["clusters"] == 7 and body["clusters"]["superclusters"] == 1


def test_unknown_range_is_all(client):
    tc, _ = client
    assert tc.get("/api/overview/summary", params={"range": "365"}).json()["range"] == "all"


@pytest.mark.parametrize("path", ["/api/overview/summary", "/api/overview/timeline"])
def test_invalid_tz_is_422(client, path):
    tc, _ = client
    assert tc.get(path, params={"tz": "Not/AZone"}).status_code == 422


@pytest.mark.parametrize(
    "path,attr",
    [("/api/overview/summary", "get_headline"), ("/api/overview/timeline", "get_timeline")],
)
def test_db_unknown_zone_is_422(client, monkeypatch, path, attr):
    import psycopg2.errors

    from backend.db import overview_repo

    def boom(*a, **k):
        raise psycopg2.errors.InvalidParameterValue("time zone not recognized")

    monkeypatch.setattr(overview_repo, attr, boom)
    tc, _ = client
    assert tc.get(path, params={"tz": "UTC"}).status_code == 422


def test_unauthenticated_in_prod_mode_is_401(monkeypatch):
    from backend.api.main import app
    from backend.config.settings import settings

    monkeypatch.setattr(settings, "environment", "production")
    tc = TestClient(app)
    for path in ("/api/overview/summary", "/api/overview/timeline"):
        assert tc.get(path).status_code == 401, path


def test_demo_user_sees_only_own_rows():
    from backend.api.main import app, verify_api_key
    from backend.db import auth_repo

    owner = _user("owner@example.com")["id"]
    demo = _user("demo@example.com")["id"]
    auth_repo.set_role(demo, "demo")
    cap = _capture(owner, "co", NOW - timedelta(days=1))
    _page(
        cap,
        1,
        NOW - timedelta(days=1),
        status="active",
        processing_depth="processed",
        user_id=owner,
    )
    _cost(owner, "agent_query", 1.0, NOW - timedelta(days=1))
    dcap = _capture(demo, "cd", NOW - timedelta(days=1), "mobile_passive")
    _page(dcap, 1, NOW - timedelta(days=1), status="archived", user_id=demo)
    app.dependency_overrides[verify_api_key] = lambda: demo
    try:
        tc = TestClient(app)
        body = tc.get("/api/overview/summary").json()
        assert body["pages"] == {"captured": 1, "in_graph": 0, "all_time_captured": 1}
        assert body["captures"] == {"total": 1, "desktop": 0, "phone": 1}
        assert body["spend"]["calls"] == 0 and body["spend"]["all_time_usd"] == 0.0
        tl = tc.get("/api/overview/timeline").json()["buckets"]
        assert sum(b["calls"] for b in tl) == 0 and sum(b["captured"] for b in tl) == 1
    finally:
        app.dependency_overrides.pop(verify_api_key, None)
