"""Endpoint contract tests for GET /api/pages/{pid}/preview (migration batch
02, task 2) -- the second of four thin read endpoints ported for the
Next.js topic-detail iframe.

Thin wrapper: the endpoint hands off to
``backend.services.preview_renderer.render_archived_preview`` and returns
its ``(body, status)`` contract as an ``HTMLResponse``, exactly the way the
Flask ``/__preview`` route does at ``frontend/dash/app.py:1437`` (renamed
here, kept in sync -- see that route's docstring for the sanitize pipeline
this delegates to). This suite exercises the ENDPOINT (auth wiring, the
ownership gate, header parity, status pass-through) rather than the
renderer's own sanitize/rewrite pipeline, which has no dedicated suite yet
and is out of scope for this thin-wrapper task.

Naming note: ``pid`` in the route is a ``page_content`` row id, NOT a
``pages`` id -- ``render_archived_preview`` reads ``page_content.raw_html``
directly (see ``_load_page_content_row``). The Dash consumer passes
``page_content.id``; the Next.js client is expected to do the same.

Ownership note: ``render_archived_preview`` itself is NOT user-scoped --
it will render any page_content row's archived HTML given a bare id. The
endpoint adds an ownership gate (a pages row linking to this
page_content_id must belong to a capture owned by the caller) before
calling it, returning 404 -- not 403 -- on failure so a probing pid doesn't
leak whether the row exists at all.
"""

import gzip

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


def _make_user(email="preview@example.com"):
    return user_repo.create_user(email, name="Preview User")


def _make_capture(user_id, capture_id="cap_preview_001"):
    from datetime import datetime, timezone

    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture_id,
        source="desktop_active",
        started_at=datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 3, 15, 11, 0, tzinfo=timezone.utc),
    )


def _make_page_content_with_archive(url="https://en.wikipedia.org/wiki/Black_hole"):
    """Create a page_content row with real gzip-compressed raw_html.

    Uses a Wikipedia URL so ``extract_main_content`` takes the bypass path
    (returns the input untouched rather than running trafilatura) --
    deterministic, no extraction-library flakiness in a wrapper-endpoint
    test that isn't exercising the extraction pipeline itself.
    """
    content = content_repo.get_or_create_content(url)
    body = (
        b"<html><body><article><p>"
        + b"Black holes are regions of spacetime. " * 20
        + b"</p></article></body></html>"
    )
    content_repo.update_content(
        content["id"],
        raw_html=gzip.compress(body),
        raw_html_usable=True,
    )
    return content["id"]


def _make_page_content_without_archive(url="https://en.wikipedia.org/wiki/No_archive"):
    """page_content row that exists but has no raw_html (NULL, the default)."""
    content = content_repo.get_or_create_content(url)
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
    user -- mirrors tests/test_api_diary.py's ``client`` fixture. A real
    user_id is needed because the ownership gate does a real DB-backed
    pages/captures join, not a mocked check."""
    from backend.api.main import app, verify_api_key

    user = _make_user()
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    yield TestClient(app), user
    app.dependency_overrides.pop(verify_api_key, None)


class TestArchivedPreview:
    def test_page_with_usable_archive_returns_200_html_no_store(self, client):
        tc, user = client
        cap = _make_capture(user["id"])
        content_id = _make_page_content_with_archive()
        _link_page_to_content(
            cap["id"], content_id, user["id"], "https://en.wikipedia.org/wiki/Black_hole"
        )

        resp = tc.get(f"/api/pages/{content_id}/preview")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/html")
        assert resp.headers["cache-control"] == "no-store, no-cache, must-revalidate"
        assert resp.headers["pragma"] == "no-cache"
        assert "Black hole" in resp.text or "black hole" in resp.text.lower()

    def test_missing_pid_returns_404(self, client):
        tc, _user = client
        resp = tc.get("/api/pages/999999/preview")
        assert resp.status_code == 404
        # Header parity is required on error outcomes too (mirrors Flask).
        assert resp.headers["cache-control"] == "no-store, no-cache, must-revalidate"
        assert resp.headers["pragma"] == "no-cache"

    def test_pid_owned_by_different_user_returns_404(self, client):
        tc, _user = client
        other_user = _make_user(email="other-preview@example.com")
        other_cap = _make_capture(other_user["id"], capture_id="cap_preview_other")
        content_id = _make_page_content_with_archive(
            url="https://en.wikipedia.org/wiki/Other_users_page"
        )
        _link_page_to_content(
            other_cap["id"],
            content_id,
            other_user["id"],
            "https://en.wikipedia.org/wiki/Other_users_page",
        )

        # Requested by `client`'s user, not `other_user` -- ownership check
        # must fail even though the page_content row genuinely exists and
        # has a usable archive.
        resp = tc.get(f"/api/pages/{content_id}/preview")
        assert resp.status_code == 404
        # Asserting the no-store headers here (not just the status code)
        # matters: FastAPI's default "route not found" 404 has neither
        # header, so this also proves the request reached OUR 404 (the
        # ownership gate), not a fallback from a route that doesn't exist.
        assert resp.headers["cache-control"] == "no-store, no-cache, must-revalidate"
        assert resp.headers["pragma"] == "no-cache"

    def test_page_content_without_raw_html_falls_through_to_service_status(self, client):
        tc, user = client
        cap = _make_capture(user["id"])
        content_id = _make_page_content_without_archive()
        _link_page_to_content(
            cap["id"], content_id, user["id"], "https://en.wikipedia.org/wiki/No_archive"
        )

        resp = tc.get(f"/api/pages/{content_id}/preview")
        # render_archived_preview's own status for "no archived HTML" (see
        # preview_renderer.py:229) -- passed through verbatim past the
        # ownership gate, which passes since this page IS owned by user.
        assert resp.status_code == 404
        # Same reasoning as the different-user case: the header assertion
        # proves this is the service's real 404, not a route-not-found 404.
        assert resp.headers["cache-control"] == "no-store, no-cache, must-revalidate"
        assert resp.headers["pragma"] == "no-cache"


class TestArchivedPreviewFrameHeaders:
    """This endpoint is embedded in the Next.js topic-detail iframe
    (``apps/web/components/TopicDetail.tsx``, same-origin via the Next
    proxy). ``security_middleware`` (main.py, ~line 545) stamps
    ``X-Frame-Options: DENY`` on every response by default, which blocks
    that framing outright even same-origin -- this route needs
    ``SAMEORIGIN`` plus a matching ``Content-Security-Policy:
    frame-ancestors 'self'`` instead, on every outcome (the 200 branch and
    its 404 ownership-gate branch alike). Every other route must keep
    DENY and get no CSP header at all (batch-06 deploy-flip Task 4 fix2)."""

    def test_preview_200_carries_sameorigin_frame_headers(self, client):
        tc, user = client
        cap = _make_capture(user["id"])
        content_id = _make_page_content_with_archive()
        _link_page_to_content(
            cap["id"], content_id, user["id"], "https://en.wikipedia.org/wiki/Black_hole"
        )

        resp = tc.get(f"/api/pages/{content_id}/preview")
        assert resp.status_code == 200
        assert resp.headers["x-frame-options"] == "SAMEORIGIN"
        assert "frame-ancestors 'self'" in resp.headers["content-security-policy"]

    def test_preview_404_branch_still_carries_sameorigin_frame_headers(self, client):
        tc, _user = client
        resp = tc.get("/api/pages/999999/preview")
        assert resp.status_code == 404
        assert resp.headers["x-frame-options"] == "SAMEORIGIN"
        assert "frame-ancestors 'self'" in resp.headers["content-security-policy"]

    def test_ordinary_route_keeps_deny_and_no_csp(self, client):
        tc, _user = client
        resp = tc.get("/health")
        assert resp.status_code == 200
        assert resp.headers["x-frame-options"] == "DENY"
        assert "content-security-policy" not in resp.headers


class TestArchivedPreviewAuth:
    def test_unauthed_request_rejected_in_prod_mode(self, monkeypatch):
        """Force production-mode auth -- the dev bypass (default in tests)
        would otherwise resolve a default user and never exercise the auth
        gate at all. Mirrors tests/test_api_diary.py's prod-mode pattern.
        No Authorization/X-API-Key header is sent, so verify_api_key must
        401 rather than fall through to a dev user."""
        from backend.api.main import app
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "production")
        tc = TestClient(app)

        resp = tc.get("/api/pages/1/preview")
        assert resp.status_code == 401


class TestPreviewAssetUrlsAreSigned:
    """Every /captured-assets/ URL in a rendered preview must carry a
    signature valid for the viewing user (the sandboxed iframe cannot send
    the session cookie, so the signature is its only credential)."""

    def _insert_asset(self, user_id, content_id, source_url, file_path, content_type):
        import hashlib

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO captured_assets
                    (sha256, source_url, content_type, byte_size, file_path, user_id)
                VALUES (%s, %s, %s, 0, %s, %s) RETURNING id
                """,
                (hashlib.sha256(file_path.encode()).hexdigest(), source_url,
                 content_type, file_path, user_id),
            )
            aid = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO page_content_assets (page_content_id, asset_id) VALUES (%s, %s)",
                (content_id, aid),
            )

    def test_all_captured_asset_urls_verify_for_user(self):
        import re

        from backend.services.asset_urls import verify_asset_signature
        from backend.services.preview_renderer import render_archived_preview
        from backend.services.site_rules import SITE_RULES

        user = _make_user(email="signed-render@example.com")
        url = "https://en.wikipedia.org/wiki/Signed_render"
        content = content_repo.get_or_create_content(url)
        body = (
            b'<html><body><article><p>text</p>'
            b'<img src="https://upload.wikimedia.org/pic.png"/></article></body></html>'
        )
        content_repo.update_content(
            content["id"], raw_html=gzip.compress(body), raw_html_usable=True
        )
        load_php = SITE_RULES["en.wikipedia.org"].stylesheet_links[0]
        self._insert_asset(user["id"], content["id"], "https://upload.wikimedia.org/pic.png",
                           f"user_{user['id']}/aa/pic.png", "image/png")
        self._insert_asset(user["id"], content["id"], load_php,
                           f"user_{user['id']}/bb/site.css", "text/css")
        self._insert_asset(user["id"], content["id"], "https://example.com/extra.css",
                           f"user_{user['id']}/cc/extra.css", "text/css")

        html, status = render_archived_preview(content["id"], user["id"])
        assert status == 200

        urls = re.findall(r'(?:src|href)="(/captured-assets/[^"]+)"', html)
        urls = [u.replace("&amp;", "&") for u in urls]
        paths = {u.split("?", 1)[0] for u in urls}
        assert paths == {
            f"/captured-assets/user_{user['id']}/aa/pic.png",
            f"/captured-assets/user_{user['id']}/bb/site.css",
            f"/captured-assets/user_{user['id']}/cc/extra.css",
        }
        from urllib.parse import parse_qs

        for u in urls:
            path, _, query = u.partition("?")
            q = {k: v[0] for k, v in parse_qs(query).items()}
            rel = path[len("/captured-assets/"):]
            assert verify_asset_signature(rel, q.get("u"), q.get("exp"), q.get("sig")) == user["id"]
