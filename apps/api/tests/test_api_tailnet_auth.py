"""Passwordless tailnet sign-in endpoints (tailnet-passwordless-login, Task 3)."""
import json

import pytest
from fastapi.testclient import TestClient

from backend.config.settings import settings
from backend.db import audit_repo, auth_repo, trusted_browser_repo, user_repo
from backend.db.connection import get_conn
from backend.services import auth_service, tailnet_login

SECRET = "t" * 40
ASSERT = {"X-Compendium-Tailnet-Assert": SECRET}
LOGIN = "owner@example.com"


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
    monkeypatch.setattr(settings, "tailnet_only_deployment", True)
    monkeypatch.setattr(settings, "tailnet_assert_secret", SECRET)
    monkeypatch.setattr(
        settings,
        "tailnet_login_map",
        f"{LOGIN}=admin@test.local,demo@example.com=demo,other@example.com=other@test.local",
    )
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
        cur.execute("DELETE FROM audit_events")
    admin = user_repo.create_user("admin@test.local", name="Admin")
    auth_repo.set_role(admin["id"], "admin")
    other = user_repo.create_user("other@test.local", name="Other")
    demo = user_repo.create_user("demo@test.local", name="Demo")
    auth_repo.set_role(demo["id"], "demo")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE users SET username='demo' WHERE id=%s", (demo["id"],))
    return {"admin": admin, "other": other, "demo": demo}


@pytest.fixture
def client():
    from backend.api.main import app

    return TestClient(app)


def _bearer(user):
    return {"Authorization": f"Bearer {auth_service.create_access_token(user['id'], user['email'])}"}


def _trust(client, user, login=LOGIN, headers=None):
    h = {**ASSERT, **_bearer(user), **(headers or {})}
    return client.post("/api/auth/tailnet/trust", json={"tailnet_login": login, "label": "Firefox"}, headers=h)


def _login(client, token, login=LOGIN, headers=None):
    h = {**ASSERT, **(headers or {})}
    return client.post("/api/auth/tailnet/login", json={"tailnet_login": login, "browser_token": token}, headers=h)


def _last_failure_reason():
    rows = audit_repo.list_events(event="auth.login.failed")
    assert rows, "no auth.login.failed row"
    return rows[0]["detail"]["reason"]


@pytest.mark.parametrize(
    "field,value",
    [("tailnet_only_deployment", False), ("tailnet_assert_secret", ""), ("tailnet_login_map", "")],
)
def test_both_endpoints_404_unless_fully_configured(env, client, monkeypatch, field, value):
    monkeypatch.setattr(settings, field, value)
    assert _trust(client, env["admin"]).status_code == 404
    assert _login(client, "x").status_code == 404


def test_cloudflare_header_is_refused(env, client):
    cf = {"CF-Connecting-IP": "203.0.113.9"}
    assert _trust(client, env["admin"], headers=cf).status_code == 404
    assert _login(client, "x", headers=cf).status_code == 404


def test_missing_or_wrong_assert_is_401(env, client):
    r = client.post("/api/auth/tailnet/login", json={"tailnet_login": LOGIN, "browser_token": "x"})
    assert r.status_code == 401 and _last_failure_reason() == "assert"
    r = _login(client, "x", headers={"X-Compendium-Tailnet-Assert": "wrong" * 10})
    assert r.status_code == 401


def test_unmapped_and_demo_logins_are_401(env, client):
    assert _login(client, "x", login="stranger@example.com").status_code == 401
    assert _last_failure_reason() == "login"
    assert _login(client, "x", login="demo@example.com").status_code == 401


def test_trust_requires_the_mapped_accounts_own_bearer(env, client):
    r = client.post(
        "/api/auth/tailnet/trust", json={"tailnet_login": LOGIN, "label": None}, headers=ASSERT
    )
    assert r.status_code == 401 and _last_failure_reason() == "bearer"
    assert _trust(client, env["other"]).status_code == 401
    assert _last_failure_reason() == "user"


def test_trust_refuses_an_acting_as_demo_token(env, client):
    admin = env["admin"]
    acting = auth_service.create_access_token(
        admin["id"], admin["email"], extra_claims={"acting_as_demo": True}
    )
    r = client.post(
        "/api/auth/tailnet/trust",
        json={"tailnet_login": LOGIN, "label": None},
        headers={**ASSERT, "Authorization": f"Bearer {acting}"},
    )
    assert r.status_code == 401 and _last_failure_reason() == "acting"


def test_trust_then_login_issues_a_remembered_session(env, client):
    r = _trust(client, env["admin"])
    assert r.status_code == 200
    token = r.json()["browser_token"]
    stored = trusted_browser_repo.list_all()
    assert len(stored) == 1 and stored[0]["label"] == "Firefox"
    assert trusted_browser_repo.get_active(tailnet_login.hash_browser_token(token)) is not None

    r = _login(client, token, login=" OWNER@example.com ")
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["id"] == env["admin"]["id"]
    assert body["session_policy"]["remembered"] is True
    refresh_row = auth_repo.get_refresh_token(auth_service._hash_token(body["refresh_token"]))
    assert refresh_row["remembered"] is True
    assert trusted_browser_repo.list_all()[0]["last_used_at"] is not None

    ok = audit_repo.list_events(event="auth.login.ok")[0]
    assert ok["detail"]["method"] == "tailnet"
    blob = json.dumps([e["detail"] for e in audit_repo.list_events()])
    for secret in (SECRET, token, body["access_token"], body["refresh_token"]):
        assert secret not in blob


def test_login_refuses_unknown_revoked_and_foreign_tokens(env, client):
    assert _login(client, "nope").status_code == 401
    assert _last_failure_reason() == "token"

    token = _trust(client, env["admin"]).json()["browser_token"]
    trusted_browser_repo.revoke_all()
    assert _login(client, token).status_code == 401

    raw, token_hash = tailnet_login.new_browser_token()
    trusted_browser_repo.create(env["other"]["id"], token_hash, None)
    assert _login(client, raw).status_code == 401
