"""Break-glass sign-in (owner-passkeys, Task 5)."""
import pytest
from fastapi.testclient import TestClient

from backend.config.settings import settings
from backend.db import audit_repo, auth_repo, break_glass_repo, trusted_browser_repo, user_repo
from backend.db.connection import get_conn
from backend.services import auth_service, break_glass

PW = "pw-" + "x9" * 6
SECRET = "t" * 40
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
    monkeypatch.setattr(settings, "tailnet_login_map", f"{LOGIN}=admin@test.local")
    monkeypatch.setattr(settings, "webauthn_rp_id", "localhost")
    monkeypatch.setattr(settings, "webauthn_origin", "http://localhost:3012")
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


def _login(client, secret, email="admin@test.local", trust=None):
    body = {"email": email, "password": secret}
    headers = {}
    if trust:
        body["trust_tailnet_login"] = trust
        headers["X-Compendium-Tailnet-Assert"] = SECRET
    return client.post("/api/auth/login", json=body, headers=headers)


def test_code_format_and_normalising():
    code = break_glass.new_code()
    groups = code.split("-")
    assert len(groups) == 4 and all(len(g) == 5 for g in groups)
    assert set(code.replace("-", "")) <= set(break_glass.ALPHABET)
    assert break_glass.normalize(" ab-cd e ") == "ABCDE"


def test_minutes_are_bounded(env):
    with pytest.raises(ValueError):
        break_glass.issue(env["admin"]["id"], 0)
    with pytest.raises(ValueError):
        break_glass.issue(env["admin"]["id"], 61)


def test_password_is_refused_while_passkeys_are_on(env, client):
    res = _login(client, PW)
    assert res.status_code == 401
    detail = audit_repo.list_events(event="auth.login.failed")[0]["detail"]
    assert detail == {"known_identifier": True, "method": "break_glass", "reason": "code"}


def test_a_code_signs_in_once_into_a_plain_session(env, client):
    code, _ = break_glass.issue(env["admin"]["id"])
    res = _login(client, code.lower().replace("-", " "), trust=LOGIN)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["session_policy"]["remembered"] is False
    assert "browser_token" not in body
    assert trusted_browser_repo.list_all() == []
    stored = auth_repo.get_refresh_token(auth_service._hash_token(body["refresh_token"]))
    assert stored["break_glass"] is True and stored["remembered"] is False
    ok = audit_repo.list_events(event="auth.login.ok")[0]["detail"]
    assert ok["method"] == "break_glass" and ok["remembered"] is False
    assert _login(client, code).status_code == 401


def test_expired_and_superseded_codes_are_refused(env, client):
    break_glass_repo.issue(env["admin"]["id"], auth_service.hash_password("EXPIREDCODE"), 0)
    assert _login(client, "EXPIREDCODE").status_code == 401
    old, _ = break_glass.issue(env["admin"]["id"])
    new, _ = break_glass.issue(env["admin"]["id"])
    assert _login(client, old).status_code == 401
    assert _login(client, new).status_code == 200


def test_password_login_is_unchanged_when_passkeys_are_off(env, client, monkeypatch):
    monkeypatch.setattr(settings, "webauthn_rp_id", "")
    assert _login(client, PW).status_code == 200


def test_the_demo_account_keeps_its_own_path(env, client):
    assert _login(client, PW, email="demo@test.local").status_code == 200


def test_rotation_keeps_a_break_glass_session_plain(env, client):
    code, _ = break_glass.issue(env["admin"]["id"])
    raw = _login(client, code).json()["refresh_token"]
    _, new_raw, policy = auth_service.rotate_refresh_token(raw, ingress_trusted=True)
    assert policy["remembered"] is False
    stored = auth_repo.get_refresh_token(auth_service._hash_token(new_raw))
    assert stored["break_glass"] is True and stored["remembered"] is False


def test_an_overlong_value_is_refused_and_the_real_code_still_works(env, client):
    code, _ = break_glass.issue(env["admin"]["id"])
    assert _login(client, "A" * 128).status_code == 401
    detail = audit_repo.list_events(event="auth.login.failed")[0]["detail"]
    assert detail == {"known_identifier": True, "method": "break_glass", "reason": "code"}
    assert _login(client, code).status_code == 200


def test_a_code_is_refused_once_passkeys_are_off(env, client, monkeypatch):
    code, _ = break_glass.issue(env["admin"]["id"])
    monkeypatch.setattr(settings, "webauthn_rp_id", "")
    assert _login(client, code).status_code == 401


def test_rotating_twice_keeps_a_break_glass_session_plain(env, client):
    code, _ = break_glass.issue(env["admin"]["id"])
    raw = _login(client, code).json()["refresh_token"]
    _, once, _ = auth_service.rotate_refresh_token(raw, ingress_trusted=True)
    _, twice, policy = auth_service.rotate_refresh_token(once, ingress_trusted=True)
    assert policy["remembered"] is False
    stored = auth_repo.get_refresh_token(auth_service._hash_token(twice))
    assert stored["break_glass"] is True and stored["remembered"] is False
