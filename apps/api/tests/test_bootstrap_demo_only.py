"""BOOTSTRAP_DEMO_ONLY: the public demo database gets no admin account
(tailnet-owner-demo-split, 2026-10-06)."""
import uuid

import pytest

from backend.db import auth_repo, user_repo
from backend.db.connection import get_conn
from backend.scripts import bootstrap_user


def _user_ids() -> set[int]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM users")
        return {r[0] for r in cur.fetchall()}


@pytest.fixture
def demo_email(monkeypatch):
    email = f"demo-only-{uuid.uuid4().hex[:8]}@test.local"
    monkeypatch.setenv("BOOTSTRAP_DEMO_EMAIL", email)
    monkeypatch.setenv("BOOTSTRAP_DEMO_PASSWORD", "pw-for-test")
    monkeypatch.setenv("BOOTSTRAP_DEMO_USERNAME", "")  # tests that need it set their own
    monkeypatch.delenv("BOOTSTRAP_EMAIL", raising=False)
    monkeypatch.delenv("BOOTSTRAP_PASSWORD", raising=False)
    yield email
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM users WHERE email = %s", (email,))


def test_demo_only_creates_exactly_the_demo_user(monkeypatch, demo_email):
    monkeypatch.setenv("BOOTSTRAP_DEMO_ONLY", "1")
    before = _user_ids()
    bootstrap_user.bootstrap()
    new = _user_ids() - before
    assert len(new) == 1
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT email, role FROM users WHERE id = %s", (next(iter(new)),))
        assert cur.fetchone() == (demo_email, "demo")


def test_demo_only_needs_no_primary_credentials(monkeypatch, demo_email):
    monkeypatch.setenv("BOOTSTRAP_DEMO_ONLY", "TRUE")
    bootstrap_user.bootstrap()  # must not sys.exit for missing BOOTSTRAP_EMAIL


def test_without_demo_only_primary_credentials_are_still_required(
    monkeypatch, demo_email
):
    monkeypatch.delenv("BOOTSTRAP_DEMO_ONLY", raising=False)
    with pytest.raises(SystemExit):
        bootstrap_user.bootstrap()


def test_demo_row_gets_its_published_username(monkeypatch, demo_email):
    username = f"demo-{uuid.uuid4().hex[:8]}"
    monkeypatch.setenv("BOOTSTRAP_DEMO_ONLY", "1")
    monkeypatch.setenv("BOOTSTRAP_DEMO_USERNAME", username)
    bootstrap_user.bootstrap()
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM users WHERE email = %s", (demo_email,))
        demo_id = cur.fetchone()[0]
    assert auth_repo.get_user_by_login(username)["id"] == demo_id
    assert auth_repo.get_user_by_login(username.upper())["id"] == demo_id


def test_username_held_by_another_user_is_not_taken(monkeypatch, demo_email):
    username = f"held-{uuid.uuid4().hex[:8]}"
    other_email = f"other-{uuid.uuid4().hex[:8]}@test.local"
    other_id = user_repo.create_user(other_email, name="other")["id"]
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE users SET username = %s WHERE id = %s", (username, other_id))
    try:
        monkeypatch.setenv("BOOTSTRAP_DEMO_ONLY", "1")
        monkeypatch.setenv("BOOTSTRAP_DEMO_USERNAME", username.upper())
        bootstrap_user.bootstrap()
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT username FROM users WHERE email = %s", (demo_email,))
            assert cur.fetchone()[0] is None
        assert auth_repo.get_user_by_login(username)["id"] == other_id
    finally:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (other_id,))
