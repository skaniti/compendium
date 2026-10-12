"""scripts/owner_auth.py (owner-passkeys, Task 6)."""
import pytest

from backend.config.settings import settings
from backend.db import audit_repo, auth_repo, break_glass_repo, passkey_repo, trusted_browser_repo, user_repo
from backend.db.connection import get_conn
from backend.services import auth_service, break_glass
from scripts import owner_auth as cli


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        connect(settings.test_database_url).close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")


@pytest.fixture
def owner(monkeypatch):
    monkeypatch.setattr(settings, "tailnet_only_deployment", True)
    monkeypatch.setattr(settings, "tailnet_assert_secret", "t" * 40)
    monkeypatch.setattr(settings, "tailnet_login_map", "me@tailnet=owner@test.local")
    monkeypatch.setattr(settings, "webauthn_rp_id", "owner.example.com")
    monkeypatch.setattr(settings, "webauthn_origin", "")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
        cur.execute("DELETE FROM audit_events")
    user = user_repo.create_user("owner@test.local", name="Owner")
    auth_repo.set_role(user["id"], "admin")
    return user


def _events(name):
    return audit_repo.list_events(event=name)


def _passkey(user_id, cid=b"c" * 32):
    return passkey_repo.add_credential(
        user_id, credential_id=cid, public_key=b"k", sign_count=0, transports=[],
        aaguid="0", backup_eligible=True, backed_up=True, label="1Password",
    )


def test_default_account_needs_exactly_one_admin(owner, capsys):
    assert cli.main(["sessions", "end"]) == 0
    other = user_repo.create_user("second@test.local")
    auth_repo.set_role(other["id"], "admin")
    assert cli.main(["sessions", "end"]) == 1
    assert "more than one admin" in capsys.readouterr().err
    assert cli.main(["sessions", "end", "--user", "owner@test.local"]) == 0
    assert cli.main(["sessions", "end", "--user", "nobody@test.local"]) == 1


def test_passkeys_list_and_revoke(owner, capsys):
    pid = _passkey(owner["id"])
    assert cli.main(["passkeys", "list"]) == 0
    out = capsys.readouterr().out
    assert "1Password" in out and "active" in out
    raw = auth_service.create_refresh_token(owner["id"], remembered=True)
    assert cli.main(["passkeys", "revoke", str(pid), "--sessions"]) == 0
    out = capsys.readouterr().out
    assert "no active passkey left" in out and "enroll" in out and "break-glass" in out
    assert passkey_repo.count_active(owner["id"]) == 0
    assert auth_repo.get_refresh_token(auth_service._hash_token(raw))["revoked_at"] is not None
    assert _events("auth.passkey.revoked")[0]["detail"] == {"passkey_id": pid, "sessions_ended": True}
    assert _events("auth.sessions.ended")
    assert cli.main(["passkeys", "revoke", str(pid)]) == 0
    assert "already revoked" in capsys.readouterr().out
    assert cli.main(["passkeys", "revoke", str(pid + 1000)]) == 1


def test_browsers_list_shows_no_hashes(owner, capsys):
    trusted_browser_repo.create(owner["id"], "a" * 64, "Firefox on Linux")
    assert cli.main(["browsers", "list"]) == 0
    out = capsys.readouterr().out
    assert "Firefox on Linux" in out and "a" * 64 not in out


def test_browsers_revoke_one_is_audited(owner, capsys):
    bid = trusted_browser_repo.create(owner["id"], "b" * 64, None)
    assert cli.main(["browsers", "revoke", str(bid)]) == 0
    assert trusted_browser_repo.get_active("b" * 64) is None
    assert _events("auth.trusted_browser.revoked")[0]["detail"] == {"trusted_browser_ids": [bid], "sessions_ended": False}
    assert cli.main(["browsers", "revoke", str(bid)]) == 0
    assert "already revoked" in capsys.readouterr().out
    assert cli.main(["browsers", "revoke", str(bid + 1000)]) == 1


def test_browsers_revoke_with_sessions_on_an_already_revoked_row_still_ends_sessions(owner, capsys):
    bid = trusted_browser_repo.create(owner["id"], "f" * 64, None)
    raw = auth_service.create_refresh_token(owner["id"], remembered=True)
    assert cli.main(["browsers", "revoke", str(bid)]) == 0
    assert cli.main(["browsers", "revoke", str(bid), "--sessions"]) == 0
    out = capsys.readouterr().out
    assert "already revoked" in out and "revoked 1 refresh token" in out
    assert auth_repo.get_refresh_token(auth_service._hash_token(raw))["revoked_at"] is not None


def test_browsers_revoke_all(owner, capsys):
    ids = [trusted_browser_repo.create(owner["id"], c * 64, None) for c in "pq"]
    assert cli.main(["browsers", "revoke-all", "--sessions"]) == 0
    assert "revoked 2 browser(s)" in capsys.readouterr().out
    assert _events("auth.trusted_browser.revoked")[0]["detail"] == {"trusted_browser_ids": ids, "sessions_ended": True}


def test_sessions_end(owner, capsys):
    auth_service.create_refresh_token(owner["id"])
    auth_service.create_refresh_token(owner["id"])
    assert cli.main(["sessions", "end"]) == 0
    assert "revoked 2 refresh token" in capsys.readouterr().out
    assert _events("auth.sessions.ended")[0]["detail"] == {"refresh_tokens_revoked": 2}


def test_enroll_prints_a_fragment_link(owner, capsys):
    assert cli.main(["enroll", "--label", "1Password"]) == 0
    out = capsys.readouterr().out
    link = next(line.strip() for line in out.splitlines() if "/passkey/enroll#" in line)
    assert link.startswith("https://owner.example.com/passkey/enroll#")
    token = link.split("#", 1)[1]
    from backend.services import passkeys

    enrollment = passkey_repo.get_enrollment(passkeys.hash_token(token))
    assert enrollment["user_id"] == owner["id"] and enrollment["label"] == "1Password"
    detail = _events("auth.passkey.enroll_link_issued")[0]["detail"]
    assert detail["label"] == "1Password" and detail["minutes"] == 10
    assert token not in str(detail)


def test_enroll_and_break_glass_refuse_when_passkeys_are_off(owner, monkeypatch, capsys):
    monkeypatch.setattr(settings, "webauthn_rp_id", "")
    assert cli.main(["enroll"]) == 1
    assert cli.main(["break-glass"]) == 1
    assert "passkeys are off" in capsys.readouterr().err


def test_break_glass_prints_a_working_code(owner, capsys):
    assert cli.main(["break-glass", "--minutes", "5"]) == 0
    out = capsys.readouterr().out
    code = next(w for w in out.split() if w.count("-") == 3)
    assert break_glass.use_code(owner["id"], code) is not None
    assert _events("auth.break_glass.issued")[0]["detail"]["minutes"] == 5
    assert cli.main(["break-glass", "--minutes", "61"]) == 1


def test_password_clear(owner):
    auth_repo.set_password(owner["id"], auth_service.hash_password("pw-123456789"))
    assert cli.main(["password", "clear"]) == 0
    assert auth_repo.get_user_by_login("owner@test.local")["password_hash"] is None
    assert _events("user.password_set")[0]["detail"]["via"] == "cleared"


def test_browsers_revoke_with_sessions_ends_the_accounts_refresh_tokens(owner, capsys):
    bid = trusted_browser_repo.create(owner["id"], "d" * 64, None)
    raw = auth_service.create_refresh_token(owner["id"], remembered=True)
    assert cli.main(["browsers", "revoke", str(bid), "--sessions"]) == 0
    assert trusted_browser_repo.get_active("d" * 64) is None
    assert auth_repo.get_refresh_token(auth_service._hash_token(raw))["revoked_at"] is not None
    assert "revoked 1 refresh token" in capsys.readouterr().out


def test_browsers_revoke_alone_leaves_refresh_tokens(owner):
    bid = trusted_browser_repo.create(owner["id"], "e" * 64, None)
    raw = auth_service.create_refresh_token(owner["id"], remembered=True)
    assert cli.main(["browsers", "revoke", str(bid)]) == 0
    assert auth_repo.get_refresh_token(auth_service._hash_token(raw))["revoked_at"] is None


def test_browsers_revoke_already_revoked_without_sessions_leaves_tokens(owner):
    bid = trusted_browser_repo.create(owner["id"], "g" * 64, None)
    raw = auth_service.create_refresh_token(owner["id"], remembered=True)
    assert cli.main(["browsers", "revoke", str(bid)]) == 0
    assert cli.main(["browsers", "revoke", str(bid)]) == 0
    assert auth_repo.get_refresh_token(auth_service._hash_token(raw))["revoked_at"] is None


def test_browsers_list_marks_rows_older_than_400_days_expired(owner, capsys):
    old = trusted_browser_repo.create(owner["id"], "h" * 64, "Old one")
    trusted_browser_repo.create(owner["id"], "i" * 64, "Fresh one")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE trusted_browsers SET created_at = now() - interval '401 days' WHERE id = %s",
            (old,),
        )
    assert cli.main(["browsers", "list"]) == 0
    lines = {l.split("label=")[1]: l for l in capsys.readouterr().out.splitlines() if "label=" in l}
    assert " expired " in lines["Old one"] and " active " not in lines["Old one"]
    assert " active " in lines["Fresh one"]


def test_browsers_revoke_all_for_a_named_user_with_sessions(owner):
    trusted_browser_repo.create(owner["id"], "c" * 64, None)
    raw = auth_service.create_refresh_token(owner["id"], remembered=True)
    assert cli.main(["browsers", "revoke-all", "--user", "owner@test.local", "--sessions"]) == 0
    assert trusted_browser_repo.get_active("c" * 64) is None
    assert auth_repo.get_refresh_token(auth_service._hash_token(raw))["revoked_at"] is not None


def test_browsers_revoke_all_unknown_user_fails(owner):
    assert cli.main(["browsers", "revoke-all", "--user", "nobody@test.local"]) == 1
