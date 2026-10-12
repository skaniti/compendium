"""BOOTSTRAP_PRIMARY_ONLY: the root Docker stack creates only the owner's
login, never the demo user (docker-own-data-stack, 2026-10-12)."""
import uuid

import pytest

from backend.db import auth_repo, user_repo
from backend.db.connection import get_conn
from backend.scripts import bootstrap_user
from backend.services.auth_service import hash_password, verify_password


def _user_ids() -> set[int]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM users")
        return {r[0] for r in cur.fetchall()}


def _row(email: str):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, role FROM users WHERE email = %s", (email,))
        return cur.fetchone()


def _delete_users(*emails: str) -> None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM users WHERE email = ANY(%s)", (list(emails),))


@pytest.fixture
def primary(monkeypatch):
    tag = uuid.uuid4().hex[:8]
    email = f"primary-only-{tag}@test.local"
    demo_email = f"primary-only-demo-{tag}@test.local"
    monkeypatch.setenv("BOOTSTRAP_PRIMARY_ONLY", "1")
    monkeypatch.delenv("BOOTSTRAP_DEMO_ONLY", raising=False)
    monkeypatch.setenv("BOOTSTRAP_EMAIL", email)
    monkeypatch.setenv("BOOTSTRAP_PASSWORD", "long-enough-pw")
    # A fresh legacy email, so the rename path can never adopt a shared row.
    monkeypatch.setenv("BOOTSTRAP_LEGACY_EMAIL", f"legacy-{tag}@test.local")
    # What the demo path would create; asserted absent.
    monkeypatch.setenv("BOOTSTRAP_DEMO_EMAIL", demo_email)
    monkeypatch.setenv("BOOTSTRAP_DEMO_USERNAME", "")
    yield {"email": email, "demo_email": demo_email}
    _delete_users(email, demo_email)


def test_creates_only_the_primary_admin(primary):
    before = _user_ids()
    bootstrap_user.bootstrap()
    row = _row(primary["email"])
    assert _user_ids() - before == {row[0]}
    assert row[1] == "admin"
    assert _row(primary["demo_email"]) is None


def test_password_from_env_signs_in(primary):
    bootstrap_user.bootstrap()
    user = auth_repo.get_user_by_login(primary["email"])
    assert verify_password("long-enough-pw", user["password_hash"])


def test_refuses_alongside_demo_only(primary, monkeypatch):
    monkeypatch.setenv("BOOTSTRAP_DEMO_ONLY", "1")
    before = _user_ids()
    with pytest.raises(SystemExit):
        bootstrap_user.bootstrap()
    assert _user_ids() == before


def test_refuses_a_short_password(primary, monkeypatch):
    monkeypatch.setenv("BOOTSTRAP_PASSWORD", "seven77")
    before = _user_ids()
    with pytest.raises(SystemExit) as exc:
        bootstrap_user.bootstrap()
    assert "8 characters" in str(exc.value)
    assert _user_ids() == before


def test_short_password_still_allowed_without_the_flag(primary, monkeypatch):
    monkeypatch.delenv("BOOTSTRAP_PRIMARY_ONLY")
    monkeypatch.setenv("BOOTSTRAP_PASSWORD", "short")
    bootstrap_user.bootstrap()  # existing dev behaviour has no length rule
    assert _row(primary["email"]) is not None


def _make_user(password: str | None, role: str | None = None) -> dict:
    user = user_repo.create_user(
        f"old-stack-{uuid.uuid4().hex[:8]}@test.local", name="old"
    )
    if password is not None:
        auth_repo.set_password(user["id"], hash_password(password))
    if role:
        auth_repo.set_role(user["id"], role)
    return user


def _hash_of(user_id: int):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT password_hash FROM users WHERE id = %s", (user_id,))
        return cur.fetchone()[0]


def _drop(*users: dict) -> None:
    _delete_users(*[u["email"] for u in users])


@pytest.mark.parametrize("default_pw", ["local-dev-only-not-a-secret", "demo"])
def test_clears_a_leftover_login_with_a_published_default(
    primary, capsys, default_pw
):
    old = _make_user(default_pw, role="admin" if default_pw != "demo" else "demo")
    try:
        bootstrap_user.bootstrap()
        out = capsys.readouterr().out
        assert _hash_of(old["id"]) is None
        assert old["email"] in out
        assert "BOOTSTRAP_EMAIL" in out  # how to keep that account's data
    finally:
        _drop(old)


def test_leaves_other_accounts_with_their_own_password_untouched(primary):
    other = _make_user("some-own-password")
    try:
        bootstrap_user.bootstrap()
        assert verify_password("some-own-password", _hash_of(other["id"]))
    finally:
        _drop(other)


def test_never_clears_the_primary(primary):
    bootstrap_user.bootstrap()
    user = auth_repo.get_user_by_login(primary["email"])
    assert verify_password("long-enough-pw", user["password_hash"])


def test_refuses_a_published_default_as_the_bootstrap_password(
    primary, monkeypatch
):
    monkeypatch.setenv("BOOTSTRAP_PASSWORD", "local-dev-only-not-a-secret")
    before = _user_ids()
    with pytest.raises(SystemExit) as exc:
        bootstrap_user.bootstrap()
    assert "published default" in str(exc.value)
    assert _user_ids() == before


def test_refuses_demo_as_password_naming_it_a_published_default(
    primary, monkeypatch
):
    monkeypatch.setenv("BOOTSTRAP_PASSWORD", "demo")
    with pytest.raises(SystemExit) as exc:
        bootstrap_user.bootstrap()
    assert "published default" in str(exc.value)


def test_warns_about_a_demo_user_that_still_has_its_own_password(primary, capsys):
    leftover = _make_user("custom-demo-pw", role="demo")
    try:
        bootstrap_user.bootstrap()
        out = capsys.readouterr().out
        assert "[primary] WARNING" in out
        assert leftover["email"] in out
        assert verify_password("custom-demo-pw", _hash_of(leftover["id"]))
    finally:
        _drop(leftover)


def test_no_demo_warning_once_the_demo_login_was_cleared(primary, capsys):
    leftover = _make_user("demo", role="demo")
    try:
        bootstrap_user.bootstrap()
        out = capsys.readouterr().out
        assert "WARNING" not in out
        assert "still work" not in out
    finally:
        _drop(leftover)


def test_rerun_resyncs_password_and_changed_email_makes_a_new_account(
    primary, monkeypatch
):
    bootstrap_user.bootstrap()
    first = _row(primary["email"])

    monkeypatch.setenv("BOOTSTRAP_PASSWORD", "another-long-pw")
    bootstrap_user.bootstrap()
    assert _row(primary["email"]) == first  # same row, no duplicate
    user = auth_repo.get_user_by_login(primary["email"])
    assert verify_password("another-long-pw", user["password_hash"])

    new_email = f"renamed-{uuid.uuid4().hex[:8]}@test.local"
    monkeypatch.setenv("BOOTSTRAP_EMAIL", new_email)
    try:
        bootstrap_user.bootstrap()
        assert _row(new_email)[0] != first[0]
        assert _row(primary["email"]) == first  # old account untouched
    finally:
        _delete_users(new_email)
