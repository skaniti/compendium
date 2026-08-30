"""Endpoint contract tests for GET /api/graph's `window` param (migration
batch 03, task R2) -- the time-window filter the Next.js graph canvas binds
its window pills to.

Two behaviors are under test, both mirroring Dash callbacks rather than the
endpoint's old ``load_graph`` (cache-read) semantics:

  - ``window=all`` rebuilds from Postgres and writes ``graph_cache``, matching
    ``refresh_graph_on_load`` (frontend/dash/callbacks/graph.py:16-35), whose
    per-page-load rebuild is what keeps the Dash graph from serving stale
    structure after a topic mutation (02 results.md deferred ruling M4).
  - ``window=7|30|90|365`` rebuilds with ``visited_after`` and deliberately
    does NOT write the cache, matching ``filter_graph_by_time_window``
    (callbacks/graph.py:78-108) -- a filtered view must never become the
    cached full graph.

The graph-building itself (bucket allocation, slug ids, edges) is covered by
tests/test_graph_builder*.py; this suite asserts the endpoint's param
validation, its cache side effects, and that the filtered payload is
byte-identical to a direct ``build_graph_from_db(visited_after=...)`` build.
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

from backend.db import capture_repo, graph_repo, page_repo, user_repo
from backend.db.connection import get_conn
from backend.models.graph import KnowledgeGraph
from backend.services.graph_builder import build_graph_from_db
from backend.utils.graph_export import to_d3_elements


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


@pytest.fixture
def client():
    """TestClient with verify_api_key overridden to a real, freshly-created
    user -- these tests seed real rows and exercise the real DB-backed
    build/save path, so a bare constant user_id would not do.
    """
    from backend.api.main import app, verify_api_key

    user = user_repo.create_user("graphwindow@example.com", name="Graph Window User")
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    yield TestClient(app), user
    app.dependency_overrides.pop(verify_api_key, None)


def _seed_pages(user_id):
    """Seed one recent page (inside every window) and one old page (outside
    all but ``all``). Both are far from any window boundary so the endpoint's
    request-time ``now`` and the test's own ``now`` cannot disagree.

    Returns (recent_page_id, old_page_id).
    """
    now = datetime.now(timezone.utc)
    cap = capture_repo.save_capture(
        user_id=user_id,
        capture_id="cap_graph_window_001",
        source="desktop_active",
        started_at=now - timedelta(days=400),
        ended_at=now,
    )
    ids = page_repo.insert_pages(
        cap["id"],
        [
            {
                "url": "https://en.wikipedia.org/wiki/Black_hole",
                "title": "Black hole",
                "domain": "en.wikipedia.org",
                "visited_at": now - timedelta(days=2),
            },
            {
                "url": "https://en.wikipedia.org/wiki/Sourdough",
                "title": "Sourdough",
                "domain": "en.wikipedia.org",
                "visited_at": now - timedelta(days=200),
            },
        ],
    )
    for pid in ids:
        page_repo.update_page_status(pid, "active")
    return ids[0], ids[1]


class TestGraphWindowValidation:
    @pytest.mark.parametrize("bad", ["year", "14", "0", "-7", "7d", ""])
    def test_unsupported_window_rejected(self, client, bad):
        tc, _ = client
        resp = tc.get("/api/graph", params={"window": bad})
        assert resp.status_code == 422

    @pytest.mark.parametrize("good", ["all", "7", "30", "90", "365"])
    def test_supported_windows_accepted(self, client, good):
        tc, user = client
        _seed_pages(user["id"])
        resp = tc.get("/api/graph", params={"window": good})
        assert resp.status_code == 200
        assert "nodes" in resp.json()

    def test_window_defaults_to_all(self, client):
        tc, user = client
        _seed_pages(user["id"])
        assert tc.get("/api/graph").json() == tc.get(
            "/api/graph", params={"window": "all"}
        ).json()


class TestGraphWindowAllRebuildsCache:
    def test_window_all_persists_fresh_cache_row(self, client):
        """No cache row exists after the truncate; the call must create one
        holding the freshly-built graph."""
        tc, user = client
        _seed_pages(user["id"])
        assert graph_repo.load_graph_cache(user["id"]) is None

        resp = tc.get("/api/graph", params={"window": "all"})
        assert resp.status_code == 200

        cached = graph_repo.load_graph_cache(user["id"])
        assert cached is not None
        cached_ids = {n["id"] for n in cached["nodes"]}
        assert cached_ids == {"black_hole", "sourdough"}

    def test_window_all_overwrites_a_stale_cache_row(self, client):
        """The M4 closure: a stale ``graph_cache`` (written before a topic
        mutation repainted clusters) must not be served, and must be
        replaced by the fresh build."""
        tc, user = client
        _seed_pages(user["id"])
        graph_repo.save_graph_cache(user["id"], KnowledgeGraph().model_dump())
        assert graph_repo.load_graph_cache(user["id"])["nodes"] == []

        body = tc.get("/api/graph", params={"window": "all"}).json()

        assert {n["id"] for n in body["nodes"]} == {"black_hole", "sourdough"}
        assert {n["id"] for n in graph_repo.load_graph_cache(user["id"])["nodes"]} == {
            "black_hole",
            "sourdough",
        }


class TestGraphWindowFiltered:
    def test_filtered_call_does_not_touch_graph_cache(self, client):
        """A filtered view is never cached -- neither the payload nor the
        row's ``updated_at`` may move."""
        tc, user = client
        _seed_pages(user["id"])
        graph_repo.save_graph_cache(user["id"], KnowledgeGraph().model_dump())
        before = graph_repo.load_graph_cache(user["id"])
        before_updated_at = graph_repo.get_cache_updated_at(user["id"])

        resp = tc.get("/api/graph", params={"window": "7"})
        assert resp.status_code == 200

        assert graph_repo.load_graph_cache(user["id"]) == before
        assert graph_repo.get_cache_updated_at(user["id"]) == before_updated_at

    def test_filtered_response_ignores_the_cache(self, client):
        """The stale empty cache above would produce an empty payload if the
        endpoint still read ``load_graph``; the filtered build must win."""
        tc, user = client
        _seed_pages(user["id"])
        graph_repo.save_graph_cache(user["id"], KnowledgeGraph().model_dump())

        body = tc.get("/api/graph", params={"window": "7"}).json()

        assert {n["id"] for n in body["nodes"]} == {"black_hole"}

    def test_filtered_topology_matches_direct_build(self, client):
        tc, user = client
        _seed_pages(user["id"])

        body = tc.get("/api/graph", params={"window": "30"}).json()

        expected = to_d3_elements(
            build_graph_from_db(
                user["id"],
                visited_after=datetime.now(timezone.utc) - timedelta(days=30),
            ),
            user["id"],
        )
        assert body == expected

    def test_filtered_window_drops_pages_outside_it(self, client):
        """Guards the direct-build comparison above from passing vacuously:
        the 30-day window must actually be narrower than ``all``."""
        tc, user = client
        _seed_pages(user["id"])

        filtered = tc.get("/api/graph", params={"window": "30"}).json()
        full = tc.get("/api/graph", params={"window": "all"}).json()

        assert {n["id"] for n in filtered["nodes"]} == {"black_hole"}
        assert {n["id"] for n in full["nodes"]} == {"black_hole", "sourdough"}


class TestGraphWindowAuth:
    def test_unauthed_request_rejected_in_prod_mode(self, monkeypatch):
        """Force production-mode auth -- the dev bypass (default in tests)
        would otherwise resolve a default user and never exercise the auth
        gate. Mirrors tests/test_api_diary.py's prod-mode case."""
        from backend.api.main import app
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "production")
        tc = TestClient(app)

        resp = tc.get("/api/graph", params={"window": "7"})
        assert resp.status_code == 401
