"""Tests for PostgreSQL repository modules.

Requires Docker PostgreSQL running: docker compose up -d
Then: python -m backend.db.migrate
Then: pytest tests/test_repos.py -v
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


# Skip entire module if PostgreSQL is not reachable
pytestmark = pytest.mark.skipif(
    not _pg_reachable(),
    reason="Test PostgreSQL not reachable — run `docker compose up -d` and `python scripts/init_test_db.py`",
)

from backend.db import (
    capture_repo,
    cluster_repo,
    content_repo,
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
                         clusters, recluster_runs, pages, page_content,
                         captures, users
                CASCADE
                """
            )
    yield


# ── Helpers ─────────────────────────────────────────────────────────────


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


# ── User repo ──────────────────────────────────────────────────────────


class TestUserRepo:
    def test_create_and_lookup(self):
        result = _make_user()
        assert result["id"] > 0
        assert result["email"] == "test@example.com"
        assert result["api_key"].startswith("cmp_")

        # Lookup by API key
        found = user_repo.get_user_by_api_key(result["api_key"])
        assert found is not None
        assert found["id"] == result["id"]

    def test_wrong_key_returns_none(self):
        _make_user()
        assert user_repo.get_user_by_api_key("cmp_wrong_key_here") is None

    def test_get_by_id(self):
        result = _make_user()
        found = user_repo.get_user_by_id(result["id"])
        assert found is not None
        assert found["email"] == "test@example.com"

    def test_rotate_api_key_issues_new_key_and_invalidates_old(self):
        original = _make_user()

        rotated = user_repo.rotate_api_key("test@example.com")
        assert rotated is not None
        assert rotated["id"] == original["id"]
        assert rotated["api_key"].startswith("cmp_")
        assert rotated["api_key"] != original["api_key"]
        assert rotated["api_key_prefix"] != original["api_key_prefix"]

        # Old key no longer authenticates; new key does.
        assert user_repo.get_user_by_api_key(original["api_key"]) is None
        found = user_repo.get_user_by_api_key(rotated["api_key"])
        assert found is not None
        assert found["id"] == original["id"]

    def test_rotate_api_key_unknown_email_returns_none(self):
        assert user_repo.rotate_api_key("nobody@example.com") is None


# ── Capture repo ────────────────────────────────────────────────────────


class TestCaptureRepo:
    def test_save_and_get(self):
        user = _make_user()
        cap = _make_capture(user["id"])
        assert cap["id"] > 0
        assert cap["capture_id"] == "cap_001"

        found = capture_repo.get_capture("cap_001")
        assert found is not None
        assert found["source"] == "desktop_active"

    def test_list_captures(self):
        user = _make_user()
        _make_capture(user["id"], "cap_a")
        _make_capture(user["id"], "cap_b")
        caps = capture_repo.list_captures(user["id"])
        assert len(caps) == 2

    def test_update_capture(self):
        user = _make_user()
        cap = _make_capture(user["id"])
        capture_repo.update_capture(cap["id"], title="New Title")
        found = capture_repo.get_capture("cap_001")
        assert found["title"] == "New Title"


# ── Content repo ────────────────────────────────────────────────────────


class TestContentRepo:
    def test_get_or_create_dedup(self):
        first = content_repo.get_or_create_content(
            "https://en.wikipedia.org/wiki/Black_hole",
            extracted_text="A black hole is...",
        )
        assert first["is_new"] is True

        second = content_repo.get_or_create_content(
            "https://en.wikipedia.org/wiki/Black_hole",
        )
        assert second["is_new"] is False
        assert second["id"] == first["id"]


# ── Page repo ───────────────────────────────────────────────────────────


class TestPageRepo:
    def test_insert_and_query(self):
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
                    "url": "https://youtube.com/watch?v=abc",
                    "title": "Black Holes Explained",
                    "domain": "youtube.com",
                    "visited_at": datetime(2026, 3, 15, 10, 15, tzinfo=timezone.utc),
                },
            ],
        )
        assert len(ids) == 2

        pages = page_repo.get_pages_for_capture(cap["id"])
        assert len(pages) == 2
        assert pages[0]["title"] == "Black hole"

    def test_update_status(self):
        user = _make_user()
        cap = _make_capture(user["id"])
        ids = page_repo.insert_pages(
            cap["id"],
            [
                {"url": "https://example.com", "title": "Test"},
            ],
        )
        page_repo.update_page_status(ids[0], "active", processing_depth="processed")
        pages = page_repo.get_pages_for_capture(cap["id"])
        assert pages[0]["status"] == "active"
        assert pages[0]["processing_depth"] == "processed"

    def test_archive_and_restore(self):
        user = _make_user()
        cap = _make_capture(user["id"])
        ids = page_repo.insert_pages(
            cap["id"],
            [
                {"url": "https://example.com", "title": "Test"},
            ],
        )
        page_repo.update_page_status(ids[0], "active")
        page_repo.archive_page(ids[0], "skip_gate")
        pages = page_repo.get_pages_for_capture(cap["id"])
        assert pages[0]["status"] == "archived"

        page_repo.restore_page(ids[0])
        pages = page_repo.get_pages_for_capture(cap["id"])
        assert pages[0]["status"] == "active"


# ── Recluster + cluster repos ──────────────────────────────────────────


class TestClusterRepo:
    def test_full_recluster_lifecycle(self):
        user = _make_user()
        cap = _make_capture(user["id"])
        page_ids = page_repo.insert_pages(
            cap["id"],
            [
                {"url": "https://a.com", "title": "Page A"},
                {"url": "https://b.com", "title": "Page B"},
            ],
        )
        for pid in page_ids:
            page_repo.update_page_status(pid, "active")

        # Start run
        run_id = recluster_repo.start_run(user["id"])
        assert run_id > 0

        # Save clusters
        slug_map = cluster_repo.save_clusters(
            user["id"],
            run_id,
            [
                {"cluster_slug": "black_holes", "cluster_name": "Black Holes"},
                {"cluster_slug": "quantum", "cluster_name": "Quantum Physics"},
            ],
        )
        assert "black_holes" in slug_map

        # Save page↔cluster associations
        cluster_repo.save_page_clusters(
            [
                (page_ids[0], slug_map["black_holes"]),
                (page_ids[1], slug_map["quantum"]),
            ]
        )

        # Save edges
        cluster_repo.save_edges(
            run_id,
            [
                {
                    "source_cluster_id": slug_map["black_holes"],
                    "target_cluster_id": slug_map["quantum"],
                    "weight": 0.75,
                },
            ],
        )

        # Complete run
        recluster_repo.complete_run(
            run_id,
            cluster_count=2,
            noise_count=0,
            naming_cost=0.001,
            elapsed_seconds=1.5,
        )

        # Verify queries
        clusters = cluster_repo.get_clusters_for_user(user["id"])
        assert len(clusters) == 2

        edges = cluster_repo.get_edges(user["id"])
        assert len(edges) == 1
        assert edges[0]["weight"] == pytest.approx(0.75)

        latest = recluster_repo.get_latest_run(user["id"])
        assert latest is not None
        assert latest["cluster_count"] == 2


# ── Graph cache repo ────────────────────────────────────────────────────


class TestGraphRepo:
    def test_save_and_load(self):
        user = _make_user()
        data = {"nodes": [{"id": "n1"}], "links": []}
        graph_repo.save_graph_cache(user["id"], data)

        loaded = graph_repo.load_graph_cache(user["id"])
        assert loaded is not None
        assert loaded["nodes"][0]["id"] == "n1"

    def test_upsert(self):
        user = _make_user()
        graph_repo.save_graph_cache(user["id"], {"v": 1})
        graph_repo.save_graph_cache(user["id"], {"v": 2})
        loaded = graph_repo.load_graph_cache(user["id"])
        assert loaded["v"] == 2

    def test_load_nonexistent(self):
        user = _make_user()
        assert graph_repo.load_graph_cache(user["id"]) is None


# ── Archive Health Summary ─────────────────────────────────────────────


class TestArchiveHealthSummary:
    def test_empty_state(self):
        user = _make_user()
        summary = page_repo.get_archive_health_summary(user["id"])
        assert summary["active_count"] == 0
        assert summary["archived_count"] == 0
        assert summary["by_reason"] == []
        assert summary["per_capture"] == []

    def test_counts_by_reason_with_top_domains(self):
        user = _make_user()
        cap = _make_capture(user["id"])
        page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": "https://google.com/search?q=x",
                    "title": "Search",
                    "domain": "google.com",
                    "visited_at": datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
                },
                {
                    "url": "https://google.com/search?q=y",
                    "title": "Search 2",
                    "domain": "google.com",
                    "visited_at": datetime(2026, 3, 15, 10, 1, tzinfo=timezone.utc),
                },
                {
                    "url": "https://accounts.google.com/signin",
                    "title": "Sign in",
                    "domain": "accounts.google.com",
                    "visited_at": datetime(2026, 3, 15, 10, 2, tzinfo=timezone.utc),
                },
                {
                    "url": "https://en.wikipedia.org/wiki/Whale",
                    "title": "Whale",
                    "domain": "en.wikipedia.org",
                    "visited_at": datetime(2026, 3, 15, 10, 3, tzinfo=timezone.utc),
                },
            ],
        )
        # Archive 2 google pages via skip_gate, 1 accounts page via domain_skip.
        # Leave the wikipedia page active.
        pages = page_repo.get_pages_for_capture(cap["id"])
        for p in pages:
            if p["domain"] == "google.com":
                page_repo.archive_page(p["id"], "skip_gate")
            elif p["domain"] == "accounts.google.com":
                page_repo.archive_page(p["id"], "domain_skip")

        summary = page_repo.get_archive_health_summary(user["id"])
        assert summary["active_count"] == 1
        assert summary["archived_count"] == 3

        by_reason = {r["reason"]: r for r in summary["by_reason"]}
        assert by_reason["skip_gate"]["count"] == 2
        assert by_reason["skip_gate"]["top_domains"][0] == {
            "domain": "google.com",
            "count": 2,
        }
        assert by_reason["domain_skip"]["count"] == 1
        assert by_reason["domain_skip"]["top_domains"][0]["domain"] == "accounts.google.com"


# ── Validation batch ──────────────────────────────────────────────────


class TestValidationBatch:
    def test_empty_state_returns_empty_list(self):
        user = _make_user()
        batch = page_repo.generate_validation_batch(user["id"])
        assert batch == []

    def test_stratified_sampling_respects_caps(self):
        user = _make_user()
        cap = _make_capture(user["id"])
        # 20 skip_gate, 3 dedup, 1 manual_exclusion — distribution to flex the cap.
        pages = []
        for i in range(20):
            pages.append(
                {
                    "url": f"https://google.com/q{i}",
                    "title": f"q{i}",
                    "domain": "google.com",
                    "visited_at": datetime(
                        2026, 3, 15, 10, i % 60, tzinfo=timezone.utc
                    ),
                }
            )
        for i in range(3):
            pages.append(
                {
                    "url": f"https://wikipedia.org/d{i}",
                    "title": f"d{i}",
                    "domain": "wikipedia.org",
                    "visited_at": datetime(
                        2026, 3, 15, 11, i, tzinfo=timezone.utc
                    ),
                }
            )
        pages.append(
            {
                "url": "https://reddit.com/x",
                "title": "manual",
                "domain": "reddit.com",
                "visited_at": datetime(2026, 3, 15, 12, 0, tzinfo=timezone.utc),
            }
        )
        ids = page_repo.insert_pages(cap["id"], pages)
        for i, pid in enumerate(ids):
            if i < 20:
                page_repo.archive_page(pid, "skip_gate")
            elif i < 23:
                page_repo.archive_page(pid, "dedup")
            else:
                page_repo.archive_page(pid, "manual_exclusion")

        batch = page_repo.generate_validation_batch(user["id"])
        reasons = [row["archive_reason"] for row in batch]
        # Default config: 10 skip_gate, 5 dedup (capped at 3), 2 manual (capped at 1).
        assert reasons.count("skip_gate") == 10
        assert reasons.count("dedup") == 3  # all available
        assert reasons.count("manual_exclusion") == 1  # all available

    def test_excludes_previously_reviewed(self):
        from backend.db import annotation_repo

        user = _make_user()
        cap = _make_capture(user["id"])
        ids = page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": "https://x.com/a",
                    "title": "a",
                    "domain": "x.com",
                    "visited_at": datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
                },
                {
                    "url": "https://x.com/b",
                    "title": "b",
                    "domain": "x.com",
                    "visited_at": datetime(2026, 3, 15, 10, 1, tzinfo=timezone.utc),
                },
            ],
        )
        for pid in ids:
            page_repo.archive_page(pid, "skip_gate")
        # Mark the first page as already reviewed.
        annotation_repo.create_annotation(
            user["id"],
            "page",
            ids[0],
            "validate_archive",
            new_value="correct",
        )

        batch = page_repo.generate_validation_batch(user["id"])
        returned_ids = [row["id"] for row in batch]
        assert ids[0] not in returned_ids
        assert ids[1] in returned_ids

    def test_dedup_pair_finds_canonical_by_content_id(self):
        user = _make_user()
        cap = _make_capture(user["id"])
        # Use distinct normalized URLs so _collapse_consecutive_duplicates
        # does NOT merge them into one row — the dedup linkage is created
        # explicitly via the shared page_content_id UPDATE below.
        ids = page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": "https://en.wikipedia.org/wiki/Whale",
                    "title": "Whale (canonical)",
                    "domain": "en.wikipedia.org",
                    "visited_at": datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
                    "dwell_time_seconds": 13,
                },
                {
                    "url": "https://en.wikipedia.org/wiki/Blue_whale",
                    "title": "Whale (losing twin)",
                    "domain": "en.wikipedia.org",
                    "visited_at": datetime(2026, 3, 15, 10, 0, 4, tzinfo=timezone.utc),
                    "dwell_time_seconds": 0,
                },
            ],
        )
        assert len(ids) == 2, f"Expected 2 inserted rows, got {len(ids)} — collapse may have merged them"
        # Force both onto the same page_content_id so the dedup pair-finder
        # can link them.
        content = content_repo.get_or_create_content(
            "https://en.wikipedia.org/wiki/Whale",
            extracted_text="Whales are marine mammals...",
        )
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE pages SET page_content_id = %s WHERE id = ANY(%s)",
                    (content["id"], ids),
                )
        page_repo.archive_page(ids[1], "dedup")

        pair = page_repo.get_dedup_pair(ids[1])
        assert pair is not None
        assert pair["archived"]["id"] == ids[1]
        assert pair["canonical"]["id"] == ids[0]
        assert pair["canonical"]["dwell_time_seconds"] == 13

    def test_dedup_pair_returns_none_for_non_dedup(self):
        user = _make_user()
        cap = _make_capture(user["id"])
        ids = page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": "https://google.com/x",
                    "title": "x",
                    "domain": "google.com",
                    "visited_at": datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
                }
            ],
        )
        page_repo.archive_page(ids[0], "skip_gate")
        assert page_repo.get_dedup_pair(ids[0]) is None
