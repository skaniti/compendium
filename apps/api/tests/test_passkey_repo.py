"""Passkey and break-glass rows (owner-passkeys, Task 2)."""
from datetime import datetime, timedelta, timezone

import pytest

from backend.config.settings import settings
from backend.db import audit_repo, auth_repo, break_glass_repo, passkey_repo, user_repo
from backend.db.connection import get_conn


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        connect(settings.test_database_url).close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

NEW_EVENTS = [
    "auth.passkey.enroll_link_issued",
    "auth.passkey.registered",
    "auth.passkey.register_failed",
    "auth.passkey.revoked",
    "auth.break_glass.issued",
    "auth.trusted_browser.revoked",
    "auth.sessions.ended",
]


@pytest.fixture
def owner():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
        cur.execute("DELETE FROM audit_events")
    return user_repo.create_user("owner@test.local", name="Owner")


def _cred(user_id, cid=b"c" * 32, label="1Password"):
    return passkey_repo.add_credential(
        user_id,
        credential_id=cid,
        public_key=b"k" * 77,
        sign_count=0,
        transports=["internal", "hybrid"],
        aaguid="00000000-0000-0000-0000-000000000000",
        backup_eligible=True,
        backed_up=True,
        label=label,
    )


def test_user_handle_is_created_once_and_is_64_random_bytes(owner):
    assert passkey_repo.get_user_handle(owner["id"]) is None
    first = passkey_repo.get_or_create_user_handle(owner["id"])
    assert len(first) == 64
    assert passkey_repo.get_or_create_user_handle(owner["id"]) == first
    assert passkey_repo.get_user_handle(owner["id"]) == first


def test_credential_lifecycle(owner):
    row_id = _cred(owner["id"])
    assert passkey_repo.count_active(owner["id"]) == 1
    assert passkey_repo.active_credential_ids(owner["id"]) == [b"c" * 32]
    cred = passkey_repo.get_active_credential(b"c" * 32)
    assert cred == {"id": row_id, "user_id": owner["id"], "public_key": b"k" * 77, "sign_count": 0}
    passkey_repo.record_use(row_id, 5, False)
    passkey_repo.record_use(row_id, 3, False)  # never moves backwards
    assert passkey_repo.get_active_credential(b"c" * 32)["sign_count"] == 5
    listed = passkey_repo.list_credentials(owner["id"])
    assert listed[0]["label"] == "1Password" and listed[0]["last_used_at"] is not None
    assert "public_key" not in listed[0] and "credential_id" not in listed[0]
    assert passkey_repo.revoke_credential(row_id) is True
    assert passkey_repo.revoke_credential(row_id) is False
    assert passkey_repo.get_active_credential(b"c" * 32) is None
    assert passkey_repo.count_active(owner["id"]) == 0


def test_enrollment_is_single_use(owner):
    eid = passkey_repo.create_enrollment(owner["id"], "h" * 64, "1Password", 10)
    e = passkey_repo.get_enrollment("h" * 64)
    assert e == {"id": eid, "user_id": owner["id"], "label": "1Password", "expired": False, "consumed": False}
    assert passkey_repo.consume_enrollment(eid) is True
    assert passkey_repo.consume_enrollment(eid) is False
    assert passkey_repo.get_enrollment("h" * 64)["consumed"] is True
    assert passkey_repo.get_enrollment("x" * 64) is None


def test_expired_enrollment_cannot_be_consumed(owner):
    eid = passkey_repo.create_enrollment(owner["id"], "e" * 64, None, 0)
    assert passkey_repo.get_enrollment("e" * 64)["expired"] is True
    assert passkey_repo.consume_enrollment(eid) is False


def test_challenge_is_single_use_and_purpose_bound(owner):
    eid = passkey_repo.create_enrollment(owner["id"], "h" * 64, None, 10)
    passkey_repo.create_challenge("register", b"r" * 32, owner["id"], enrollment_id=eid)
    assert passkey_repo.consume_challenge("authenticate", b"r" * 32) is None
    assert passkey_repo.consume_challenge("register", b"r" * 32) == {"user_id": owner["id"], "enrollment_id": eid}
    assert passkey_repo.consume_challenge("register", b"r" * 32) is None


def test_expired_challenges_are_refused_and_swept(owner):
    passkey_repo.create_challenge("authenticate", b"a" * 32, owner["id"], minutes=0)
    assert passkey_repo.consume_challenge("authenticate", b"a" * 32) is None
    assert passkey_repo.delete_expired_challenges() == 1


def test_break_glass_code_is_single_use_and_superseded(owner):
    first = break_glass_repo.issue(owner["id"], "hash-1", 15)
    second = break_glass_repo.issue(owner["id"], "hash-2", 15)
    assert break_glass_repo.live(owner["id"]) == {"id": second, "code_hash": "hash-2"}
    assert break_glass_repo.use(first) is False
    assert break_glass_repo.use(second) is True
    assert break_glass_repo.use(second) is False
    assert break_glass_repo.live(owner["id"]) is None


def test_expired_break_glass_code_is_not_live(owner):
    code_id = break_glass_repo.issue(owner["id"], "hash", 0)
    assert break_glass_repo.live(owner["id"]) is None
    assert break_glass_repo.use(code_id) is False


def test_refresh_token_carries_the_break_glass_marker(owner):
    expires = datetime.now(timezone.utc) + timedelta(days=7)
    auth_repo.save_refresh_token(owner["id"], "t" * 64, expires, remembered=False, break_glass=True)
    auth_repo.save_refresh_token(owner["id"], "u" * 64, expires)
    assert auth_repo.get_refresh_token("t" * 64)["break_glass"] is True
    assert auth_repo.get_refresh_token("u" * 64)["break_glass"] is False


def test_set_password_none_clears_the_hash(owner):
    auth_repo.set_password(owner["id"], "$2b$12$abc")
    auth_repo.set_password(owner["id"], None, via="cleared")
    assert auth_repo.get_user_by_login("owner@test.local")["password_hash"] is None
    assert audit_repo.list_events(event="user.password_set")[0]["detail"]["via"] == "cleared"


@pytest.mark.parametrize("event", NEW_EVENTS)
def test_new_audit_events_are_allowed(owner, event):
    audit_repo.record(event, subject_user_id=owner["id"], origin_class="cli", detail={"probe": 1})
    assert audit_repo.list_events(event=event), f"{event} was dropped by the allow-list"
