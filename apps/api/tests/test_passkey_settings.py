"""Passkey settings (owner-passkeys, Task 1)."""
import pytest

from backend.config.settings import Settings

SECRET = "t" * 40
TAILNET = {
    "tailnet_only_deployment": True,
    "tailnet_assert_secret": SECRET,
    "tailnet_login_map": "me@tailnet=admin@test.local",
}


def _settings(**kw):
    base = {"_env_file": None, "environment": "development"}
    return Settings(**{**base, **kw})


def test_defaults_are_off():
    s = _settings()
    assert s.webauthn_rp_id == ""
    assert s.webauthn_origin == ""
    assert s.webauthn_rp_name == "Compendium"
    assert s.webauthn_expected_origin == ""


def test_origin_defaults_to_https_of_the_rp_id():
    s = _settings(webauthn_rp_id="owner.example.com", **TAILNET)
    assert s.webauthn_expected_origin == "https://owner.example.com"


@pytest.mark.parametrize("missing", ["tailnet_assert_secret", "tailnet_login_map"])
def test_rp_id_requires_the_tailnet_login(missing):
    with pytest.raises(ValueError, match="WEBAUTHN_RP_ID requires"):
        _settings(webauthn_rp_id="owner.example.com", **{**TAILNET, missing: ""})


def test_rp_id_requires_a_tailnet_only_deployment():
    with pytest.raises(ValueError, match="WEBAUTHN_RP_ID requires"):
        _settings(webauthn_rp_id="owner.example.com", tailnet_login_map="me@tailnet=admin@test.local")


def test_localhost_origin_is_allowed_for_a_localhost_rp_in_development():
    s = _settings(webauthn_rp_id="localhost", webauthn_origin="http://localhost:3012", **TAILNET)
    assert s.webauthn_expected_origin == "http://localhost:3012"


@pytest.mark.parametrize(
    "rp_id,origin",
    [
        ("owner.example.com", "https://evil.example.com"),
        ("owner.example.com", "http://localhost:3012"),
        ("localhost", "http://localhost"),
        ("localhost", "https://localhost:3012"),
    ],
)
def test_other_origins_are_refused(rp_id, origin):
    with pytest.raises(ValueError, match="WEBAUTHN_ORIGIN"):
        _settings(webauthn_rp_id=rp_id, webauthn_origin=origin, **TAILNET)


def test_origin_without_rp_id_is_refused():
    with pytest.raises(ValueError, match="WEBAUTHN_ORIGIN"):
        _settings(webauthn_origin="https://owner.example.com")
