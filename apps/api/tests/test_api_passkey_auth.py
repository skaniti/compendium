"""Passkey enrollment and sign-in endpoints (owner-passkeys, Task 4)."""
import pytest
from fastapi.testclient import TestClient

from backend.config.settings import settings
from backend.db import audit_repo, auth_repo, passkey_repo, user_repo
from backend.db.connection import get_conn
from backend.services import passkeys
from tests.soft_authenticator import SoftAuthenticator

SECRET = "t" * 40
ASSERT = {"X-Compendium-Tailnet-Assert": SECRET}
LOGIN = "owner@example.com"
OTHER_LOGIN = "other@example.com"
RP = "localhost"
ORIGIN = "http://localhost:3012"


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
        f"{LOGIN}=admin@test.local,{OTHER_LOGIN}=other@test.local,demo@example.com=demo",
    )
    monkeypatch.setattr(settings, "webauthn_rp_id", RP)
    monkeypatch.setattr(settings, "webauthn_origin", ORIGIN)
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


def _post(client, path, body, headers=None):
    return client.post(f"/api/auth/passkey{path}", json=body, headers={**ASSERT, **(headers or {})})


def _enroll(client, user_id, auth, login=LOGIN, trust=True):
    raw, _ = passkeys.new_enrollment(user_id, "1Password")
    opts = _post(client, "/enroll/options", {"tailnet_login": login, "enrollment_token": raw})
    assert opts.status_code == 200, opts.text
    response = auth.register(opts.json()["options"])
    return raw, _post(
        client,
        "/enroll/verify",
        {"tailnet_login": login, "enrollment_token": raw, "response": response, "trust_browser": trust},
    )


def _sign_in(client, auth, login=LOGIN, trust=False, **auth_kw):
    opts = _post(client, "/login/options", {"tailnet_login": login})
    assert opts.status_code == 200, opts.text
    response = auth.authenticate(opts.json()["options"], **auth_kw)
    return response, _post(
        client, "/login/verify", {"tailnet_login": login, "response": response, "trust_browser": trust}
    )


def _reason(event):
    rows = audit_repo.list_events(event=event)
    assert rows, f"no {event} row"
    return rows[0]["detail"]["reason"]


_OFF_BODIES = {
    "/login/options": {"tailnet_login": LOGIN},
    "/login/verify": {"tailnet_login": LOGIN, "response": {}},
    "/enroll/options": {"tailnet_login": LOGIN, "enrollment_token": "x"},
    "/enroll/verify": {"tailnet_login": LOGIN, "enrollment_token": "x", "response": {}},
}


@pytest.mark.parametrize("path", list(_OFF_BODIES))
def test_endpoints_404_when_passkeys_are_off(env, client, monkeypatch, path):
    monkeypatch.setattr(settings, "webauthn_rp_id", "")
    assert _post(client, path, _OFF_BODIES[path]).status_code == 404


def test_cloudflare_borne_requests_404(env, client):
    res = _post(client, "/login/options", {"tailnet_login": LOGIN}, headers={"CF-Connecting-IP": "203.0.113.9"})
    assert res.status_code == 404


def test_enrollment_registers_signs_in_and_trusts(env, client):
    auth = SoftAuthenticator(RP, ORIGIN)
    _, res = _enroll(client, env["admin"]["id"], auth)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["access_token"] and body["refresh_token"] and body["browser_token"]
    assert body["session_policy"]["remembered"] is True
    assert passkey_repo.count_active(env["admin"]["id"]) == 1
    registered = audit_repo.list_events(event="auth.passkey.registered")[0]["detail"]
    assert registered["label"] == "1Password" and registered["backup_eligible"] is True
    ok = audit_repo.list_events(event="auth.login.ok")[0]["detail"]
    assert ok["method"] == "passkey" and ok["trusted_browser_id"]


def test_second_enrollment_with_the_same_link_is_refused(env, client):
    auth = SoftAuthenticator(RP, ORIGIN)
    raw, first = _enroll(client, env["admin"]["id"], auth)
    assert first.status_code == 200
    again = _post(client, "/enroll/options", {"tailnet_login": LOGIN, "enrollment_token": raw})
    assert again.status_code == 410
    assert _reason("auth.passkey.register_failed") == "used"
    assert passkey_repo.count_active(env["admin"]["id"]) == 1


def test_two_option_calls_then_two_verifies_register_once(env, client):
    raw, _ = passkeys.new_enrollment(env["admin"]["id"], None)
    a, b = SoftAuthenticator(RP, ORIGIN), SoftAuthenticator(RP, ORIGIN)
    opts_a = _post(client, "/enroll/options", {"tailnet_login": LOGIN, "enrollment_token": raw}).json()["options"]
    opts_b = _post(client, "/enroll/options", {"tailnet_login": LOGIN, "enrollment_token": raw}).json()["options"]
    body = {"tailnet_login": LOGIN, "enrollment_token": raw, "trust_browser": False}
    assert _post(client, "/enroll/verify", {**body, "response": a.register(opts_a)}).status_code == 200
    assert _post(client, "/enroll/verify", {**body, "response": b.register(opts_b)}).status_code == 410
    assert passkey_repo.count_active(env["admin"]["id"]) == 1


def test_expired_unknown_and_foreign_links_are_410(env, client):
    expired, _ = passkeys.new_enrollment(env["admin"]["id"], None, minutes=0)
    res = _post(client, "/enroll/options", {"tailnet_login": LOGIN, "enrollment_token": expired})
    assert res.status_code == 410 and _reason("auth.passkey.register_failed") == "expired"
    res = _post(client, "/enroll/options", {"tailnet_login": LOGIN, "enrollment_token": "nope"})
    assert res.status_code == 410 and _reason("auth.passkey.register_failed") == "unknown"
    others, _ = passkeys.new_enrollment(env["other"]["id"], None)
    res = _post(client, "/enroll/options", {"tailnet_login": LOGIN, "enrollment_token": others})
    assert res.status_code == 410 and _reason("auth.passkey.register_failed") == "identity"


def test_enrollment_without_the_assert_secret_is_refused(env, client):
    raw, _ = passkeys.new_enrollment(env["admin"]["id"], None)
    res = client.post(
        "/api/auth/passkey/enroll/options",
        json={"tailnet_login": LOGIN, "enrollment_token": raw},
        headers={"X-Compendium-Tailnet-Assert": "wrong" * 10},
    )
    assert res.status_code == 410 and _reason("auth.passkey.register_failed") == "identity"


def test_a_failed_registration_keeps_the_link_usable(env, client):
    raw, _ = passkeys.new_enrollment(env["admin"]["id"], None)
    auth = SoftAuthenticator(RP, ORIGIN)
    body = {"tailnet_login": LOGIN, "enrollment_token": raw}
    opts = _post(client, "/enroll/options", body).json()["options"]
    bad = auth.register(opts, origin="https://evil.example.com")
    res = _post(client, "/enroll/verify", {**body, "response": bad})
    assert res.status_code == 401 and _reason("auth.passkey.register_failed") == "verify"
    # The same link still works for a second, good attempt.
    opts = _post(client, "/enroll/options", body).json()["options"]
    retry = _post(client, "/enroll/verify", {**body, "response": auth.register(opts)})
    assert retry.status_code == 200
    assert passkey_repo.count_active(env["admin"]["id"]) == 1


def test_sign_in_with_a_passkey(env, client):
    auth = SoftAuthenticator(RP, ORIGIN)
    _enroll(client, env["admin"]["id"], auth)
    _, res = _sign_in(client, auth)
    assert res.status_code == 200, res.text
    body = res.json()
    assert "browser_token" not in body
    assert body["session_policy"]["remembered"] is True
    assert passkey_repo.list_credentials(env["admin"]["id"])[0]["last_used_at"] is not None
    _, trusted = _sign_in(client, auth, trust=True)
    assert trusted.json()["browser_token"]


def test_no_passkey_is_409(env, client):
    res = _post(client, "/login/options", {"tailnet_login": LOGIN})
    assert res.status_code == 409
    assert _reason("auth.login.failed") == "no_passkey"


def test_unmapped_or_demo_login_is_refused(env, client):
    assert _post(client, "/login/options", {"tailnet_login": "stranger@example.com"}).status_code == 401
    assert _post(client, "/login/options", {"tailnet_login": "demo@example.com"}).status_code == 401
    assert _reason("auth.login.failed") == "login"


def test_a_replayed_sign_in_response_is_refused(env, client):
    auth = SoftAuthenticator(RP, ORIGIN)
    _enroll(client, env["admin"]["id"], auth)
    response, first = _sign_in(client, auth)
    assert first.status_code == 200
    again = _post(client, "/login/verify", {"tailnet_login": LOGIN, "response": response})
    assert again.status_code == 401 and _reason("auth.login.failed") == "challenge"


def test_another_accounts_passkey_is_refused(env, client):
    mine, theirs = SoftAuthenticator(RP, ORIGIN), SoftAuthenticator(RP, ORIGIN)
    _enroll(client, env["admin"]["id"], mine)
    _enroll(client, env["other"]["id"], theirs, login=OTHER_LOGIN)
    _, res = _sign_in(client, theirs, login=LOGIN)
    assert res.status_code == 401 and _reason("auth.login.failed") == "account_mismatch"


def test_a_foreign_user_handle_is_refused(env, client):
    auth = SoftAuthenticator(RP, ORIGIN)
    _enroll(client, env["admin"]["id"], auth)
    _, res = _sign_in(client, auth, user_handle=b"x" * 64)
    assert res.status_code == 401 and _reason("auth.login.failed") == "account_mismatch"


def test_counter_going_backwards_is_refused(env, client):
    auth = SoftAuthenticator(RP, ORIGIN, sign_count_step=1)
    _enroll(client, env["admin"]["id"], auth)
    assert _sign_in(client, auth)[1].status_code == 200  # stored count 1
    auth.sign_count = 0  # next response reports 1 again
    _, res = _sign_in(client, auth)
    assert res.status_code == 401 and _reason("auth.login.failed") == "counter"


@pytest.mark.parametrize("garbage", [{}, {"response": {}}, {"id": "AA", "rawId": "AA", "response": "x"}])
def test_a_garbage_sign_in_response_is_a_401(env, client, garbage):
    auth = SoftAuthenticator(RP, ORIGIN)
    _enroll(client, env["admin"]["id"], auth)
    _post(client, "/login/options", {"tailnet_login": LOGIN})
    res = _post(client, "/login/verify", {"tailnet_login": LOGIN, "response": garbage})
    assert res.status_code == 401 and _reason("auth.login.failed") == "challenge"


def test_a_tampered_signature_is_a_verify_failure(env, client, caplog):
    auth = SoftAuthenticator(RP, ORIGIN)
    _enroll(client, env["admin"]["id"], auth)
    opts = _post(client, "/login/options", {"tailnet_login": LOGIN}).json()["options"]
    response = auth.authenticate(opts)
    response["response"]["signature"] = response["response"]["signature"][::-1]
    with caplog.at_level("WARNING", logger="backend.services.passkeys"):
        res = _post(client, "/login/verify", {"tailnet_login": LOGIN, "response": response})
    assert res.status_code == 401 and _reason("auth.login.failed") == "verify"
    assert any("refused by verifier" in r.getMessage() for r in caplog.records)


def test_cleanup_sweeps_expired_challenges(env, client):
    from backend.api.main import cleanup_tokens_once

    passkey_repo.create_challenge("authenticate", b"a" * 32, env["admin"]["id"], minutes=0)
    cleanup_tokens_once()
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM webauthn_challenges")
        assert cur.fetchone()[0] == 0


def test_the_same_authenticator_through_a_new_link_is_refused(env, client):
    auth = SoftAuthenticator(RP, ORIGIN)
    _, first = _enroll(client, env["admin"]["id"], auth)
    assert first.status_code == 200
    _, second = _enroll(client, env["admin"]["id"], auth)
    assert second.status_code == 401
    assert _reason("auth.passkey.register_failed") == "verify"
    assert passkey_repo.count_active(env["admin"]["id"]) == 1


def test_a_counter_that_stops_counting_is_refused(env, client):
    auth = SoftAuthenticator(RP, ORIGIN, sign_count_step=1)
    _enroll(client, env["admin"]["id"], auth)
    assert _sign_in(client, auth)[1].status_code == 200  # stored count 1
    auth.sign_count_step = 0
    auth.sign_count = 0
    _, res = _sign_in(client, auth)
    assert res.status_code == 401 and _reason("auth.login.failed") == "counter"


def test_a_synced_passkey_with_zero_counters_signs_in_repeatedly(env, client):
    auth = SoftAuthenticator(RP, ORIGIN)
    _enroll(client, env["admin"]["id"], auth)
    assert _sign_in(client, auth)[1].status_code == 200
    assert _sign_in(client, auth)[1].status_code == 200


def test_a_counting_passkey_keeps_signing_in(env, client):
    auth = SoftAuthenticator(RP, ORIGIN, sign_count_step=1)
    _enroll(client, env["admin"]["id"], auth)
    assert _sign_in(client, auth)[1].status_code == 200
    assert _sign_in(client, auth)[1].status_code == 200


def test_another_accounts_challenge_is_refused(env, client):
    mine, theirs = SoftAuthenticator(RP, ORIGIN), SoftAuthenticator(RP, ORIGIN)
    _enroll(client, env["admin"]["id"], mine)
    _enroll(client, env["other"]["id"], theirs, login=OTHER_LOGIN)
    their_opts = _post(client, "/login/options", {"tailnet_login": OTHER_LOGIN}).json()["options"]
    response = mine.authenticate(their_opts)
    res = _post(client, "/login/verify", {"tailnet_login": LOGIN, "response": response})
    assert res.status_code == 401 and _reason("auth.login.failed") == "challenge"


def test_a_challenge_from_one_link_is_refused_on_another(env, client):
    raw_a, _ = passkeys.new_enrollment(env["admin"]["id"], None)
    raw_b, _ = passkeys.new_enrollment(env["admin"]["id"], None)
    auth = SoftAuthenticator(RP, ORIGIN)
    opts = _post(client, "/enroll/options", {"tailnet_login": LOGIN, "enrollment_token": raw_a}).json()["options"]
    res = _post(
        client,
        "/enroll/verify",
        {"tailnet_login": LOGIN, "enrollment_token": raw_b, "response": auth.register(opts)},
    )
    assert res.status_code == 401 and _reason("auth.passkey.register_failed") == "verify"
    assert passkey_repo.count_active(env["admin"]["id"]) == 0


def test_a_garbage_enroll_response_is_a_401_and_keeps_the_link(env, client):
    raw, _ = passkeys.new_enrollment(env["admin"]["id"], None)
    body = {"tailnet_login": LOGIN, "enrollment_token": raw}
    res = _post(client, "/enroll/verify", {**body, "response": {}})
    assert res.status_code == 401 and _reason("auth.passkey.register_failed") == "verify"
    assert _post(client, "/enroll/options", body).status_code == 200
