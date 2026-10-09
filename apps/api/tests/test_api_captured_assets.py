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
    """TestClient with captured_asset_auth overridden to a real, freshly-created
    user -- mirrors tests/test_api_preview.py's ``client`` fixture."""
    from backend.api.main import app, captured_asset_auth

    user = _make_user()
    app.dependency_overrides[captured_asset_auth] = lambda: user["id"]
    yield TestClient(app), user
    app.dependency_overrides.pop(captured_asset_auth, None)


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


class TestCapturedAssetSignedUrls:
    """Signature-authenticated path: no bearer, the signed user id is the
    identity. Sandboxed preview iframes cannot send the SameSite=Lax cookie."""

    @pytest.fixture
    def signed(self, assets_dir, monkeypatch):
        from backend.api.main import app
        from backend.config.settings import settings

        # Production mode: no dev bypass, so an unsigned request truly 401s.
        monkeypatch.setattr(settings, "environment", "production")
        user = _make_user(email="signed-owner@example.com")
        return TestClient(app), user, assets_dir

    def test_signed_url_without_bearer_serves_owned_asset(self, signed):
        from backend.services.asset_urls import asset_url_signer

        tc, user, d = signed
        (d / "pic.png").write_bytes(b"png-bytes")
        _insert_asset(user["id"], "pic.png", content_type="image/png")
        resp = tc.get(asset_url_signer(user["id"])("pic.png"))
        assert resp.status_code == 200
        assert resp.content == b"png-bytes"

    def test_signed_url_for_another_users_asset_404(self, signed):
        from backend.services.asset_urls import asset_url_signer

        tc, user, d = signed
        other = _make_user(email="signed-other@example.com")
        (d / "theirs.png").write_bytes(b"x")
        _insert_asset(other["id"], "theirs.png", content_type="image/png")
        resp = tc.get(asset_url_signer(user["id"])("theirs.png"))
        assert resp.status_code == 404
        assert resp.json() == {"detail": "Asset not found."}

    def test_expired_signature_404(self, signed):
        from backend.services.asset_urls import asset_url_signer

        tc, user, d = signed
        (d / "pic.png").write_bytes(b"x")
        _insert_asset(user["id"], "pic.png", content_type="image/png")
        resp = tc.get(asset_url_signer(user["id"], now=1_000_000.0)("pic.png"))
        assert resp.status_code == 404

    def test_bad_signature_404_not_401(self, signed):
        from backend.services.asset_urls import asset_url_signer

        tc, user, d = signed
        (d / "pic.png").write_bytes(b"x")
        _insert_asset(user["id"], "pic.png", content_type="image/png")
        url = asset_url_signer(user["id"])("pic.png")
        resp = tc.get(url[:-2] + ("AA" if not url.endswith("AA") else "BB"))
        assert resp.status_code == 404

    def test_signature_for_other_path_404(self, signed):
        from backend.services.asset_urls import asset_url_signer

        tc, user, d = signed
        for name in ("a.png", "b.png"):
            (d / name).write_bytes(b"x")
            _insert_asset(user["id"], name, content_type="image/png")
        qs = asset_url_signer(user["id"])("a.png").split("?", 1)[1]
        assert tc.get(f"/captured-assets/b.png?{qs}").status_code == 404

    def test_path_safety_still_applies_to_signed_requests(self, signed):
        from backend.services.asset_urls import asset_url_signer

        tc, user, d = signed
        # A file that really exists outside the base dir, owned by the user
        # and correctly signed: only the path-safety checks can stop it.
        (d.parent / "secret.txt").write_bytes(b"secret")
        _insert_asset(user["id"], "../secret.txt", content_type="text/plain")
        qs = asset_url_signer(user["id"])("../secret.txt").split("?", 1)[1]
        resp = tc.get(f"/captured-assets/%2e%2e/secret.txt?{qs}")
        assert resp.status_code == 404

    def test_verification_uses_compare_digest(self, signed, monkeypatch):
        import hmac

        from backend.services import asset_urls

        calls = []
        real = hmac.compare_digest

        def spy(a, b):
            calls.append((a, b))
            return real(a, b)

        monkeypatch.setattr(asset_urls.hmac, "compare_digest", spy)
        _tc, user, _d = signed
        url = asset_urls.asset_url_signer(user["id"])("pic.png")
        q = dict(p.split("=", 1) for p in url.split("?", 1)[1].split("&"))
        assert asset_urls.verify_asset_signature("pic.png", q["u"], q["exp"], q["sig"]) == user["id"]
        assert calls

    def test_api_key_auth_still_works_without_sig(self, signed, monkeypatch):
        from backend.db import user_repo as ur

        tc, user, d = signed
        (d / "pic.png").write_bytes(b"key-bytes")
        _insert_asset(user["id"], "pic.png", content_type="image/png")
        monkeypatch.setattr(
            ur, "get_user_by_api_key", lambda k: {"id": user["id"]} if k == "good-key" else None
        )
        ok = tc.get("/captured-assets/pic.png", headers={"X-API-Key": "good-key"})
        assert ok.status_code == 200 and ok.content == b"key-bytes"
        bad = tc.get("/captured-assets/pic.png", headers={"X-API-Key": "nope"})
        assert bad.status_code == 401

    @pytest.mark.parametrize("suffix", ["?sig=", "?sig", "?sig=&u=1&exp=9999999999"])
    def test_empty_sig_is_404(self, signed, suffix):
        tc, user, d = signed
        (d / "pic.png").write_bytes(b"x")
        _insert_asset(user["id"], "pic.png", content_type="image/png")
        assert tc.get(f"/captured-assets/pic.png{suffix}").status_code == 404

    def test_no_sig_no_bearer_still_401(self, signed):
        tc, _user, _d = signed
        assert tc.get("/captured-assets/pic.png").status_code == 401
        assert tc.get("/captured-assets/pic.png?u=1&exp=9999999999").status_code == 401

    def test_bearer_path_still_works(self, signed):
        from backend.services.auth_service import create_access_token

        tc, user, d = signed
        (d / "pic.png").write_bytes(b"bearer-bytes")
        _insert_asset(user["id"], "pic.png", content_type="image/png")
        token = create_access_token(user["id"], user["email"])
        resp = tc.get("/captured-assets/pic.png", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        assert resp.content == b"bearer-bytes"
