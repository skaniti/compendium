"""Regression test for page_repo.get_time_windows' filter_node_id contract.

Rethink R7.2 ("No pages yet." diary-filter bug): a page-dot tap on the D3
canvas sends the GRAPH node id -- for a page leaf that's
``graph_builder._slugify(title)`` (see ``backend/services/graph_builder.py``,
``leaf_id = _slugify(title)``), which is byte-identical to the ``_slugify``
defined in ``backend/db/page_repo.py`` and already used to build each
window's ``graph_node_ids``. ``get_time_windows``'s SQL-level filter used to
only compare ``filter_node_id`` against ``p.id::text`` and ``cluster_slug``
-- never the title slug -- so every page-dot click filtered to zero rows
and the diary showed "No pages yet." regardless of which page was clicked.

Requires Docker PostgreSQL running (same as tests/test_repos.py):
    docker compose up -d
    python -m backend.db.migrate
    pytest tests/test_page_repo_time_windows.py -v
"""

from datetime import datetime, timezone

import pytest


def _pg_reachable() -> bool:
    """Check if the test PostgreSQL database is reachable."""
    try:
        from backend.config.settings import settings

        url = settings.test_database_url
        if not url.startswith("postgresql"):
            return False
        from psycopg2 import connect

        conn = connect(url)
        conn.close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _pg_reachable(),
    reason="Test PostgreSQL not reachable — run `docker compose up -d` and `python scripts/init_test_db.py`",
)

from backend.db import capture_repo, cluster_repo, page_repo, recluster_repo, user_repo
from backend.db.connection import get_conn
from backend.services.graph_builder import _slugify as graph_builder_slugify


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


def _make_user(email="test@example.com"):
    return user_repo.create_user(email, name="Test User")


def _make_capture(user_id, capture_id="cap_001"):
    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture_id,
        source="desktop_active",
        started_at=datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 3, 15, 11, 0, tzinfo=timezone.utc),
    )


class TestGetTimeWindowsFilterNodeId:
    def test_filter_by_page_title_slug_matches_the_graph_node_id_format(self):
        """The id a page-dot tap actually sends (graph_builder._slugify(title))
        must return the window containing that page -- this is the exact
        id vocabulary the D3 canvas uses, not a numeric page id or a
        cluster slug."""
        user = _make_user()
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

        # This is the exact id the graph sends for a page-dot tap (see
        # graph_builder.build_graph_from_db: leaf_id = _slugify(title)).
        tapped_node_id = graph_builder_slugify("Black hole")
        assert tapped_node_id == "black_hole"  # sanity: this is a slug, not a page id

        windows = page_repo.get_time_windows(
            user["id"], "day", filter_node_id=tapped_node_id
        )
        assert len(windows) == 1, (
            f"expected the page's window to be returned when filtering by its "
            f"graph node id {tapped_node_id!r}, got {len(windows)} windows"
        )
        assert windows[0]["page_count"] == 1
        assert tapped_node_id in windows[0]["graph_node_ids"]

    def test_filter_by_unrelated_slug_returns_no_windows(self):
        """Negative case: a slug that matches nothing should still yield
        zero windows (genuinely empty, not a false positive)."""
        user = _make_user()
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

        windows = page_repo.get_time_windows(
            user["id"], "day", filter_node_id="some_other_page_entirely"
        )
        assert windows == []

    def test_filter_by_cluster_slug_still_works(self):
        """Regression guard: the pre-existing cluster-slug match (tag-pill
        clicks) must keep working after the id-vocabulary fix."""
        user = _make_user()
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

        run_id = recluster_repo.start_run(user["id"])
        slug_map = cluster_repo.save_clusters(
            user["id"],
            run_id,
            [{"cluster_slug": "astrophysics", "cluster_name": "Astrophysics"}],
        )
        cluster_repo.save_page_clusters([(ids[0], slug_map["astrophysics"])])
        recluster_repo.complete_run(
            run_id,
            cluster_count=1,
            noise_count=0,
            naming_cost=0.0,
            elapsed_seconds=0.1,
        )

        windows = page_repo.get_time_windows(
            user["id"], "day", filter_node_id="astrophysics"
        )
        assert len(windows) == 1
        assert windows[0]["page_count"] == 1

    def test_filter_by_numeric_page_id_still_works(self):
        """Regression guard: the pre-existing p.id::text match (older/direct
        callers) must keep working after the id-vocabulary fix."""
        user = _make_user()
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

        windows = page_repo.get_time_windows(
            user["id"], "day", filter_node_id=str(ids[0])
        )
        assert len(windows) == 1
        assert windows[0]["page_count"] == 1


class TestGetTimeWindowsWindowLevelSemantics:
    """Pin the WINDOW-level filter granularity (2026-07-17 review finding).

    The pre-fix SQL filter was ROW-level: a matched window surfaced only its
    matching rows. The post-aggregation filter is WINDOW-level: one match in
    any id vocabulary returns the WHOLE window -- all pages, tags, counts.
    That is ``render_session_diary``'s documented contract ("filter_node_id:
    If set, only show windows containing this node" -- windows are the
    filter unit), and it applies to ALL THREE id vocabularies. These tests
    use multi-page windows where only ONE page matches, so a future "fix"
    back to row-level filtering (page_count == 1) trips them.
    """

    def _seed_two_page_window(self):
        """One day-window with two active pages; only page A gets clustered."""
        user = _make_user()
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
                    "visited_at": datetime(2026, 3, 15, 14, 30, tzinfo=timezone.utc),
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
        # Only the FIRST page joins the cluster; "Sourdough" stays unclustered.
        cluster_repo.save_page_clusters([(ids[0], slug_map["astrophysics"])])
        recluster_repo.complete_run(
            run_id,
            cluster_count=1,
            noise_count=1,
            naming_cost=0.0,
            elapsed_seconds=0.1,
        )
        return user, ids

    def _assert_whole_window(self, windows, ids):
        assert len(windows) == 1
        w = windows[0]
        assert w["page_count"] == 2, (
            f"expected the WHOLE window (2 pages), got page_count="
            f"{w['page_count']} -- row-level filtering has crept back in"
        )
        assert set(w["node_ids"]) == {str(ids[0]), str(ids[1])}
        assert set(w["graph_node_ids"]) == {"black_hole", "sourdough"}

    def test_cluster_slug_match_returns_whole_window(self):
        """Filter by cluster slug matching only 1 of 2 pages -> both pages."""
        user, ids = self._seed_two_page_window()
        windows = page_repo.get_time_windows(
            user["id"], "day", filter_node_id="astrophysics"
        )
        self._assert_whole_window(windows, ids)

    def test_numeric_page_id_match_returns_whole_window(self):
        """Filter by one page's numeric id -> both pages in its window."""
        user, ids = self._seed_two_page_window()
        windows = page_repo.get_time_windows(
            user["id"], "day", filter_node_id=str(ids[0])
        )
        self._assert_whole_window(windows, ids)

    def test_title_slug_match_returns_whole_window(self):
        """Filter by one page's title slug (page-dot tap) -> both pages."""
        user, ids = self._seed_two_page_window()
        windows = page_repo.get_time_windows(
            user["id"], "day", filter_node_id="black_hole"
        )
        self._assert_whole_window(windows, ids)
