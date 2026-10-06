"""BOOTSTRAP_DEMO_ONLY: the public demo database gets no admin account
(tailnet-owner-demo-split, 2026-10-06)."""
import uuid

import pytest

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
