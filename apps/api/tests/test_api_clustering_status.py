"""Endpoint contract tests for GET /api/clustering/status (migration batch
02, task 3, endpoint 2) -- the last of four thin read endpoints ported for
the Next.js graph header.

Thin wrapper combining three Dash callbacks' data reads, all scoped to the
same "latest completed recluster_runs row" concept:

  - title / run_number: frontend/dash/callbacks/graph.py:49-76
    (update_clustering_card_title) -- "CLUSTERING (RUN #N)" or
    "CLUSTERING (NO RUNS YET)".
  - stats_line1 / stats_line2: frontend/dash/callbacks/graph.py:208-291
    (update_hbar_cluster_stats) -- "N clusters · K topics[ · M suggested]"
    and "P% noise". K comes from auth_repo.get_preferences'
    topic_interests (same source as the SUPERCLUSTERS card). Noise is
    computed live via the singleton-cluster (size=1) subquery, NOT the
    recluster_runs.noise_count column captured at completion time.
  - freshness_label / freshness_color: frontend/dash/callbacks/
    recluster.py:98-144 (update_cache_badge) -- "No cache" (no cache row)
    or "● {N}m/h/d ago" with a hex color tier based on cache age.

Presentation-ready strings ARE the contract here -- the Next.js client
renders stats_line1/stats_line2/freshness_label verbatim, so exact
formats (punctuation, conditionals, unit letters) are asserted, not just
presence.

When no completed run exists, this endpoint byte-mirrors
update_hbar_cluster_stats's no-row branch: stats_line1 is the literal
string "no recluster yet", stats_line2 is "" -- Dash parity is this
batch's binding contract, so the exact source string is asserted, not an
API-invented empty-state placeholder.

naming_cost/cluster identity fields are intentionally absent from the
response (design audit §4.7 -- dev telemetry, not user-facing).
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient


def _pg_reachable() -> bool:
    try:
        from backend.config.settings import settings
        from psycopg2 import connect

        conn = connect(settings.test_database_url)
        conn.close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _pg_reachable(),
    reason="Test PostgreSQL not reachable",
)

from backend.db import (
    auth_repo,
    capture_repo,
    cluster_repo,
    graph_repo,
    page_repo,
    recluster_repo,
    user_repo,
)
from backend.db.connection import get_conn


@pytest.fixture(autouse=True)
def _clean_tables():
    """Truncate all tables before each test for isolation.

    Safe: conftest.py redirects all connections to the test database.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                TRUNCATE graph_cache, cluster_edges, page_clusters,
                         super_cluster_groups, clusters, recluster_runs,
                         pages, page_content, captures, users
                CASCADE
                """
            )
    yield


def _make_user(email="clustering@example.com"):
    return user_repo.create_user(email, name="Clustering User")


def _make_capture(user_id, capture_id="cap_clustering_001"):
    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture_id,
        source="desktop_active",
        started_at=datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 3, 15, 11, 0, tzinfo=timezone.utc),
    )


def _make_pages(capture_db_id, count, url_prefix="https://en.wikipedia.org/wiki/Page"):
    pages = [
        {
            "url": f"{url_prefix}_{i}",
            "title": f"Page {i}",
            "domain": "en.wikipedia.org",
            "visited_at": datetime(2026, 3, 15, 10, i + 1, tzinfo=timezone.utc),
        }
        for i in range(count)
    ]
    ids = page_repo.insert_pages(capture_db_id, pages)
    for pid in ids:
        page_repo.update_page_status(pid, "active")
    return ids


def _seed_completed_run(user_id, cluster_sizes, cap=None):
    """Create a completed recluster run with clusters sized per
    ``cluster_sizes`` (e.g. [2, 1, 1] -> one 2-page cluster + two
    singleton/"noise" clusters). Returns the run id."""
    if cap is None:
        cap = _make_capture(user_id)
    total_pages = sum(cluster_sizes)
    page_ids = _make_pages(cap["id"], total_pages)

    run_id = recluster_repo.start_run(user_id)
    cluster_specs = [
        {"cluster_slug": f"cluster_{i}", "cluster_name": f"Cluster {i}"}
        for i in range(len(cluster_sizes))
    ]
    slug_to_id = cluster_repo.save_clusters(user_id, run_id, cluster_specs)

    pairs = []
    idx = 0
    for i, size in enumerate(cluster_sizes):
        cluster_id = slug_to_id[f"cluster_{i}"]
        for _ in range(size):
            pairs.append((page_ids[idx], cluster_id))
            idx += 1
    cluster_repo.save_page_clusters(pairs)

    recluster_repo.complete_run(
        run_id,
        cluster_count=len(cluster_sizes),
        noise_count=sum(1 for s in cluster_sizes if s == 1),
        naming_cost=0.01,
        elapsed_seconds=1.0,
    )
    return run_id


def _seed_cache_age(user_id, *, minutes_ago=None, days_ago=None):
    """Directly seed a graph_cache row with a specific updated_at, bypassing
    graph_repo.save_graph_cache's NOW()-only upsert -- required to exercise
    freshness tier boundaries deterministically."""
    assert (minutes_ago is None) != (days_ago is None)
    delta = (
        timedelta(minutes=minutes_ago) if minutes_ago is not None else timedelta(days=days_ago)
    )
    updated_at = datetime.now(timezone.utc) - delta
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO graph_cache (user_id, graph_data, updated_at)
                VALUES (%s, '{}'::jsonb, %s)
                ON CONFLICT (user_id) DO UPDATE
                SET graph_data = EXCLUDED.graph_data, updated_at = EXCLUDED.updated_at
                """,
                (user_id, updated_at),
            )


@pytest.fixture
def client():
    """TestClient with verify_api_key overridden to a real, freshly-created
    user -- mirrors tests/test_api_diary.py's ``client`` fixture."""
    from backend.api.main import app, verify_api_key

    user = _make_user()
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    yield TestClient(app), user
    app.dependency_overrides.pop(verify_api_key, None)


class TestClusteringStatusNoRuns:
    def test_no_completed_run_and_no_cache_returns_dash_no_row_strings(self, client):
        tc, _user = client
        resp = tc.get("/api/clustering/status")
        assert resp.status_code == 200
        assert resp.json() == {
            "run_number": None,
            "title": "CLUSTERING (NO RUNS YET)",
            "stats_line1": "no recluster yet",
            "stats_line2": "",
            "freshness_label": "No cache",
            "freshness_color": "",
        }


class TestClusteringStatusStats:
    def test_completed_run_without_suggestions(self, client):
        tc, user = client
        auth_repo.update_preferences(
            user["id"],
            {"topic_interests": [{"keyword": "astro"}, {"keyword": "baking"}]},
        )
        # 1 cluster of 2 real members + 2 singleton ("noise") clusters ->
        # 4 total members, 2 noise -> 50% noise.
        run_id = _seed_completed_run(user["id"], [2, 1, 1])

        resp = tc.get("/api/clustering/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["run_number"] == run_id
        assert body["title"] == f"CLUSTERING (RUN #{run_id})"
        assert body["stats_line1"] == "3 clusters · 2 topics"
        assert body["stats_line2"] == "50% noise"

    def test_completed_run_with_suggested_groups_appends_suggested_count(self, client):
        tc, user = client
        auth_repo.update_preferences(user["id"], {"topic_interests": [{"keyword": "astro"}]})
        run_id = _seed_completed_run(user["id"], [1, 1])

        cluster_repo.save_super_cluster_groups(
            user["id"],
            run_id,
            [
                {
                    "group_index": 0,
                    "label": "Science",
                    "source": "suggested",
                    "interest_tier": "casual",
                    "member_count": 2,
                    "page_count": 2,
                },
                {
                    "group_index": 1,
                    "label": "Cooking",
                    "source": "suggested",
                    "interest_tier": "casual",
                    "member_count": 1,
                    "page_count": 1,
                },
            ],
        )

        resp = tc.get("/api/clustering/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["stats_line1"] == "2 clusters · 1 topics · 2 suggested"

    def test_completed_run_with_zero_topics_omits_suggested_when_none(self, client):
        tc, user = client
        # No topic_interests set at all -> get_preferences returns {} ->
        # topic_count falls back to 0 via .get("topic_interests", []).
        run_id = _seed_completed_run(user["id"], [1])

        resp = tc.get("/api/clustering/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["run_number"] == run_id
        assert body["stats_line1"] == "1 clusters · 0 topics"
        # Single singleton cluster -> 1 total member, 1 noise -> 100%.
        assert body["stats_line2"] == "100% noise"


class TestClusteringStatusFreshness:
    def test_no_cache_row_returns_no_cache_label(self, client):
        tc, _user = client
        resp = tc.get("/api/clustering/status")
        body = resp.json()
        assert body["freshness_label"] == "No cache"
        assert body["freshness_color"] == ""

    def test_minutes_tier_below_hour_boundary(self, client):
        tc, user = client
        _seed_cache_age(user["id"], minutes_ago=45)

        resp = tc.get("/api/clustering/status")
        body = resp.json()
        assert body["freshness_label"] == "● 45m ago"
        assert body["freshness_color"] == "#4ade80"

    def test_hours_tier_at_and_above_60_minute_boundary(self, client):
        tc, user = client
        _seed_cache_age(user["id"], minutes_ago=90)

        resp = tc.get("/api/clustering/status")
        body = resp.json()
        # 90 minutes -> past the <60 "m ago" branch, into "{h}h ago"
        # (90 // 60 == 1), still within the <1 day green tier.
        assert body["freshness_label"] == "● 1h ago"
        assert body["freshness_color"] == "#4ade80"

    def test_yellow_tier_between_one_and_three_days(self, client):
        tc, user = client
        _seed_cache_age(user["id"], days_ago=2)

        resp = tc.get("/api/clustering/status")
        body = resp.json()
        assert body["freshness_label"] == "● 2d ago"
        assert body["freshness_color"] == "#facc15"

    def test_red_tier_at_five_days_and_above(self, client):
        tc, user = client
        _seed_cache_age(user["id"], days_ago=6)

        resp = tc.get("/api/clustering/status")
        body = resp.json()
        assert body["freshness_label"] == "● 6d ago"
        assert body["freshness_color"] == "#ef4444"


class TestClusteringStatusAuth:
    def test_unauthed_request_rejected_in_prod_mode(self, monkeypatch):
        """Force production-mode auth -- the dev bypass (default in tests)
        would otherwise resolve a default user and never exercise the auth
        gate at all. Mirrors tests/test_api_diary.py's prod-mode pattern."""
        from backend.api.main import app
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "production")
        tc = TestClient(app)

        resp = tc.get("/api/clustering/status")
        assert resp.status_code == 401
