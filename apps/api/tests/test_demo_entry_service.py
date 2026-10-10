"""Demo account lookup, bounded refresh tokens and audit events (demo-one-click-entry, Task 2)."""
from datetime import datetime, timedelta, timezone

import pytest

from backend.config.settings import settings
from backend.db import audit_repo, auth_repo, user_repo
from backend.db.connection import get_conn
from backend.services import auth_service


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        connect(settings.test_database_url).close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")


@pytest.fixture
def accounts():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
        cur.execute("DELETE FROM audit_events")
    admin = user_repo.create_user("admin@test.local", name="Admin")
    auth_repo.set_role(admin["id"], "admin")
    demo = user_repo.create_user("demo@test.local", name="Demo")
    auth_repo.set_role(demo["id"], "demo")
    return {"admin": admin, "demo": demo}


def _row(raw: str) -> dict:
    return auth_repo.get_refresh_token(auth_service._hash_token(raw))


def test_get_user_by_role_returns_the_single_demo_account(accounts):
    row = auth_repo.get_user_by_role("demo")
    assert row["id"] == accounts["demo"]["id"]
    assert row["email"] == "demo@test.local"


def test_get_user_by_role_is_none_without_a_match(accounts):
    assert auth_repo.get_user_by_role("viewer") is None


def test_get_user_by_role_refuses_ambiguity(accounts):
    other = user_repo.create_user("demo2@test.local", name="Demo2")
    auth_repo.set_role(other["id"], "demo")
    with pytest.raises(RuntimeError, match="more than one"):
        auth_repo.get_user_by_role("demo")


def test_refresh_token_expires_in_override(accounts):
    raw = auth_service.create_refresh_token(accounts["demo"]["id"], expires_in=timedelta(hours=24))
    expires = _row(raw)["expires_at"].replace(tzinfo=timezone.utc)
    assert abs((expires - datetime.now(timezone.utc)) - timedelta(hours=24)) < timedelta(minutes=1)


def test_refresh_token_default_lifetime_is_unchanged(accounts):
    raw = auth_service.create_refresh_token(accounts["admin"]["id"])
    expires = _row(raw)["expires_at"].replace(tzinfo=timezone.utc)
    want = timedelta(days=settings.jwt_refresh_token_expire_days)
    assert abs((expires - datetime.now(timezone.utc)) - want) < timedelta(minutes=1)


def test_refresh_token_cap_never_extends(accounts):
    cap = datetime.now(timezone.utc) + timedelta(hours=2)
    raw = auth_service.create_refresh_token(accounts["demo"]["id"], expires_at_cap=cap)
    expires = _row(raw)["expires_at"].replace(tzinfo=timezone.utc)
    assert abs(expires - cap) < timedelta(seconds=5)


def test_rotation_keeps_the_demo_horizon(accounts):
    raw = auth_service.create_refresh_token(accounts["demo"]["id"], expires_in=timedelta(hours=24))
    horizon = _row(raw)["expires_at"].replace(tzinfo=timezone.utc)
    rotated = auth_service.rotate_refresh_token(raw, ingress_trusted=False)
    assert rotated is not None
    _, new_raw, policy = rotated
    new_expires = _row(new_raw)["expires_at"].replace(tzinfo=timezone.utc)
    assert abs(new_expires - horizon) < timedelta(seconds=5)
    assert policy["remembered"] is False


def test_rotation_of_other_roles_still_slides(accounts):
    raw = auth_service.create_refresh_token(accounts["admin"]["id"], expires_in=timedelta(hours=1))
    rotated = auth_service.rotate_refresh_token(raw, ingress_trusted=False)
    _, new_raw, _ = rotated
    new_expires = _row(new_raw)["expires_at"].replace(tzinfo=timezone.utc)
    assert new_expires - datetime.now(timezone.utc) > timedelta(days=1)


@pytest.mark.parametrize("event", ["auth.demo_entry.ok", "auth.demo_entry.failed"])
def test_audit_allow_list_accepts_the_demo_entry_events(accounts, event):
    audit_repo.record(event, origin_class="public", client_key="k", detail={"reason": "x"})
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM audit_events WHERE event = %s", (event,))
        assert cur.fetchone()[0] == 1


def test_cleanup_expired_only_keeps_revoked_unexpired_rows(accounts):
    uid = accounts["demo"]["id"]
    expired = auth_service.create_refresh_token(uid, expires_in=timedelta(hours=1))
    revoked = auth_service.create_refresh_token(uid, expires_in=timedelta(hours=1))
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE token_hash = %s",
            (auth_service._hash_token(expired),),
        )
    auth_repo.revoke_refresh_token(auth_service._hash_token(revoked))
    assert auth_repo.cleanup_expired_only() == 1
    assert _row(expired) is None
    assert _row(revoked) is not None
