"""Endpoint contract tests for GET /api/pages/content (migration batch 02,
task 3, endpoint 1) -- the third of four thin read endpoints ported for the
Next.js topic-detail panel.

Thin wrapper: the endpoint mirrors the page_content lookup inside
``frontend/dash/layouts/topic_detail.py::_fetch_and_render_page_content``
(line ~233) -- normalize the incoming ``url`` via
``backend.utils.url_normalize.normalize_url``, then query ``page_content``
by ``normalized_url``, selecting id/url/domain/extracted_text/
content_summary/tool_selected/has_usable_html. Unlike the Dash helper
(which tries a list of candidate ``page_urls`` in order until one matches),
this endpoint takes exactly one ``url`` query param -- the Next.js client
already knows which URL it wants content for.

Naming note: ``pid`` in the response is the ``page_content`` row id -- the
same value ``GET /api/pages/{pid}/preview`` (batch 02 task 2) expects.

Ownership note: the Dash query is NOT user-scoped. This endpoint adds the
same ownership gate as the preview endpoint (a ``pages`` row linking to
this ``page_content`` id must belong to a capture owned by the caller),
returning 404 -- not 403 -- on failure, so a probing url doesn't leak
whether the row exists for another user.
"""

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

from backend.db import capture_repo, content_repo, page_repo, user_repo
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
                         clusters, recluster_runs, page_content_assets,
                         captured_assets, pages, page_content,
                         captures, users
                CASCADE
                """
            )
    yield


def _make_user(email="content@example.com"):
    return user_repo.create_user(email, name="Content User")


def _make_capture(user_id, capture_id="cap_content_001"):
    from datetime import datetime, timezone

    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture_id,
        source="desktop_active",
        started_at=datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 3, 15, 11, 0, tzinfo=timezone.utc),
    )


def _make_page_content(
    url="https://en.wikipedia.org/wiki/Black_hole",
    extracted_text="Black holes are regions of spacetime.",
    content_summary="A summary of black holes.",
    tool_selected="trafilatura",
):
    content = content_repo.get_or_create_content(
        url,
        extracted_text=extracted_text,
        content_summary=content_summary,
        tool_selected=tool_selected,
    )
    return content["id"]


def _link_page_to_content(capture_db_id, content_id, user_id, url):
    from datetime import datetime, timezone

    ids = page_repo.insert_pages(
        capture_db_id,
        [
            {
                "url": url,
                "title": "Black hole",
                "domain": "en.wikipedia.org",
                "visited_at": datetime(2026, 3, 15, 10, 5, tzinfo=timezone.utc),
            },
        ],
    )
    page_repo.update_page_status(ids[0], "active", page_content_id=content_id)
    return ids[0]


@pytest.fixture
def client():
    """TestClient with verify_api_key overridden to a real, freshly-created
    user -- mirrors tests/test_api_preview.py's ``client`` fixture. A real
    user_id is needed because the ownership gate does a real DB-backed
    pages/captures join, not a mocked check."""
    from backend.api.main import app, verify_api_key

    user = _make_user()
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    yield TestClient(app), user
    app.dependency_overrides.pop(verify_api_key, None)


class TestPageContent:
    def test_matching_url_returns_expected_shape(self, client):
        tc, user = client
        cap = _make_capture(user["id"])
        url = "https://en.wikipedia.org/wiki/Black_hole"
        content_id = _make_page_content(url=url)
        _link_page_to_content(cap["id"], content_id, user["id"], url)

        resp = tc.get("/api/pages/content", params={"url": url})
        assert resp.status_code == 200
        body = resp.json()
        assert body == {
            "pid": content_id,
            "url": url,
            "domain": "en.wikipedia.org",
            "extracted_text": "Black holes are regions of spacetime.",
            "content_summary": "A summary of black holes.",
            "tool_selected": "trafilatura",
            "has_usable_html": False,
        }

    def test_has_usable_html_true_when_archived_html_present(self, client):
        tc, user = client
        cap = _make_capture(user["id"])
        url = "https://en.wikipedia.org/wiki/Sourdough"
        content_id = _make_page_content(url=url)
        content_repo.update_content(content_id, raw_html=b"<html></html>", raw_html_usable=True)
        _link_page_to_content(cap["id"], content_id, user["id"], url)

        resp = tc.get("/api/pages/content", params={"url": url})
        assert resp.status_code == 200
        assert resp.json()["has_usable_html"] is True

    def test_url_normalization_matches_stored_normalized_form(self, client):
        """Query with a URL variant (tracking param + trailing slash) that
        normalizes to the same normalized_url as the stored row -- proves
        the endpoint normalizes the incoming url before querying, not just
        comparing raw strings."""
        tc, user = client
        cap = _make_capture(user["id"])
        stored_url = "https://en.wikipedia.org/wiki/Black_hole"
        content_id = _make_page_content(url=stored_url)
        _link_page_to_content(cap["id"], content_id, user["id"], stored_url)

        variant_url = "https://EN.wikipedia.org/wiki/Black_hole/?utm_source=newsletter"
        resp = tc.get("/api/pages/content", params={"url": variant_url})
        assert resp.status_code == 200
        assert resp.json()["pid"] == content_id

    def test_no_matching_row_returns_404(self, client):
        tc, _user = client
        resp = tc.get(
            "/api/pages/content",
            params={"url": "https://en.wikipedia.org/wiki/Does_not_exist"},
        )
        assert resp.status_code == 404

    def test_content_owned_by_different_user_returns_404(self, client):
        tc, _user = client
        other_user = _make_user(email="other-content@example.com")
        other_cap = _make_capture(other_user["id"], capture_id="cap_content_other")
        url = "https://en.wikipedia.org/wiki/Other_users_page"
        content_id = _make_page_content(url=url)
        _link_page_to_content(other_cap["id"], content_id, other_user["id"], url)

        # Requested by `client`'s user, not `other_user` -- ownership check
        # must fail even though the page_content row genuinely exists.
        resp = tc.get("/api/pages/content", params={"url": url})
        assert resp.status_code == 404


class TestPageContentAuth:
    def test_unauthed_request_rejected_in_prod_mode(self, monkeypatch):
        """Force production-mode auth -- the dev bypass (default in tests)
        would otherwise resolve a default user and never exercise the auth
        gate at all. Mirrors tests/test_api_preview.py's prod-mode pattern.
        No Authorization/X-API-Key header is sent, so verify_api_key must
        401 rather than fall through to a dev user."""
        from backend.api.main import app
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "production")
        tc = TestClient(app)

        resp = tc.get("/api/pages/content", params={"url": "https://example.com/"})
        assert resp.status_code == 401
