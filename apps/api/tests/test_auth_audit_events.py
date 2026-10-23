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


def _age_rotation(raw_token, seconds):
    """Make the rotation that revoked ``raw_token`` look ``seconds`` old (the
    reuse grace window, backlog #43, measures from rotated_at)."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE refresh_tokens SET rotated_at = NOW() - make_interval(secs => %s) "
            "WHERE token_hash = %s AND rotated_at IS NOT NULL",
            (seconds, auth_service._hash_token(raw_token)),
        )
        assert cur.rowcount == 1


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

    # replaying the already-rotated token, past the reuse grace window, trips
    # reuse detection
    _age_rotation(tok, 3600)
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
    _age_rotation(tok, 3600)
    assert client.post("/api/auth/refresh", json={"refresh_token": tok}).status_code == 401
    assert trusted_browser_repo.get_active(browser_hash) is None
    row = _last("auth.refresh.reuse_detected")
    assert row["detail"] == {"revoked_all": True, "trusted_browsers_revoked": 1}


def _refresh(client, tok):
    return client.post("/api/auth/refresh", json={"refresh_token": tok}, headers=INGRESS)


def test_demo_reuse_refuses_only_the_replayed_token(env, client):
    tok_a = _login(client, ident="demo@traversal.local", pw=DEMO_PW, headers=INGRESS).json()[
        "refresh_token"
    ]
    tok_b = _login(client, ident="demo@traversal.local", pw=DEMO_PW, headers=INGRESS).json()[
        "refresh_token"
    ]
    assert _refresh(client, tok_a).status_code == 200
    assert _refresh(client, tok_a).status_code == 401
    # the other demo session survives: one replay must not log out every visitor
    assert _refresh(client, tok_b).status_code == 200
    row = _last("auth.refresh.reuse_detected")
    assert row["subject_user_id"] == env["demo"]["id"]
    assert row["detail"] == {"revoked_all": False, "role": "demo"}


def test_reuse_by_other_roles_still_revokes_everything(env, client):
    tok_a = _login(client, headers=INGRESS).json()["refresh_token"]
    tok_b = _login(client, headers=INGRESS).json()["refresh_token"]
    assert _refresh(client, tok_a).status_code == 200
    _age_rotation(tok_a, 3600)
    assert _refresh(client, tok_a).status_code == 401
    assert _refresh(client, tok_b).status_code == 401


def test_replay_inside_grace_window_is_a_benign_race(env, client):
    """Two refreshes racing with the same token: the second presents a token
    the first just rotated. It gets its own fresh pair, nothing is revoked,
    and the audit rows are flagged so the race is distinguishable from theft."""
    from backend.db import trusted_browser_repo

    aid = env["admin"]["id"]
    browser_hash = "g" * 64
    trusted_browser_repo.create(aid, browser_hash, "Firefox")
    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    first = _refresh(client, tok)
    assert first.status_code == 200
    second = _refresh(client, tok)
    assert second.status_code == 200
    assert second.json()["refresh_token"] != first.json()["refresh_token"]

    # both children are live sessions, the browser is still trusted
    assert _refresh(client, first.json()["refresh_token"]).status_code == 200
    assert _refresh(client, second.json()["refresh_token"]).status_code == 200
    assert trusted_browser_repo.get_active(browser_hash) is not None

    reuse = _last("auth.refresh.reuse_detected")
    assert reuse["subject_user_id"] == aid
    assert reuse["detail"]["revoked_all"] is False
    assert reuse["detail"]["grace_window"] is True
    assert 0 <= reuse["detail"]["age_seconds"] < 30
    _no_secret(reuse, tok, first.json()["refresh_token"], second.json()["refresh_token"])
    graced = [
        r
        for r in audit_repo.list_events(event="auth.refresh.ok")
        if r["detail"].get("grace_reuse")
    ]
    assert len(graced) == 1
    assert graced[0]["detail"] == {"remembered": True, "grace_reuse": True}


@pytest.mark.parametrize("age,benign", [(29, True), (31, False)])
def test_grace_window_edge_uses_the_setting(env, client, age, benign):
    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    assert _refresh(client, tok).status_code == 200
    _age_rotation(tok, age)
    assert _refresh(client, tok).status_code == (200 if benign else 401)
    detail = _last("auth.refresh.reuse_detected")["detail"]
    assert detail["revoked_all"] is (not benign)


def test_grace_window_setting_zero_disables_grace(env, client, monkeypatch):
    monkeypatch.setattr(settings, "refresh_reuse_grace_seconds", 0)
    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    assert _refresh(client, tok).status_code == 200
    assert _refresh(client, tok).status_code == 401
    assert _last("auth.refresh.reuse_detected")["detail"]["revoked_all"] is True


def test_logged_out_token_gets_no_grace(env, client):
    """logout revokes without rotating, so replaying that token right after
    sign-out is full reuse, not a race."""
    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    assert client.post("/api/auth/logout", json={"refresh_token": tok}, headers=INGRESS).status_code == 200
    assert _refresh(client, tok).status_code == 401
    detail = _last("auth.refresh.reuse_detected")["detail"]
    assert detail["revoked_all"] is True
    assert "grace_window" not in detail


def test_logout_after_rotation_is_not_undone_by_replaying_the_old_token(env, client):
    """tok rotates to new; the user signs out (revoking new); a replay of tok
    inside the window must NOT mint a session. Falls back to full revocation,
    audited with the reason grace was refused."""
    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    new = _refresh(client, tok).json()["refresh_token"]
    assert client.post("/api/auth/logout", json={"refresh_token": new}, headers=INGRESS).status_code == 200
    assert _refresh(client, tok).status_code == 401
    detail = _last("auth.refresh.reuse_detected")["detail"]
    assert detail["revoked_all"] is True
    assert detail["grace_denied"] == "session_revoked"


def test_revoke_all_after_rotation_is_not_undone_by_replaying_the_old_token(env, client):
    aid = env["admin"]["id"]
    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    new = _refresh(client, tok).json()["refresh_token"]
    auth_repo.revoke_all_user_tokens(aid)
    assert _refresh(client, tok).status_code == 401
    assert _last("auth.refresh.reuse_detected")["detail"]["grace_denied"] == "session_revoked"
    assert _refresh(client, new).status_code == 401


def test_unrelated_older_signout_does_not_block_grace(env, client):
    """A sign-out that happened BEFORE the rotation is not 'since rotation'."""
    old_tok = _login(client, headers=INGRESS).json()["refresh_token"]
    client.post("/api/auth/logout", json={"refresh_token": old_tok}, headers=INGRESS)
    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    assert _refresh(client, tok).status_code == 200
    assert _refresh(client, tok).status_code == 200


def test_rotation_stamps_rotated_at_and_other_revocations_do_not(env, client):
    aid = env["admin"]["id"]
    rotated = _login(client, headers=INGRESS).json()["refresh_token"]
    logged_out = _login(client, headers=INGRESS).json()["refresh_token"]
    swept = _login(client, headers=INGRESS).json()["refresh_token"]
    live = _refresh(client, rotated).json()["refresh_token"]
    client.post("/api/auth/logout", json={"refresh_token": logged_out}, headers=INGRESS)

    def row(raw):
        return auth_repo.get_refresh_token(auth_service._hash_token(raw))

    assert row(rotated)["rotated_at"] is not None
    assert row(rotated)["revoked_at"] is not None
    assert 0 <= row(rotated)["rotated_age_seconds"] < 30
    assert row(logged_out)["rotated_at"] is None
    assert row(live)["rotated_at"] is None and row(live)["revoked_at"] is None
    auth_repo.revoke_all_user_tokens(aid)
    assert row(swept)["rotated_at"] is None and row(swept)["rotated_age_seconds"] is None


def test_mark_refresh_token_rotated_is_an_atomic_claim(env, client):
    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    h = auth_service._hash_token(tok)
    assert auth_repo.mark_refresh_token_rotated(h) is True
    assert auth_repo.mark_refresh_token_rotated(h) is False
    assert auth_repo.mark_refresh_token_rotated("0" * 64) is False


def test_simultaneous_rotations_of_one_token_both_succeed_without_revoking(env, client):
    """The race the grace window exists for, for real: several threads present
    the same live token at the same instant. One wins the atomic claim; the
    rest land in the grace branch. Nobody is revoked and nobody gets None."""
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    tok = _login(client, headers=INGRESS).json()["refresh_token"]
    n = 4
    gate = Barrier(n)

    def go(_):
        gate.wait()
        return auth_service.rotate_refresh_token(tok, ingress_trusted=True)

    with ThreadPoolExecutor(max_workers=n) as pool:
        results = list(pool.map(go, range(n)))

    assert all(r is not None for r in results)
    refreshes = {r[1] for r in results}
    assert len(refreshes) == n
    for raw in refreshes:
        assert auth_service.rotate_refresh_token(raw, ingress_trusted=True) is not None
    assert not [
        r
        for r in audit_repo.list_events(event="auth.refresh.reuse_detected")
        if r["detail"].get("revoked_all")
    ]


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
