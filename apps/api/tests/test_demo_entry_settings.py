"""Settings for one-click public demo entry (demo-one-click-entry, Task 1)."""
import pytest

from backend.config.settings import Settings


def _settings(**kw):
    base = {"_env_file": None, "environment": "development"}
    return Settings(**{**base, **kw})


def test_defaults_are_off():
    s = _settings()
    assert s.demo_public_entry is False
    assert s.turnstile_secret_key == ""
    assert s.turnstile_verify_url == "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def test_entry_requires_the_turnstile_secret(monkeypatch):
    monkeypatch.setenv("BOOTSTRAP_DEMO_ONLY", "1")
    with pytest.raises(ValueError, match="TURNSTILE_SECRET_KEY"):
        _settings(demo_public_entry=True)


def test_entry_requires_the_demo_only_bootstrap(monkeypatch):
    monkeypatch.delenv("BOOTSTRAP_DEMO_ONLY", raising=False)
    with pytest.raises(ValueError, match="BOOTSTRAP_DEMO_ONLY"):
        _settings(demo_public_entry=True, turnstile_secret_key="0x" + "s" * 30)


def test_entry_is_refused_on_a_tailnet_only_deployment(monkeypatch):
    monkeypatch.setenv("BOOTSTRAP_DEMO_ONLY", "1")
    with pytest.raises(ValueError, match="TAILNET_ONLY_DEPLOYMENT"):
        _settings(demo_public_entry=True, turnstile_secret_key="0x" + "s" * 30, tailnet_only_deployment=True)


def test_entry_accepts_a_complete_demo_configuration(monkeypatch):
    monkeypatch.setenv("BOOTSTRAP_DEMO_ONLY", "1")
    s = _settings(demo_public_entry=True, turnstile_secret_key="0x" + "s" * 30)
    assert s.demo_public_entry is True


def test_validation_errors_do_not_echo_the_secret(monkeypatch):
    monkeypatch.delenv("BOOTSTRAP_DEMO_ONLY", raising=False)
    secret = "fixture-" * 5
    with pytest.raises(ValueError) as excinfo:
        _settings(demo_public_entry=True, turnstile_secret_key=secret)
    text = str(excinfo.value)
    assert not any(secret[i : i + 8] in text for i in range(len(secret) - 7))
