"""Tailnet login settings + service (tailnet-passwordless-login, Task 2)."""
import pytest

from backend.config.settings import Settings, parse_tailnet_login_map, settings
from backend.db import auth_repo, user_repo
from backend.db.connection import get_conn
from backend.services import tailnet_login

SECRET = "s" * 32


def test_parse_map_lowercases_and_trims_logins():
    assert parse_tailnet_login_map(" Owner@Example.com = owner@test.local , b@x=bee ") == {
        "owner@example.com": "owner@test.local",
        "b@x": "bee",
    }
    assert parse_tailnet_login_map("") == {}


@pytest.mark.parametrize("raw", ["nologin", "=acct", "login=", "a=b,a=c"])
def test_parse_map_rejects_malformed_entries(raw):
    with pytest.raises(ValueError):
        parse_tailnet_login_map(raw)


def _settings(**kw):
    base = {"_env_file": None, "environment": "development"}
    return Settings(**{**base, **kw})


def test_validator_rejects_a_short_secret():
    with pytest.raises(ValueError, match="at least 32"):
        _settings(tailnet_only_deployment=True, tailnet_assert_secret="short")


def test_validator_requires_tailnet_only_for_the_secret():
    with pytest.raises(ValueError, match="TAILNET_ONLY_DEPLOYMENT"):
        _settings(tailnet_assert_secret=SECRET)


def test_validator_rejects_a_malformed_map():
    with pytest.raises(ValueError, match="TAILNET_LOGIN_MAP"):
        _settings(tailnet_login_map="nologin")


def test_validator_accepts_a_full_config():
    s = _settings(
        tailnet_only_deployment=True,
        tailnet_assert_secret=SECRET,
        tailnet_login_map="owner@example.com=owner@test.local",
    )
    assert s.tailnet_assert_secret == SECRET


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(settings, "tailnet_only_deployment", True)
    monkeypatch.setattr(settings, "tailnet_assert_secret", SECRET)
    monkeypatch.setattr(
        settings, "tailnet_login_map", "owner@example.com=owner@test.local,demo@example.com=demo"
    )
    return settings


@pytest.mark.parametrize(
    "field,value",
    [("tailnet_only_deployment", False), ("tailnet_assert_secret", ""), ("tailnet_login_map", "")],
)
def test_enabled_needs_all_three(configured, monkeypatch, field, value):
    assert tailnet_login.enabled() is True
    monkeypatch.setattr(settings, field, value)
    assert tailnet_login.enabled() is False


def test_assert_ok(configured):
    assert tailnet_login.assert_ok(SECRET) is True
    assert tailnet_login.assert_ok(SECRET + "x") is False
    assert tailnet_login.assert_ok("") is False
    assert tailnet_login.assert_ok(None) is False
    assert tailnet_login.assert_ok("ünïcode") is False


def test_browser_token_hash_is_sha256_hex():
    raw, token_hash = tailnet_login.new_browser_token()
    assert len(raw) >= 40
    assert token_hash == tailnet_login.hash_browser_token(raw)
    assert len(token_hash) == 64 and raw not in token_hash


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        connect(settings.test_database_url).close()
        return True
    except Exception:
        return False


@pytest.fixture
def accounts():
    if not _pg_reachable():
        pytest.skip("Test PostgreSQL not reachable")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
    owner = user_repo.create_user("owner@test.local", name="Owner")
    auth_repo.set_role(owner["id"], "admin")
    demo = user_repo.create_user("demo@test.local", name="Demo")
    auth_repo.set_role(demo["id"], "demo")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE users SET username='demo' WHERE id=%s", (demo["id"],))
    return owner, demo


def test_resolve_account_matches_case_and_whitespace_insensitively(configured, accounts):
    owner, _ = accounts
    assert tailnet_login.resolve_account(" Owner@Example.COM ")["id"] == owner["id"]


def test_resolve_account_refuses_unmapped_missing_and_demo(configured, accounts, monkeypatch):
    assert tailnet_login.resolve_account("stranger@example.com") is None
    assert tailnet_login.resolve_account("demo@example.com") is None
    monkeypatch.setattr(settings, "tailnet_login_map", "owner@example.com=nobody@test.local")
    assert tailnet_login.resolve_account("owner@example.com") is None


def test_validation_errors_do_not_echo_the_secret():
    secret = "Zq7vK3mX9pL2wR8tY5nB1cH6dF4gJ0aS7uE3iO"
    with pytest.raises(ValueError) as excinfo:
        _settings(tailnet_assert_secret=secret)
    text = str(excinfo.value)
    assert not any(secret[i : i + 8] in text for i in range(len(secret) - 7))
