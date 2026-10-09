"""Audit-event hooks on the auth and key paths (audit-and-ops-journal Task 2).

Real DB. One assertion group per event; every test also asserts that the
credential used never appears in the row's detail. Fake credentials are
assembled at runtime.
"""

import json

import pytest
from fastapi.testclient import TestClient

from backend.config.settings import settings
from backend.db import audit_repo, auth_repo, user_repo
from backend.db.connection import get_conn
from backend.services import auth_service

PW = "pw-" + "x9" * 6
DEMO_PW = "dpw-" + "y7" * 6
INGRESS = {settings.session_ingress_header: settings.session_ingress_trusted_value}


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        connect(settings.test_database_url).close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "session_trust_missing_ingress", False)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
        cur.execute("DELETE FROM audit_events")
    admin = user_repo.create_user("admin@test.local", name="Admin")
    auth_repo.set_password(admin["id"], auth_service.hash_password(PW))
    auth_repo.set_role(admin["id"], "admin")
    demo = user_repo.create_user("demo@traversal.local", name="Demo")
    auth_repo.set_password(demo["id"], auth_service.hash_password(DEMO_PW))
    auth_repo.set_role(demo["id"], "demo")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE users SET username='demo' WHERE id=%s", (demo["id"],))
        cur.execute("DELETE FROM audit_events")
    return {"admin": admin, "demo": demo}


@pytest.fixture
def client():
    from backend.api.main import app

    return TestClient(app)


def _last(event):
    rows = audit_repo.list_events(event=event)
    assert rows, f"no {event} row"
    return rows[0]


def _no_secret(row, *secrets_):
    blob = json.dumps(row["detail"])
    for s in secrets_:
        assert s not in blob


def _login(client, ident="admin@test.local", pw=PW, headers=None):
    return client.post("/api/auth/login", json={"email": ident, "password": pw}, headers=headers)


def test_login_ok(env, client):
    r = _login(client, headers=INGRESS)
    assert r.status_code == 200
    row = _last("auth.login.ok")
    assert row["actor_user_id"] == row["subject_user_id"] == env["admin"]["id"]
    assert row["origin_class"] == "tailnet"
    assert row["client_hash"] is not None
    assert row["detail"] == {"role": "admin", "remembered": True}
    _no_secret(row, PW, r.json()["access_token"], r.json()["refresh_token"])


def test_login_failed_known_and_unknown(env, client):
    assert (
        _login(
            client, pw="wrong-" + PW, headers={settings.session_ingress_header: "public"}
        ).status_code
        == 401
    )
    row = _last("auth.login.failed")
    assert row["actor_user_id"] is None
    assert row["subject_user_id"] == env["admin"]["id"]
    assert row["origin_class"] == "public"
    assert row["detail"] == {"known_identifier": True}
    _no_secret(row, PW, "admin@test.local")

    assert _login(client, ident="nobody-here", pw=PW).status_code == 401
    row = _last("auth.login.failed")
    assert row["subject_user_id"] is None
    assert row["origin_class"] == "unknown"
    assert row["detail"] == {"known_identifier": False}
    _no_secret(row, "nobody-here", PW)


def test_refresh_ok_and_reuse_and_logout(env, client):
    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    r = client.post("/api/auth/refresh", json={"refresh_token": tok}, headers=INGRESS)
    assert r.status_code == 200
    row = _last("auth.refresh.ok")
    aid = env["admin"]["id"]
    assert row["actor_user_id"] == row["subject_user_id"] == aid
    assert row["origin_class"] == "tailnet"
    assert row["detail"] == {"remembered": True}
    _no_secret(row, tok, r.json()["refresh_token"])

    # replaying the already-rotated token trips reuse detection
    assert client.post("/api/auth/refresh", json={"refresh_token": tok}).status_code == 401
    row = _last("auth.refresh.reuse_detected")
    assert row["actor_user_id"] is None and row["subject_user_id"] == aid
    assert row["detail"] == {"revoked_all": True, "trusted_browsers_revoked": 0}
    _no_secret(row, tok)


def test_reuse_detection_revokes_trusted_browsers(env, client):
    from backend.db import trusted_browser_repo

    aid = env["admin"]["id"]
    browser_hash = "h" * 64
    trusted_browser_repo.create(aid, browser_hash, "Firefox")
    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    assert client.post("/api/auth/refresh", json={"refresh_token": tok}, headers=INGRESS).status_code == 200
    assert trusted_browser_repo.get_active(browser_hash) is not None
    assert client.post("/api/auth/refresh", json={"refresh_token": tok}).status_code == 401
    assert trusted_browser_repo.get_active(browser_hash) is None
    row = _last("auth.refresh.reuse_detected")
    assert row["detail"] == {"revoked_all": True, "trusted_browsers_revoked": 1}


def test_logout(env, client):
    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    assert (
        client.post("/api/auth/logout", json={"refresh_token": tok}, headers=INGRESS).status_code
        == 200
    )
    row = _last("auth.logout")
    assert row["actor_user_id"] == row["subject_user_id"] == env["admin"]["id"]
    assert row["origin_class"] == "tailnet"
    assert row["detail"] == {}
    _no_secret(row, tok)


def test_viewas_start_denied_stop(env, client):
    aid, did = env["admin"]["id"], env["demo"]["id"]
    admin_tok = _login(client).json()["access_token"]
    h = {"Authorization": f"Bearer {admin_tok}", **INGRESS}

    r = client.post("/api/auth/view-as", json={"profile": "demo"}, headers=h)
    assert r.status_code == 200
    demo_tok = r.json()["access_token"]
    row = _last("auth.viewas.start")
    assert row["actor_user_id"] == aid and row["subject_user_id"] == did
    assert row["origin_class"] == "tailnet"
    _no_secret(row, admin_tok, demo_tok)

    # nesting -> denied (admin identity carrying an acting claim)
    nest = auth_service.create_access_token(
        aid, "admin@test.local", extra_claims={"acting_as_demo": True, "admin_origin_user_id": aid}
    )
    nh = {"Authorization": f"Bearer {nest}"}
    assert client.post("/api/auth/view-as", json={"profile": "demo"}, headers=nh).status_code == 403
    row = _last("auth.viewas.denied")
    assert row["actor_user_id"] == aid and row["subject_user_id"] is None
    assert row["detail"] == {"reason": "already_viewing_as_demo"}
    _no_secret(row, nest)

    dh = {"Authorization": f"Bearer {demo_tok}"}
    r = client.post("/api/auth/return-to-admin", headers={**dh, **INGRESS})
    assert r.status_code == 200
    row = _last("auth.viewas.stop")
    assert row["actor_user_id"] == row["subject_user_id"] == aid
    _no_secret(row, demo_tok, r.json()["access_token"])


def test_viewas_denied_not_admin_and_demo_unavailable(env, client):
    plain = user_repo.create_user("plain@test.local", name="Plain")
    tok = auth_service.create_access_token(plain["id"], plain["email"])
    h = {"Authorization": f"Bearer {tok}"}
    assert client.post("/api/auth/view-as", json={"profile": "demo"}, headers=h).status_code == 403
    row = _last("auth.viewas.denied")
    assert row["actor_user_id"] == plain["id"]
    assert row["detail"] == {"reason": "not_admin"}
    _no_secret(row, tok)

    auth_repo.set_role(env["demo"]["id"], "user")
    atok = auth_service.create_access_token(env["admin"]["id"], "admin@test.local")
    assert (
        client.post(
            "/api/auth/view-as",
            json={"profile": "demo"},
            headers={"Authorization": f"Bearer {atok}"},
        ).status_code
        == 403
    )
    row = _last("auth.viewas.denied")
    assert row["actor_user_id"] == env["admin"]["id"]
    assert row["detail"] == {"reason": "demo_account_unavailable"}
    _no_secret(row, atok)


def test_api_key_auth_failed_only_for_presented_key(env, client):
    bad = "cmp_" + "bad0" * 8
    assert client.get("/api/auth/me", headers={"X-API-Key": bad}).status_code == 401
    row = _last("api_key.auth_failed")
    assert row["actor_user_id"] is None and row["subject_user_id"] is None
    assert row["detail"] == {"prefix": bad[:8]}
    _no_secret(row, bad)

    n = len(audit_repo.list_events(event="api_key.auth_failed"))
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert len(audit_repo.list_events(event="api_key.auth_failed")) == n


def test_rotate_api_key_records_prefixes_only(env):
    old = user_repo.get_user_by_id(env["admin"]["id"])["api_key_prefix"]
    res = user_repo.rotate_api_key("admin@test.local")
    row = _last("api_key.rotated")
    assert row["actor_user_id"] is None
    assert row["subject_user_id"] == env["admin"]["id"]
    assert row["origin_class"] == "cli"
    assert row["detail"] == {"old_prefix": old, "new_prefix": res["api_key_prefix"]}
    _no_secret(row, res["api_key"])


def test_set_role_and_password(env):
    uid = env["admin"]["id"]
    hashed = auth_service.hash_password(PW)
    auth_repo.set_role(uid, "user")
    row = _last("user.role_set")
    assert row["actor_user_id"] is None and row["subject_user_id"] == uid
    assert row["origin_class"] == "cli" and row["detail"] == {"role": "user"}
    auth_repo.set_password(uid, hashed)
    row = _last("user.password_set")
    assert row["subject_user_id"] == uid and row["origin_class"] == "cli"
    assert row["detail"] == {"via": "bootstrap"}
    _no_secret(row, PW, hashed)


def test_register_records_password_set_with_request_origin(env, client, monkeypatch):
    monkeypatch.delenv("DISABLE_REGISTRATION", raising=False)
    newpw = "np-" + "k3" * 6
    r = client.post(
        "/api/auth/register",
        json={"email": "newbie@test.local", "password": newpw},
        headers={settings.session_ingress_header: "public"},
    )
    assert r.status_code == 200
    row = _last("user.password_set")
    assert row["subject_user_id"] == r.json()["id"]
    assert row["origin_class"] == "public"
    assert row["client_hash"] is not None
    assert row["detail"] == {"via": "register"}
    _no_secret(row, newpw, "newbie@test.local")
