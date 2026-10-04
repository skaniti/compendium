"""HTTP tests for the Clusters dev-view routes (all figures synthetic)."""

import json
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

from backend.db import auth_repo, capture_repo, cluster_view_repo, page_repo, user_repo
from backend.db.connection import get_conn

NOW = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _clean_tables():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE graph_cache, featured_singletons, cluster_edges, page_clusters, clusters, "
            "super_cluster_groups, recluster_runs, pages, page_content, captures, users CASCADE"
        )
    yield


def _user(email):
    return user_repo.create_user(email, name="Clusters User")["id"]


def _sql(sql, params=()):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()[0] if cur.description else None


def _pages(uid, specs):
    """specs: list of (n, status, human_status, created_at, visited_at) -> {n: page_id}."""
    cap = capture_repo.save_capture(
        user_id=uid,
        capture_id=f"cap-{uid}",
        source="desktop_active",
        started_at=NOW - timedelta(days=30),
        ended_at=NOW - timedelta(days=30) + timedelta(minutes=5),
    )
    out = {}
    for n, status, human, created, visited in specs:
        (pid,) = page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": f"https://example.org/u{uid}/p{n}",
                    "title": f"Page {n:02d}",
                    "domain": "example.org",
                    "visited_at": visited,
                }
            ],
        )
        _sql(
            "UPDATE pages SET status = %s, human_status = %s, created_at = %s, user_id = %s WHERE id = %s",
            (status, human, created, uid, pid),
        )
        out[n] = pid
    return out


def _run(uid, status, started, *, clusters=None, noise=None, cost=None, elapsed=None):
    completed = None if status == "running" else started + timedelta(hours=1)
    return _sql(
        "INSERT INTO recluster_runs (user_id, status, started_at, completed_at, cluster_count, "
        "noise_count, naming_cost, elapsed_seconds) VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (uid, status, started, completed, clusters, noise, cost, elapsed),
    )


def _group(uid, run_id, label, source="suggested", tier="casual"):
    return _sql(
        "INSERT INTO super_cluster_groups (user_id, recluster_run, label, source, interest_tier) "
        "VALUES (%s,%s,%s,%s,%s) RETURNING id",
        (uid, run_id, label, source, tier),
    )


def _cluster(uid, run_id, slug, page_ids, *, sc=None, conf=None, carried=False, group_id=None):
    cid = _sql(
        "INSERT INTO clusters (user_id, cluster_slug, cluster_name, recluster_run, super_cluster, "
        "mean_membership_probability, name_carried, group_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (uid, slug, slug.title(), run_id, sc, conf, carried, group_id),
    )
    for pid in page_ids:
        _sql("INSERT INTO page_clusters (page_id, cluster_id) VALUES (%s, %s)", (pid, cid))
    return cid


def _edge(run_id, a, b, w):
    _sql(
        "INSERT INTO cluster_edges (source_cluster, target_cluster, weight, recluster_run) VALUES (%s,%s,%s,%s)",
        (a, b, w, run_id),
    )


def _featured(uid, run_id, pid):
    _sql(
        "INSERT INTO featured_singletons (user_id, page_id, recluster_run, outlier_score) VALUES (%s,%s,%s,0.9)",
        (uid, pid, run_id),
    )


def _world(uid):
    """Nine pages; four runs (archived, kept, failed, current); two current clusters."""
    old = NOW - timedelta(days=20)
    p = _pages(
        uid,
        [
            (1, "active", None, old, NOW - timedelta(days=9)),
            (2, "active", None, old, NOW - timedelta(days=8)),
            (3, "active", None, old, NOW - timedelta(days=7)),
            (4, "active", None, old, NOW - timedelta(days=6)),
            (5, "active", None, old, NOW - timedelta(days=5)),
            (6, "active", None, old, NOW - timedelta(days=4)),
            (7, "archived", "active", old, NOW - timedelta(days=3)),  # human override: in the graph
            (8, "archived", None, old, NOW - timedelta(days=2)),  # clustered, archived since
            (
                9,
                "active",
                None,
                NOW - timedelta(days=1),
                NOW - timedelta(days=1),
            ),  # new since the run
        ],
    )
    r_old = _run(
        uid, "archived", NOW - timedelta(days=30), clusters=1, noise=0, cost=0.0005, elapsed=3.0
    )
    r_kept = _run(
        uid, "completed", NOW - timedelta(days=10), clusters=1, noise=4, cost=0.0007, elapsed=5.5
    )
    r_fail = _run(uid, "failed", NOW - timedelta(days=3))
    r_cur = _run(
        uid, "completed", NOW - timedelta(days=2), clusters=2, noise=3, cost=0.0012, elapsed=8.4
    )
    _cluster(uid, r_kept, "old", [p[5]])
    g = _group(uid, r_cur, "Sky things")
    _group(uid, r_cur, "Sky things")  # duplicate label: counted once
    _group(uid, r_cur, "space", source="keyword", tier="declared")
    alpha = _cluster(
        uid, r_cur, "alpha", [p[1], p[2], p[3]], sc="space", conf=0.91, carried=True, group_id=g
    )
    beta = _cluster(uid, r_cur, "beta", [p[4], p[8]])
    _edge(r_cur, alpha, beta, 0.7)
    _featured(uid, r_cur, p[6])
    auth_repo.update_preferences(
        uid, {"topic_interests": [{"keyword": "space"}, {"keyword": "music"}]}
    )
    return {"p": p, "runs": (r_old, r_kept, r_fail, r_cur), "alpha": alpha, "beta": beta}


@pytest.fixture
def client():
    from backend.api.main import app, verify_api_key

    uid = _user("clusters@example.com")
    app.dependency_overrides[verify_api_key] = lambda: uid
    yield TestClient(app), uid
    app.dependency_overrides.pop(verify_api_key, None)


def test_empty_user(client):
    tc, _ = client
    s = tc.get("/api/clusters/summary").json()
    assert s["run"] is None and s["pages"] is None and s["clusters"] == []
    assert s["runs"] == {"total": 0, "items": []}
    assert s["edges"]["count"] == 0 and len(s["edges"]["bins"]) == 10
    assert s["groups"] == {"superclusters": 0, "topics": 0, "suggested": 0}
    assert s["config"]["clustering"]["effective_min_cluster_size"] is None
    assert tc.get("/api/clusters/unclustered").json() == {
        "total": 0,
        "limit": 50,
        "offset": 0,
        "pages": [],
    }


def test_only_failed_runs(client):
    tc, uid = client
    r = _run(uid, "failed", NOW - timedelta(days=1))
    s = tc.get("/api/clusters/summary").json()
    assert s["run"] is None and s["pages"] is None
    assert s["runs"]["total"] == 1 and s["runs"]["items"][0]["id"] == r
    assert s["runs"]["items"][0]["status"] == "failed"


def test_current_run_and_history(client):
    tc, uid = client
    w = _world(uid)
    r_old, r_kept, r_fail, r_cur = w["runs"]
    s = tc.get("/api/clusters/summary").json()
    assert s["run"]["id"] == r_cur
    assert set(s["run"]) == {
        "id",
        "started_at",
        "completed_at",
        "elapsed_seconds",
        "naming_cost",
        "cluster_count",
        "noise_count",
    }
    assert (s["run"]["naming_cost"], s["run"]["elapsed_seconds"], s["run"]["noise_count"]) == (
        0.0012,
        8.4,
        3,
    )
    assert s["runs"]["total"] == 4
    assert [r["id"] for r in s["runs"]["items"]] == [r_cur, r_fail, r_kept, r_old]
    assert [r["status"] for r in s["runs"]["items"]] == [
        "completed",
        "failed",
        "completed",
        "archived",
    ]


def test_cluster_rows(client):
    tc, uid = client
    w = _world(uid)
    rows = tc.get("/api/clusters/summary").json()["clusters"]
    assert rows == [
        {
            "id": w["alpha"],
            "name": "Alpha",
            "slug": "alpha",
            "size": 3,
            "confidence": 0.91,
            "name_carried": True,
            "super_cluster": "space",
            "group": {"label": "Sky things", "source": "suggested", "tier": "casual"},
        },
        {
            "id": w["beta"],
            "name": "Beta",
            "slug": "beta",
            "size": 2,
            "confidence": None,
            "name_carried": False,
            "super_cluster": None,
            "group": None,
        },
    ]


def test_page_counts(client):
    tc, uid = client
    _world(uid)
    assert tc.get("/api/clusters/summary").json()["pages"] == {
        "in_graph": 8,
        "clustered": 5,
        "clustered_in_graph": 4,
        "not_clustered": 4,
        "featured": 1,
        "since_run": 1,
    }


def test_edges_and_groups(client):
    tc, uid = client
    _world(uid)
    s = tc.get("/api/clusters/summary").json()
    e = s["edges"]
    assert (e["count"], e["min"], e["max"], e["mean"]) == (1, 0.7, 0.7, 0.7)
    assert [b["count"] for b in e["bins"]] == [0, 0, 0, 0, 0, 0, 0, 1, 0, 0]
    assert s["groups"] == {"superclusters": 1, "topics": 2, "suggested": 1}


def test_config_is_parameters_only(client):
    from backend.config.settings import settings

    tc, uid = client
    _world(uid)
    cfg = tc.get("/api/clusters/summary").json()["config"]
    blob = json.dumps(cfg)
    assert "://" not in blob
    for name in (
        "openai_api_key",
        "openai_api_key_demo",
        "anthropic_api_key",
        "youtube_api_key",
        "langchain_api_key",
        "jwt_secret_key",
        "database_url",
        "test_database_url",
        "api_host",
        "frontend_url",
    ):
        value = getattr(settings, name, None)
        if value and len(str(value)) > 3:
            assert str(value) not in blob, name
    # considered = noise (3) + clustered (5) = 8 -> max(setting, 8 // 150)
    assert cfg["clustering"]["effective_min_cluster_size"] == settings.hdbscan_min_cluster_size


def test_naming_override_text_admin_only(client, monkeypatch):
    # A view-as token is the demo account's, so the "demo" role covers it.
    from backend.config.settings import settings
    from backend.db import auth_repo
    from backend.prompts import templates

    name = f"cluster_naming_{settings.cluster_naming_prompt_version}"
    monkeypatch.setattr(templates, "_load_overrides", lambda: {name: "LOCAL OVERRIDE {n_pages}"})
    tc, uid = client
    for role in ("demo", "user"):
        auth_repo.set_role(uid, role)
        naming = tc.get("/api/clusters/summary").json()["config"]["naming"]
        assert naming["prompt"] == templates.PROMPTS[name]["template"]
        assert naming["prompt_override"] == "withheld"
        assert "LOCAL OVERRIDE" not in json.dumps(tc.get("/api/clusters/summary").json())
    auth_repo.set_role(uid, "admin")
    naming = tc.get("/api/clusters/summary").json()["config"]["naming"]
    assert (naming["prompt"], naming["prompt_override"]) == ("LOCAL OVERRIDE {n_pages}", "shown")


def test_other_users_never_count(client):
    tc, uid = client
    _world(uid)
    before = tc.get("/api/clusters/summary").json()
    before_loose = tc.get("/api/clusters/unclustered").json()
    other = _user("other@example.com")
    ow = _world(other)
    _run(other, "completed", NOW + timedelta(hours=1), clusters=9, noise=9)  # newer than ours
    _cluster(other, ow["runs"][3], "gamma", [ow["p"][6]])
    assert tc.get("/api/clusters/summary").json() == before
    assert tc.get("/api/clusters/unclustered").json() == before_loose


def test_members_own_cluster(client):
    tc, uid = client
    w = _world(uid)
    body = tc.get(f"/api/clusters/{w['alpha']}/pages").json()
    assert body["cluster_id"] == w["alpha"] and body["total"] == 3
    assert [p["title"] for p in body["pages"]] == ["Page 01", "Page 02", "Page 03"]
    assert set(body["pages"][0]) == {"id", "title", "domain", "url"}


def test_members_other_users_cluster_is_404(client):
    tc, uid = client
    _world(uid)
    other = _user("other@example.com")
    ow = _world(other)
    r = tc.get(f"/api/clusters/{ow['alpha']}/pages")
    assert r.status_code == 404 and r.json() == {"detail": "cluster not found"}


def test_members_unknown_and_out_of_range(client):
    tc, uid = client
    _world(uid)
    r = tc.get("/api/clusters/999999/pages")
    assert r.status_code == 404
    assert r.json() == {"detail": "cluster not found"}
    assert tc.get(f"/api/clusters/{2**31}/pages").status_code == 422
    assert tc.get("/api/clusters/0/pages").status_code == 422
    assert tc.get("/api/clusters/abc/pages").status_code == 422


def test_members_cap(client):
    _, uid = client
    w = _world(uid)
    body = cluster_view_repo.get_cluster_members(uid, w["alpha"], limit=2)
    assert body["total"] == 3 and len(body["pages"]) == 2


def test_unclustered_rows_and_order(client):
    tc, uid = client
    w = _world(uid)
    p = w["p"]
    body = tc.get("/api/clusters/unclustered").json()
    assert body["total"] == 4 == tc.get("/api/clusters/summary").json()["pages"]["not_clustered"]
    # featured first, then newest visit first
    assert [r["id"] for r in body["pages"]] == [p[6], p[9], p[7], p[5]]
    assert [(r["featured"], r["since_run"]) for r in body["pages"]] == [
        (True, False),
        (False, True),
        (False, False),
        (False, False),
    ]
    page2 = tc.get("/api/clusters/unclustered?limit=2&offset=2").json()
    assert (page2["limit"], page2["offset"], page2["total"]) == (2, 2, 4)
    assert [r["id"] for r in page2["pages"]] == [p[7], p[5]]


@pytest.mark.parametrize("query", ["limit=0", "limit=201", "offset=-1", "limit=x"])
def test_unclustered_validation(client, query):
    tc, _ = client
    assert tc.get(f"/api/clusters/unclustered?{query}").status_code == 422


def test_plain_demo_reads_its_own_data():
    from backend.api.main import app, verify_api_key

    owner = _user("owner@example.com")
    demo = _user("demo@example.com")
    auth_repo.set_role(demo, "demo")
    _world(owner)
    dp = _pages(demo, [(1, "active", None, NOW - timedelta(days=5), NOW - timedelta(days=5))])
    r = _run(demo, "completed", NOW - timedelta(days=4), clusters=1, noise=0)
    c = _cluster(demo, r, "demo-cluster", [dp[1]])
    app.dependency_overrides[verify_api_key] = lambda: demo
    try:
        tc = TestClient(app)
        s = tc.get("/api/clusters/summary").json()
        assert s["run"]["id"] == r and [x["id"] for x in s["clusters"]] == [c]
        assert s["pages"]["in_graph"] == 1 and s["runs"]["total"] == 1
        assert tc.get(f"/api/clusters/{c}/pages").status_code == 200
    finally:
        app.dependency_overrides.pop(verify_api_key, None)


def test_unauthenticated_in_prod_mode_is_401(monkeypatch):
    from backend.api.main import app
    from backend.config.settings import settings

    monkeypatch.setattr(settings, "environment", "production")
    tc = TestClient(app)
    for path in ("/api/clusters/summary", "/api/clusters/unclustered", "/api/clusters/1/pages"):
        assert tc.get(path).status_code == 401, path
