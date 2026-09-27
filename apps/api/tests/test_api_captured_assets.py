"""Endpoint contract tests for GET /captured-assets/{rel:path} (post-flip
closeout, task 3a) -- the FastAPI owner-gated route that takes over serving
archived page-preview subresources (images, stylesheets, etc.) from disk.
Dash is today's only server of these files and retires at batch 08b; the
Next.js iframe reaches this route via a route handler that injects a bearer
token (task 3b, separate) -- never a cookie -- so this suite authenticates
exactly the way tests/test_api_preview.py does.

Ownership note: unlike the preview endpoint (which joins through
pages/captures), ``captured_assets`` carries its own ``user_id`` (migration
031) -- the gate here is a direct column check via the new
``page_repo.captured_asset_for_path`` helper. A missing row, a NULL owner
(orphaned legacy row), or an owner that isn't the caller all collapse to
the same 404, never 403, so a probing path never learns whether the row
exists (mirrors the preview endpoint's ``page_content_owned_by_user`` rule).

Path-safety note: httpx (the TestClient's transport) normalizes a literal
``..`` out of a URL string at parse time -- RFC 3986 dot-segment removal --
before the request is even sent, so a plain
``tc.get("/captured-assets/../secret.txt")`` never reaches our route at
all; it resolves client-side to "/secret.txt" and 404s as a route that
doesn't exist, exercising nothing of ours. ``_request_raw_path`` below
bypasses that by overwriting the built request's URL reference with the
literal, unnormalized path, simulating a client/proxy that doesn't
normalize -- the case our resolve-based guard must still catch. A
percent-encoded ``%2e%2e`` survives httpx's client-side parsing untouched
(it isn't a literal ".." at that layer) and is decoded to ".." by the ASGI
layer before our route ever sees it, so that case goes through plain
``tc.get()``.
"""

import hashlib
from contextlib import contextmanager

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

from backend.db import user_repo
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


def _make_user(email="captured-assets@example.com"):
    return user_repo.create_user(email, name="Captured Assets User")


def _insert_asset(
    user_id,
    file_path,
    content_type="application/octet-stream",
    byte_size=0,
    source_url="https://example.com/asset",
):
    """Insert a captured_assets row directly, bypassing asset_archiver --
    this suite exercises the read/serve endpoint, not ingestion."""
    sha = hashlib.sha256(f"{user_id}:{file_path}".encode()).hexdigest()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO captured_assets
                    (sha256, source_url, content_type, byte_size, file_path, user_id)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (sha, source_url, content_type, byte_size, file_path, user_id),
            )


@contextmanager
def _null_owner_asset(file_path, content_type="application/octet-stream"):
    """Temporarily insert a captured_assets row with a NULL user_id.

    Migration 031 backfills every existing row and then enforces NOT NULL
    on user_id going forward (031_user_scope_captured_assets.sql) -- a
    normal INSERT can no longer produce this state. This simulates the
    orphaned-legacy-row case the endpoint must still fail closed on, by
    relaxing the constraint just long enough to create the row, then
    deleting it and restoring the constraint before the context exits.
    """
    sha = hashlib.sha256(f"null-owner:{file_path}".encode()).hexdigest()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("ALTER TABLE captured_assets ALTER COLUMN user_id DROP NOT NULL")
            cur.execute(
                """
                INSERT INTO captured_assets
                    (sha256, source_url, content_type, byte_size, file_path, user_id)
                VALUES (%s, %s, %s, %s, %s, NULL)
                """,
                (sha, "https://example.com/orphan", content_type, 0, file_path),
            )
    try:
        yield
    finally:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM captured_assets WHERE file_path = %s AND user_id IS NULL",
                    (file_path,),
                )
                cur.execute("ALTER TABLE captured_assets ALTER COLUMN user_id SET NOT NULL")


def _request_raw_path(tc: TestClient, raw_path: str):
    """GET with the ASGI scope's path/raw_path set to EXACTLY raw_path,
    bypassing httpx's client-side dot-segment normalization (see module
    docstring) so a literal, unnormalized ".." reaches the route the way
    a non-normalizing client/proxy could deliver one.
    """
    request = tc.build_request("GET", "http://testserver/captured-assets/_placeholder")
    request.url._uri_reference = request.url._uri_reference._replace(path=raw_path)
    return tc.send(request)


@pytest.fixture
def client():
    """TestClient with verify_api_key overridden to a real, freshly-created
    user -- mirrors tests/test_api_preview.py's ``client`` fixture."""
    from backend.api.main import app, verify_api_key

    user = _make_user()
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    yield TestClient(app), user
    app.dependency_overrides.pop(verify_api_key, None)


@pytest.fixture
def assets_dir(tmp_path, monkeypatch):
    """Point asset_archiver._BASE_ASSETS_DIR at a throwaway directory, read
    by the route AT REQUEST TIME so this monkeypatch takes effect."""
    from backend.services import asset_archiver

    monkeypatch.setattr(asset_archiver, "_BASE_ASSETS_DIR", tmp_path)
    return tmp_path


class TestCapturedAssetOwnership:
    def test_owner_get_returns_200_with_row_content_type_and_cache_headers(self, client, assets_dir):
        tc, user = client
        body = b"body { color: red; }"
        (assets_dir / "load.php").write_bytes(body)
        # content_type deliberately differs from what would be inferred
        # from the "load.php" source URL/name, to prove the DB row's
        # content_type overrides any sniffed/inferred type.
        _insert_asset(user["id"], "load.php", content_type="text/css; charset=utf-8")

        resp = tc.get("/captured-assets/load.php")
        assert resp.status_code == 200
        assert resp.content == body
        assert resp.headers["content-type"] == "text/css; charset=utf-8"
        assert "private" in resp.headers["cache-control"]
        assert "immutable" in resp.headers["cache-control"]

    def test_other_users_asset_returns_404(self, client, assets_dir):
        tc, _user = client
        other = _make_user(email="other-captured-assets@example.com")
        (assets_dir / "other.png").write_bytes(b"other bytes")
        _insert_asset(other["id"], "other.png", content_type="image/png")

        resp = tc.get("/captured-assets/other.png")
        assert resp.status_code == 404
        assert resp.json() == {"detail": "Asset not found."}

    def test_null_owner_row_returns_404(self, client, assets_dir):
        tc, _user = client
        (assets_dir / "orphan.txt").write_bytes(b"orphan content")

        with _null_owner_asset("orphan.txt"):
            resp = tc.get("/captured-assets/orphan.txt")
        assert resp.status_code == 404
        assert resp.json() == {"detail": "Asset not found."}

    def test_row_exists_but_file_missing_on_disk_returns_404(self, client, assets_dir):
        tc, user = client
        _insert_asset(user["id"], "missing.bin", content_type="application/octet-stream")

        resp = tc.get("/captured-assets/missing.bin")
        assert resp.status_code == 404
        assert resp.json() == {"detail": "Asset not found."}

    def test_no_row_but_file_exists_on_disk_returns_404(self, client, assets_dir):
        tc, _user = client
        (assets_dir / "ghost.bin").write_bytes(b"ghost bytes")

        resp = tc.get("/captured-assets/ghost.bin")
        assert resp.status_code == 404
        assert resp.json() == {"detail": "Asset not found."}

    def test_directory_path_returns_404(self, client, assets_dir):
        tc, user = client
        (assets_dir / "somedir").mkdir()
        _insert_asset(user["id"], "somedir", content_type="application/octet-stream")

        resp = tc.get("/captured-assets/somedir")
        assert resp.status_code == 404
        assert resp.json() == {"detail": "Asset not found."}

    def test_plain_demo_user_can_read_own_asset(self, client, assets_dir):
        tc, user = client
        from backend.db import auth_repo

        auth_repo.set_role(user["id"], "demo")
        (assets_dir / "demo-asset.png").write_bytes(b"demo bytes")
        _insert_asset(user["id"], "demo-asset.png", content_type="image/png")

        resp = tc.get("/captured-assets/demo-asset.png")
        assert resp.status_code == 200
        assert resp.content == b"demo bytes"


class TestCapturedAssetPathSafety:
    def test_literal_dotdot_traversal_returns_404(self, client, assets_dir):
        tc, user = client
        (assets_dir.parent / "secret.txt").write_bytes(b"secret")
        # A matching row exists so a broken safety check would otherwise
        # let this through the ownership + file-existence checks.
        _insert_asset(user["id"], "../secret.txt", content_type="text/plain")

        resp = _request_raw_path(tc, "/captured-assets/../secret.txt")
        assert resp.status_code == 404
        assert resp.json() == {"detail": "Asset not found."}

    def test_percent_encoded_dotdot_traversal_returns_404(self, client, assets_dir):
        tc, user = client
        (assets_dir.parent / "secret.txt").write_bytes(b"secret")
        _insert_asset(user["id"], "../secret.txt", content_type="text/plain")

        resp = tc.get("/captured-assets/%2e%2e/secret.txt")
        assert resp.status_code == 404
        assert resp.json() == {"detail": "Asset not found."}

    def test_nul_byte_in_path_returns_404(self, client, assets_dir):
        tc, user = client
        (assets_dir / "secret.txt").write_bytes(b"secret")
        _insert_asset(user["id"], "secret.txt", content_type="text/plain")

        resp = tc.get("/captured-assets/secret.txt%00")
        assert resp.status_code == 404
        assert resp.json() == {"detail": "Asset not found."}

    def test_empty_rel_returns_404(self, client, assets_dir):
        tc, _user = client

        resp = tc.get("/captured-assets/")
        assert resp.status_code == 404

    def test_absolute_path_returns_404(self, client, assets_dir):
        tc, user = client
        (assets_dir.parent / "secret.txt").write_bytes(b"secret")
        _insert_asset(user["id"], "/etc/passwd", content_type="text/plain")

        resp = _request_raw_path(tc, "/captured-assets//etc/passwd")
        assert resp.status_code == 404
        assert resp.json() == {"detail": "Asset not found."}


class TestCapturedAssetAuth:
    def test_unauthed_request_rejected_in_prod_mode(self, monkeypatch):
        """Mirrors tests/test_api_preview.py's
        TestArchivedPreviewAuth.test_unauthed_request_rejected_in_prod_mode:
        forces production-mode auth (the dev bypass, default in tests,
        would otherwise resolve a default user and never exercise the
        auth gate). No Authorization/X-API-Key header is sent, so
        verify_api_key must 401 rather than fall through to a dev user."""
        from backend.api.main import app
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "production")
        tc = TestClient(app)

        resp = tc.get("/captured-assets/anything.png")
        assert resp.status_code == 401
