"""Endpoint contract tests for GET /api/topics/{keyword}/members (migration
batch 02, task 8, deliverable 1).

Thin read wrapper over cluster_repo.get_top_clusters_for_keyword -- scoped
to the latest COMPLETED recluster run, ordered by mean_membership_probability
DESC NULLS LAST, then page_count DESC, then cluster_name (fully
deterministic tie order, see that function's docstring). Serves both the
hover tooltip (limit=5) and the popover's fuller member list
(SC_POPOVER_MEMBER_CAP=50, frontend/dash/callbacks/topics.py:636).
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

from backend.db import capture_repo, cluster_repo, page_repo, recluster_repo, user_repo
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


def _make_user(email="members@example.com"):
    return user_repo.create_user(email, name="Members User")


def _make_capture(user_id, capture_id="cap_members_001"):
    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture_id,
        source="desktop_active",
        started_at=datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 3, 15, 11, 0, tzinfo=timezone.utc),
    )


def _make_pages(capture_db_id, count, url_prefix="https://en.wikipedia.org/wiki/Page"):
    base = datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc)
    pages = [
        {
            "url": f"{url_prefix}_{i}",
            "title": f"Page {i}",
            "domain": "en.wikipedia.org",
            "visited_at": base + timedelta(seconds=i + 1),
        }
        for i in range(count)
    ]
    ids = page_repo.insert_pages(capture_db_id, pages)
    for pid in ids:
        page_repo.update_page_status(pid, "active")
    return ids


def _seed_run_with_clusters(user_id, clusters_spec, *, completed_at=None, cap=None):
    """Seed a completed recluster run with clusters per *clusters_spec*.

    Each spec dict: cluster_slug, cluster_name, super_cluster (the
    supercluster keyword the cluster is painted with),
    mean_membership_probability (optional, None if omitted), page_count
    (optional, default 0 -- real pages/page_clusters rows are only created
    when > 0, since page_clusters.page_id FKs to a real pages row).

    *completed_at*, if given, overrides the completed_at NOW() default so
    ordering between multiple runs can be made deterministic rather than
    relying on real-clock deltas between sequential calls.
    """
    if cap is None:
        cap = _make_capture(user_id, capture_id=f"cap_members_{user_id}")
    run_id = recluster_repo.start_run(user_id)

    cluster_dicts = [
        {
            "cluster_slug": c["cluster_slug"],
            "cluster_name": c["cluster_name"],
            "mean_membership_probability": c.get("mean_membership_probability"),
        }
        for c in clusters_spec
    ]
    slug_to_id = cluster_repo.save_clusters(user_id, run_id, cluster_dicts)
    cluster_repo.update_super_clusters(
        user_id, {slug_to_id[c["cluster_slug"]]: c["super_cluster"] for c in clusters_spec}
    )

    total_pages_needed = sum(c.get("page_count", 0) for c in clusters_spec)
    if total_pages_needed:
        page_ids = _make_pages(cap["id"], total_pages_needed)
        idx = 0
        pairs = []
        for c in clusters_spec:
            cid = slug_to_id[c["cluster_slug"]]
            for _ in range(c.get("page_count", 0)):
                pairs.append((page_ids[idx], cid))
                idx += 1
        cluster_repo.save_page_clusters(pairs)

    recluster_repo.complete_run(
        run_id,
        cluster_count=len(clusters_spec),
        noise_count=0,
        naming_cost=0.0,
        elapsed_seconds=1.0,
    )

    if completed_at is not None:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE recluster_runs SET completed_at = %s WHERE id = %s",
                    (completed_at, run_id),
                )

    return run_id


@pytest.fixture
def client():
    """TestClient with verify_api_key overridden to a real, freshly-created
    user -- mirrors tests/test_api_diary.py's ``client`` fixture. A real
    user_id is needed because these tests exercise the real DB-backed
    cluster_repo.get_top_clusters_for_keyword call, not a mocked repo.
    """
    from backend.api.main import app, verify_api_key

    user = _make_user()
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    yield TestClient(app), user
    app.dependency_overrides.pop(verify_api_key, None)


class TestMembersShape:
    def test_authed_returns_exact_shape(self, client):
        tc, user = client
        _seed_run_with_clusters(
            user["id"],
            [
                {
                    "cluster_slug": "astro_101",
                    "cluster_name": "Astro 101",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.75,
                    "page_count": 2,
                }
            ],
        )

        resp = tc.get("/api/topics/science/members")
        assert resp.status_code == 200
        assert resp.json() == {
            "members": [
                {
                    "cluster_name": "Astro 101",
                    "page_count": 2,
                    "mean_membership_probability": 0.75,
                }
            ]
        }

    def test_unknown_keyword_returns_empty_list(self, client):
        tc, user = client
        _seed_run_with_clusters(
            user["id"],
            [
                {
                    "cluster_slug": "astro_101",
                    "cluster_name": "Astro 101",
                    "super_cluster": "science",
                }
            ],
        )

        resp = tc.get("/api/topics/nonexistent-keyword/members")
        assert resp.status_code == 200
        assert resp.json() == {"members": []}


class TestMembersOrdering:
    def test_ordered_by_probability_desc_nulls_last_then_page_count(self, client):
        tc, user = client
        _seed_run_with_clusters(
            user["id"],
            [
                {
                    "cluster_slug": "cluster_a",
                    "cluster_name": "Cluster A",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.9,
                    "page_count": 1,
                },
                {
                    "cluster_slug": "cluster_b",
                    "cluster_name": "Cluster B",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.9,
                    "page_count": 5,
                },
                {
                    "cluster_slug": "cluster_c",
                    "cluster_name": "Cluster C",
                    "super_cluster": "science",
                    "mean_membership_probability": None,
                    "page_count": 100,
                },
                {
                    "cluster_slug": "cluster_d",
                    "cluster_name": "Cluster D",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.5,
                    "page_count": 1,
                },
            ],
        )

        resp = tc.get("/api/topics/science/members")
        assert resp.status_code == 200
        names = [m["cluster_name"] for m in resp.json()["members"]]
        # B ties A on probability (0.9) but has more pages -> B before A.
        # D (0.5) ranks below both. C (NULL probability) sorts last
        # regardless of its large page_count.
        assert names == ["Cluster B", "Cluster A", "Cluster D", "Cluster C"]

    def test_ties_on_probability_and_page_count_break_by_name(self, client):
        tc, user = client
        _seed_run_with_clusters(
            user["id"],
            [
                {
                    "cluster_slug": "beta",
                    "cluster_name": "Beta",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.3,
                    "page_count": 2,
                },
                {
                    "cluster_slug": "alpha",
                    "cluster_name": "Alpha",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.3,
                    "page_count": 2,
                },
            ],
        )

        resp = tc.get("/api/topics/science/members")
        names = [m["cluster_name"] for m in resp.json()["members"]]
        assert names == ["Alpha", "Beta"]


class TestMembersLimit:
    def test_limit_honored(self, client):
        tc, user = client
        _seed_run_with_clusters(
            user["id"],
            [
                {
                    "cluster_slug": f"cluster_{i}",
                    "cluster_name": f"Cluster {i}",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.1 * i,
                }
                for i in range(5)
            ],
        )

        resp = tc.get("/api/topics/science/members", params={"limit": 2})
        assert resp.status_code == 200
        assert len(resp.json()["members"]) == 2

    def test_limit_below_minimum_rejected(self, client):
        tc, _user = client
        resp = tc.get("/api/topics/science/members", params={"limit": 0})
        assert resp.status_code == 422

    def test_limit_above_maximum_rejected(self, client):
        tc, _user = client
        resp = tc.get("/api/topics/science/members", params={"limit": 201})
        assert resp.status_code == 422

    def test_default_limit_is_fifty(self, client):
        tc, user = client
        _seed_run_with_clusters(
            user["id"],
            [
                {
                    "cluster_slug": f"cluster_{i}",
                    "cluster_name": f"Cluster {i}",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.001 * i,
                }
                for i in range(60)
            ],
        )

        resp = tc.get("/api/topics/science/members")
        assert resp.status_code == 200
        assert len(resp.json()["members"]) == 50


class TestMembersRunScoping:
    def test_only_latest_completed_run_returned(self, client):
        tc, user = client
        cap = _make_capture(user["id"])
        _seed_run_with_clusters(
            user["id"],
            [
                {
                    "cluster_slug": "old_cluster",
                    "cluster_name": "Old Cluster",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.9,
                }
            ],
            completed_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            cap=cap,
        )
        _seed_run_with_clusters(
            user["id"],
            [
                {
                    "cluster_slug": "new_cluster",
                    "cluster_name": "New Cluster",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.5,
                }
            ],
            completed_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
            cap=cap,
        )

        resp = tc.get("/api/topics/science/members")
        names = [m["cluster_name"] for m in resp.json()["members"]]
        assert names == ["New Cluster"]


class TestMembersUserScoping:
    def test_other_users_clusters_invisible(self, client):
        tc, user = client
        other = _make_user(email="other-members@example.com")
        _seed_run_with_clusters(
            other["id"],
            [
                {
                    "cluster_slug": "other_cluster",
                    "cluster_name": "Other Cluster",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.9,
                }
            ],
        )
        _seed_run_with_clusters(
            user["id"],
            [
                {
                    "cluster_slug": "mine_cluster",
                    "cluster_name": "Mine Cluster",
                    "super_cluster": "science",
                    "mean_membership_probability": 0.5,
                }
            ],
        )

        resp = tc.get("/api/topics/science/members")
        names = [m["cluster_name"] for m in resp.json()["members"]]
        assert names == ["Mine Cluster"]


class TestMembersAuth:
    def test_unauthed_request_rejected_in_prod_mode(self, monkeypatch):
        """Force production-mode auth -- the dev bypass (default in tests)
        would otherwise resolve a default user and never exercise the auth
        gate at all. Mirrors tests/test_api_diary.py's / test_api_clustering_
        status.py's prod-mode pattern."""
        from backend.api.main import app
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "production")
        tc = TestClient(app)

        resp = tc.get("/api/topics/science/members")
        assert resp.status_code == 401
