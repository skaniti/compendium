"""One-click public demo entry endpoint (demo-one-click-entry, Task 3)."""
import httpx
import pytest
from fastapi.testclient import TestClient

from backend.config.settings import settings
from backend.db import auth_repo, user_repo
from backend.db.connection import get_conn
from backend.services import auth_service

PW = "pw-" + "x9" * 6
SECRET = "0x" + "s" * 30
VERIFY = "https://verify.test.local/siteverify"


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        connect(settings.test_database_url).close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "demo_public_entry", True)
    monkeypatch.setattr(settings, "turnstile_secret_key", SECRET)
    monkeypatch.setattr(settings, "turnstile_verify_url", VERIFY)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
        cur.execute("DELETE FROM audit_events")
    admin = user_repo.create_user("admin@test.local", name="Admin")
    auth_repo.set_role(admin["id"], "admin")
    auth_repo.set_password(admin["id"], auth_service.hash_password(PW))
    demo = user_repo.create_user("demo@test.local", name="Demo")
    auth_repo.set_role(demo["id"], "demo")
    auth_repo.set_password(demo["id"], auth_service.hash_password(PW))
    return {"admin": admin, "demo": demo}


@pytest.fixture
def client():
    from backend.api.main import app

    return TestClient(app)


class _Siteverify:
    """Fake httpx.AsyncClient.post for the siteverify call."""

    def __init__(self, status=200, body=None, exc=None):
        self.status, self.body, self.exc, self.calls = status, body, exc, []

    async def __call__(self, url, data=None, **kw):
        self.calls.append((url, dict(data or {})))
        if self.exc:
            raise self.exc
        return httpx.Response(self.status, json=self.body or {}, request=httpx.Request("POST", url))


@pytest.fixture
def siteverify(monkeypatch):
    def install(**kw):
        fake = _Siteverify(**kw)
        monkeypatch.setattr(httpx.AsyncClient, "post", lambda self, url, **k: fake(url, **k))
        return fake

    return install


def _enter(client, token="tok-" + "a" * 20):
    return client.post("/api/auth/demo", json={"turnstile_token": token})


def _failed_reasons():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT detail->>'reason' FROM audit_events WHERE event = 'auth.demo_entry.failed' ORDER BY id")
        return [r[0] for r in cur.fetchall()]


def test_404_when_entry_is_off(env, client, siteverify, monkeypatch):
    monkeypatch.setattr(settings, "demo_public_entry", False)
    fake = siteverify(body={"success": True})
    assert _enter(client).status_code == 404
    assert fake.calls == []


def test_success_mints_a_24h_demo_session(env, client, siteverify):
    fake = siteverify(body={"success": True})
    res = _enter(client)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["user"]["email"] == "demo@test.local"
    assert body["session_policy"]["remembered"] is False
    assert "browser_token" not in body
    url, data = fake.calls[0]
    assert url == VERIFY
    assert data["secret"] == SECRET and data["response"].startswith("tok-")
    assert "remoteip" in data
    row = auth_repo.get_refresh_token(auth_service._hash_token(body["refresh_token"]))
    from datetime import datetime, timedelta, timezone

    expires = row["expires_at"].replace(tzinfo=timezone.utc)
    assert abs((expires - datetime.now(timezone.utc)) - timedelta(hours=24)) < timedelta(minutes=1)
    assert row["remembered"] is False
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM audit_events WHERE event = 'auth.demo_entry.ok'")
        assert cur.fetchone()[0] == 1


def test_challenge_failure_is_403_with_codes_audited(env, client, siteverify):
    siteverify(body={"success": False, "error-codes": ["timeout-or-duplicate"]})
    res = _enter(client)
    assert res.status_code == 403
    assert res.json()["detail"] == "Challenge failed"
    assert _failed_reasons() == ["challenge"]
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT detail->'error_codes' FROM audit_events WHERE event = 'auth.demo_entry.failed'")
        assert cur.fetchone()[0] == ["timeout-or-duplicate"]


def test_verify_timeout_is_503_and_mints_nothing(env, client, siteverify):
    siteverify(exc=httpx.ReadTimeout("slow"))
    res = _enter(client)
    assert res.status_code == 503
    assert res.json()["detail"] == "Challenge service unavailable"
    assert _failed_reasons() == ["verify_unavailable"]
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM refresh_tokens")
        assert cur.fetchone()[0] == 0


def test_verify_non_200_is_503(env, client, siteverify):
    siteverify(status=502, body={})
    assert _enter(client).status_code == 503
    assert _failed_reasons() == ["verify_unavailable"]


def test_missing_demo_account_is_503(env, client, siteverify):
    siteverify(body={"success": True})
    auth_repo.set_role(env["demo"]["id"], "user")
    assert _enter(client).status_code == 503
    assert _failed_reasons() == ["no_demo_account"]


def test_verify_json_list_body_is_503(env, client, siteverify, monkeypatch):
    async def post(self, url, **k):
        return httpx.Response(200, json=[1], request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    assert _enter(client).status_code == 503
    assert _failed_reasons() == ["verify_unavailable"]


def test_verify_string_true_is_not_success(env, client, siteverify):
    siteverify(body={"success": "true"})
    assert _enter(client).status_code == 403
    assert _failed_reasons() == ["challenge"]


def test_ambiguous_demo_role_is_503_no_demo_account(env, client, siteverify):
    siteverify(body={"success": True})
    other = user_repo.create_user("demo2@test.local", name="Demo2")
    auth_repo.set_role(other["id"], "demo")
    assert _enter(client).status_code == 503
    assert _failed_reasons() == ["no_demo_account"]


def test_token_is_never_in_audit_details(env, client, siteverify):
    siteverify(body={"success": False, "error-codes": ["invalid-input-response"]})
    token = "tok-" + "z" * 40
    _enter(client, token)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT detail::text FROM audit_events")
        assert all(token not in (r[0] or "") for r in cur.fetchall())


@pytest.mark.parametrize("body", [{}, {"turnstile_token": ""}, {"turnstile_token": "x" * 2049}])
def test_malformed_body_is_422(env, client, siteverify, body):
    siteverify(body={"success": True})
    assert client.post("/api/auth/demo", json=body).status_code == 422


def test_refresh_of_a_demo_entry_token_keeps_the_horizon(env, client, siteverify):
    siteverify(body={"success": True})
    first = _enter(client).json()
    horizon = auth_repo.get_refresh_token(auth_service._hash_token(first["refresh_token"]))["expires_at"]
    res = client.post("/api/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert res.status_code == 200, res.text
    new = auth_repo.get_refresh_token(auth_service._hash_token(res.json()["refresh_token"]))
    assert abs((new["expires_at"] - horizon).total_seconds()) < 5


def test_password_login_for_the_demo_role_is_refused_when_entry_is_on(env, client):
    res = client.post("/api/auth/login", json={"email": "demo@test.local", "password": PW})
    assert res.status_code == 401
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT detail->>'reason' FROM audit_events WHERE event = 'auth.login.failed'")
        assert cur.fetchone()[0] == "demo_entry_only"


def test_password_login_for_other_roles_still_works_when_entry_is_on(env, client):
    assert client.post("/api/auth/login", json={"email": "admin@test.local", "password": PW}).status_code == 200


def test_password_login_for_the_demo_role_works_when_entry_is_off(env, client, monkeypatch):
    monkeypatch.setattr(settings, "demo_public_entry", False)
    assert client.post("/api/auth/login", json={"email": "demo@test.local", "password": PW}).status_code == 200
