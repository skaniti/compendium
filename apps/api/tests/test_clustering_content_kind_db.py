"""DB-backed: page_content.content_kind is selected and carried to page dicts."""

from datetime import UTC, datetime, timezone

import pytest

from backend.db.connection import get_conn


def _pg_reachable() -> bool:
    try:
        from backend.config.settings import settings

        url = settings.test_database_url
        if not url.startswith("postgresql"):
            return False
        from psycopg2 import connect

        connect(url).close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import capture_repo, content_repo, page_repo, user_repo
from backend.services.clustering_service import ClusteringService


@pytest.fixture(autouse=True)
def _clean_tables():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE pages, page_content, captures, users CASCADE")
    yield


def _seed(kind_via_repo: bool):
    user = user_repo.create_user("kind@example.test", name="Kind Test")
    cap = capture_repo.save_capture(
        user_id=user["id"],
        capture_id="cap_kind",
        source="desktop_active",
        started_at=datetime(2026, 3, 15, 10, 0, tzinfo=UTC),
        ended_at=datetime(2026, 3, 15, 11, 0, tzinfo=UTC),
    )
    content = content_repo.get_or_create_content(
        "https://alpha.example/login",
        extracted_text="Sign in to continue. " * 20,
        content_summary="A sign-in page.",
    )
    if kind_via_repo:
        content_repo.update_content(content["id"], content_kind="auth_login")
    else:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE page_content SET content_kind = %s WHERE id = %s",
                ("auth_login", content["id"]),
            )
    ids = page_repo.insert_pages(
        cap["id"],
        [
            {
                "url": "https://alpha.example/login",
                "title": "Synthetic sign-in",
                "domain": "alpha.example",
                "visited_at": datetime(2026, 3, 15, 10, 5, tzinfo=UTC),
            }
        ],
    )
    page_repo.update_page_status(ids[0], "active", page_content_id=content["id"])
    return user, ids[0]


@pytest.mark.parametrize("via_repo", [True, False])
def test_content_kind_reaches_page_dicts_and_filter(via_repo):
    user, page_id = _seed(via_repo)
    rows = page_repo.get_active_pages(user["id"])
    assert [(r["id"], r["content_kind"]) for r in rows] == [(page_id, "auth_login")]

    svc = ClusteringService(user_id=user["id"])
    pages = svc._load_all_pages(user["id"])
    assert pages[0]["content_kind"] == "auth_login"
    assert pages[0]["normalized_url"]

    out, stats = svc._filter_clusterable_pages(pages)
    assert out == []
    assert stats["excluded_content_kind"] == 1


def test_null_content_kind_is_none():
    user, _ = _seed(True)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE page_content SET content_kind = NULL")
    assert page_repo.get_active_pages(user["id"])[0]["content_kind"] is None
