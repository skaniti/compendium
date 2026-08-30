"""Endpoint contract tests for GET /api/diary/windows (migration batch 02,
task 1) -- the first of four thin read endpoints ported for the Next.js
session-diary panel.

Thin wrapper: the endpoint hands off to page_repo.get_time_windows and
serializes its dicts verbatim. This suite exercises the ENDPOINT (auth
wiring, granularity validation, filter pass-through) rather than the
repo's own aggregation/id-vocabulary logic, which is covered exhaustively
by tests/test_page_repo_time_windows.py. Both `node_ids` (numeric page ids
as text) and `graph_node_ids` (title slugs) are asserted per-window since
the live consumer (frontend/dash/layouts/session_diary.py) and the
repo docstring both document the two keys coexisting.
"""

from datetime import datetime, timezone

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
                         clusters, recluster_runs, pages, page_content,
                         captures, users
                CASCADE
                """
            )
    yield


def _make_user(email="diary@example.com"):
    return user_repo.create_user(email, name="Diary User")


def _make_capture(user_id, capture_id="cap_diary_001"):
    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture_id,
        source="desktop_active",
        started_at=datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 3, 15, 11, 0, tzinfo=timezone.utc),
    )


@pytest.fixture
def client():
    """TestClient with verify_api_key overridden to a real, freshly-created
    user -- mirrors the mocked_client pattern in tests/test_agent_api.py /
    tests/test_topic_exclusions_api.py. A real user_id is needed (rather
    than a bare constant) because these tests seed real rows via
    page_repo/capture_repo/cluster_repo and exercise the real DB-backed
    get_time_windows call, not a mocked repo.
    """
    from backend.api.main import app, verify_api_key

    user = _make_user()
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    yield TestClient(app), user
    app.dependency_overrides.pop(verify_api_key, None)


class TestDiaryWindows:
    def test_authed_request_returns_windows_with_expected_shape(self, client):
        tc, user = client
        cap = _make_capture(user["id"])
        ids = page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": "https://en.wikipedia.org/wiki/Black_hole",
                    "title": "Black hole",
                    "domain": "en.wikipedia.org",
                    "visited_at": datetime(2026, 3, 15, 10, 5, tzinfo=timezone.utc),
                },
            ],
        )
        page_repo.update_page_status(ids[0], "active")

        resp = tc.get("/api/diary/windows")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        assert len(body) == 1
        window = body[0]
        assert window["key"]
        assert window["label"]
        # Both id-vocabulary keys must be present verbatim (spec correction:
        # node_ids -- numeric page ids as text -- AND graph_node_ids --
        # title slugs -- coexist; neither is a stand-in for the other).
        assert str(ids[0]) in window["node_ids"]
        assert "black_hole" in window["graph_node_ids"]
        assert window["page_count"] == 1
        assert window["cluster_freq"] == {}
        assert window["cluster_names"] == {}

    def test_week_granularity_groups_differently_from_day(self, client):
        tc, user = client
        cap = _make_capture(user["id"])
        # 2026-03-16 and 2026-03-18 are different calendar days but the
        # same ISO week (2026-W12) -- verified via date(...).isocalendar().
        ids = page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": "https://en.wikipedia.org/wiki/Black_hole",
                    "title": "Black hole",
                    "domain": "en.wikipedia.org",
                    "visited_at": datetime(2026, 3, 16, 10, 5, tzinfo=timezone.utc),
                },
                {
                    "url": "https://en.wikipedia.org/wiki/Sourdough",
                    "title": "Sourdough",
                    "domain": "en.wikipedia.org",
                    "visited_at": datetime(2026, 3, 18, 14, 30, tzinfo=timezone.utc),
                },
            ],
        )
        for pid in ids:
            page_repo.update_page_status(pid, "active")

        day_resp = tc.get("/api/diary/windows", params={"granularity": "day"})
        week_resp = tc.get("/api/diary/windows", params={"granularity": "week"})
        assert day_resp.status_code == 200
        assert week_resp.status_code == 200
        day_windows = day_resp.json()
        week_windows = week_resp.json()

        assert len(day_windows) == 2
        assert len(week_windows) == 1
        assert week_windows[0]["page_count"] == 2
        assert {w["key"] for w in day_windows} != {w["key"] for w in week_windows}

    def test_invalid_granularity_rejected(self, client):
        tc, _ = client
        resp = tc.get("/api/diary/windows", params={"granularity": "year"})
        assert resp.status_code == 422

    def test_filter_node_id_by_cluster_slug_passes_through(self, client):
        """One filter case proving the endpoint passes filter_node_id
        through to the repo untouched -- the repo's own three-vocabulary
        matching logic is exercised exhaustively in
        tests/test_page_repo_time_windows.py, not re-tested here."""
        tc, user = client
        cap = _make_capture(user["id"])
        ids = page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": "https://en.wikipedia.org/wiki/Black_hole",
                    "title": "Black hole",
                    "domain": "en.wikipedia.org",
                    "visited_at": datetime(2026, 3, 15, 10, 5, tzinfo=timezone.utc),
                },
                {
                    "url": "https://en.wikipedia.org/wiki/Sourdough",
                    "title": "Sourdough",
                    "domain": "en.wikipedia.org",
                    "visited_at": datetime(2026, 3, 20, 9, 0, tzinfo=timezone.utc),
                },
            ],
        )
        for pid in ids:
            page_repo.update_page_status(pid, "active")

        run_id = recluster_repo.start_run(user["id"])
        slug_map = cluster_repo.save_clusters(
            user["id"],
            run_id,
            [{"cluster_slug": "astrophysics", "cluster_name": "Astrophysics"}],
        )
        # Only the Black hole page joins the cluster; the Sourdough page
        # (a different day's window) stays unclustered.
        cluster_repo.save_page_clusters([(ids[0], slug_map["astrophysics"])])
        recluster_repo.complete_run(
            run_id,
            cluster_count=1,
            noise_count=1,
            naming_cost=0.0,
            elapsed_seconds=0.1,
        )

        resp = tc.get("/api/diary/windows", params={"filter_node_id": "astrophysics"})
        assert resp.status_code == 200
        windows = resp.json()
        assert len(windows) == 1
        assert windows[0]["page_count"] == 1
        assert "black_hole" in windows[0]["graph_node_ids"]


class TestDiaryWindowsAuth:
    def test_unauthed_request_rejected_in_prod_mode(self, monkeypatch):
        """Force production-mode auth -- the dev bypass (default in tests)
        would otherwise resolve a default user and never exercise the
        auth gate at all. Mirrors tests/test_api_view_as.py's prod_auth
        fixture pattern. No Authorization/X-API-Key header is sent, so
        verify_api_key must 401 rather than fall through to a dev user."""
        from backend.api.main import app
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "production")
        tc = TestClient(app)

        resp = tc.get("/api/diary/windows")
        assert resp.status_code == 401
