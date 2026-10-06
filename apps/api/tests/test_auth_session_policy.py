"""Endpoint + unit tests for session-expiry-tuning Task 1 / 1b
(the 2026-09-09 session-expiry-tuning plan (private), spec.md, decisions D1 and D5,
amended 2026-09-10: ``remembered`` is derived from the tailnet-ingress
header Caddy sets, not a client-supplied ``remember`` opt-in).

Purely mock-based -- no PG data setup required, mirroring the `mocked_client`
harness in tests/test_api_topic_rename.py / tests/test_topic_exclusions_api.py:
repo calls are monkeypatched at their source module (`backend.db.auth_repo`,
`backend.db.user_repo`) since the endpoints under test do lazy
`from backend.db import auth_repo as ar` / `from backend.db import user_repo`
imports inside the function body, so patching the source module's attribute
(rather than an attribute on the main/service module) takes effect
regardless of import timing. (The session-scoped ``_use_test_database``
fixture in conftest.py still requires a reachable Postgres test DB to start
the session at all -- that's ambient test-suite plumbing, not something
these tests read from.)

``view-as`` exercises a real JWT via ``auth_service.create_access_token`` --
decoding a Bearer token never touches the DB (``verify_api_key`` /
``get_current_claims`` read only the JWT claims), so no dependency override
or repo monkeypatching is needed to authenticate that request; only the
handler's own repo calls (``get_role``, ``get_user_by_login``) are stubbed.
"""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from backend.api.main import app
from backend.config.settings import Settings, settings
from backend.services import auth_service


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _pin_session_trust_missing_ingress(monkeypatch):
    """Pin the dev-only ``session_trust_missing_ingress`` knob to False for
    every test in this file.

    This repo's gitignored local ``apps/api/.env`` sets
    ``SESSION_TRUST_MISSING_INGRESS=1`` for solo local dev, which the
    module-level ``settings`` singleton picks up at import time. Without
    this pin, the absent-header endpoint tests below (which assert the
    production-shaped "untrusted by default" behaviour) would fail on any
    machine with that knob on. The two dev-knob unit tests
    (``TestIngressTrusted.test_absent_header_trusted_with_dev_knob`` and
    ``test_present_but_wrong_value_stays_untrusted_even_with_dev_knob``)
    override this back to True explicitly, after this fixture runs, to
    exercise the knob itself.
    """
    monkeypatch.setattr(settings, "session_trust_missing_ingress", False)


def _capture_save_refresh_token(monkeypatch):
    """Stub auth_repo.save_refresh_token, recording every call's kwargs so
    tests can assert on the persisted ``remembered`` flag and lifetime
    without a real DB round trip."""
    calls = []

    def _fake_save(user_id, token_hash, expires_at, remembered=False):
        calls.append(
            {
                "user_id": user_id,
                "expires_at": expires_at,
                "remembered": remembered,
            }
        )
        return len(calls)

    monkeypatch.setattr("backend.db.auth_repo.save_refresh_token", _fake_save)
    return calls


def _stub_login_user(monkeypatch, *, user_id, email, role):
    """Stand in for the DB lookups login() makes, plus a password check
    that always succeeds (bcrypt cost is irrelevant to what's under test
    here -- session_policy/remembered wiring, not password hashing)."""
    user = {
        "id": user_id,
        "email": email,
        "name": "Test User",
        "password_hash": "irrelevant-hash",
    }
    monkeypatch.setattr(
        "backend.db.auth_repo.get_user_by_login", lambda identifier: user
    )
    monkeypatch.setattr("backend.db.auth_repo.get_role", lambda uid: role)
    monkeypatch.setattr(
        "backend.services.auth_service.verify_password", lambda pw, hashed: True
    )
    return user


def _stub_rotation(monkeypatch, *, remembered, role, user_id=10, email="rot@test.local"):
    """Stand in for the DB lookups rotate_refresh_token() makes for an
    already-valid, unexpired, unrevoked stored token."""
    stored = {
        "id": 1,
        "user_id": user_id,
        "token_hash": "irrelevant",
        "expires_at": datetime.now(UTC) + timedelta(days=1),
        "created_at": datetime.now(UTC),
        "revoked_at": None,
        "remembered": remembered,
    }
    monkeypatch.setattr(
        "backend.db.auth_repo.get_refresh_token", lambda token_hash: stored
    )
    monkeypatch.setattr(
        "backend.db.auth_repo.revoke_refresh_token", lambda token_hash: None
    )
    monkeypatch.setattr("backend.db.auth_repo.get_role", lambda uid: role)
    monkeypatch.setattr(
        "backend.db.user_repo.get_user_by_id",
        lambda uid: {"id": user_id, "email": email, "name": "Rot User"},
    )
    return stored


class TestSessionPolicyTable:
    """Unit coverage of the four policy rows from spec D1's table."""

    def test_default_user_or_admin(self, monkeypatch):
        monkeypatch.setattr(settings, "session_idle_minutes", 60)
        expected = {"idle_minutes": 60, "resume": True, "remembered": False}
        assert auth_service.session_policy("user", False) == expected
        assert auth_service.session_policy("admin", False) == expected

    def test_demo(self, monkeypatch):
        monkeypatch.setattr(settings, "session_idle_minutes_demo", 720)
        assert auth_service.session_policy("demo", False) == {
            "idle_minutes": 720,
            "resume": True,
            "remembered": False,
        }

    def test_demo_remembered_forced_false(self, monkeypatch):
        """remembered=True is ignored outright when role == 'demo'."""
        monkeypatch.setattr(settings, "session_idle_minutes_demo", 720)
        assert auth_service.session_policy("demo", True) == {
            "idle_minutes": 720,
            "resume": True,
            "remembered": False,
        }

    def test_remembered_non_demo(self, monkeypatch):
        monkeypatch.setattr(settings, "session_idle_minutes_remembered", 0)
        expected = {"idle_minutes": 0, "resume": True, "remembered": True}
        assert auth_service.session_policy("user", True) == expected
        assert auth_service.session_policy("admin", True) == expected

    def test_acting_overrides_role_and_remembered(self, monkeypatch):
        """acting=True (view-as-demo) wins over both role and remembered --
        the no-refresh cap and forced non-remembered/non-resume policy hold
        even if a caller passed remembered=True by mistake."""
        monkeypatch.setattr(settings, "session_idle_minutes", 60)
        expected = {"idle_minutes": 60, "resume": False, "remembered": False}
        assert auth_service.session_policy("demo", True, acting=True) == expected
        assert auth_service.session_policy("admin", True, acting=True) == expected


class TestLoginSessionPolicy:
    """Amended 2026-09-10: ``remembered`` is derived from the inbound
    ``X-Compendium-Ingress`` header (Caddy-set, unspoofable from the public
    origin -- spec D1/D6), never a client-supplied ``remember`` field."""

    def test_user_login_with_trusted_ingress_header(self, client, monkeypatch):
        _stub_login_user(monkeypatch, user_id=6, email="user@test.local", role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)

        before = datetime.now(UTC)
        r = client.post(
            "/api/auth/login",
            json={"email": "user@test.local", "password": "x"},
            headers={"X-Compendium-Ingress": "tailnet"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["session_policy"] == {
            "idle_minutes": settings.session_idle_minutes_remembered,
            "resume": True,
            "remembered": True,
        }
        assert len(save_calls) == 1
        assert save_calls[0]["remembered"] is True
        delta_days = (save_calls[0]["expires_at"] - before).total_seconds() / 86400
        assert 89.9 < delta_days < 90.1

    def test_user_login_without_ingress_header_gets_default_policy(
        self, client, monkeypatch
    ):
        _stub_login_user(monkeypatch, user_id=7, email="plain@test.local", role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)

        before = datetime.now(UTC)
        r = client.post(
            "/api/auth/login",
            json={"email": "plain@test.local", "password": "x"},
        )
        assert r.status_code == 200
        assert r.json()["session_policy"] == {
            "idle_minutes": settings.session_idle_minutes,
            "resume": True,
            "remembered": False,
        }
        assert save_calls[0]["remembered"] is False
        delta_days = (save_calls[0]["expires_at"] - before).total_seconds() / 86400
        assert 6.9 < delta_days < 7.1

    @pytest.mark.parametrize("bad_value", ["public", "TAILNET "])
    def test_user_login_with_forged_or_other_ingress_value_gets_default_policy(
        self, client, monkeypatch, bad_value
    ):
        """Anything other than an EXACT match against the trusted value --
        including the legitimate-but-untrusted "public" the other Caddy
        listener sets, and near-miss casing/whitespace -- is untrusted."""
        _stub_login_user(monkeypatch, user_id=8, email="other@test.local", role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)

        r = client.post(
            "/api/auth/login",
            json={"email": "other@test.local", "password": "x"},
            headers={"X-Compendium-Ingress": bad_value},
        )
        assert r.status_code == 200
        assert r.json()["session_policy"] == {
            "idle_minutes": settings.session_idle_minutes,
            "resume": True,
            "remembered": False,
        }
        assert save_calls[0]["remembered"] is False

    def test_demo_login_with_trusted_ingress_header_stays_not_remembered(
        self, client, monkeypatch
    ):
        """The demo role can never be remembered, even over the trusted
        tailnet ingress (spec D1 hard constraint, server-side DB role)."""
        _stub_login_user(monkeypatch, user_id=5, email="demo@test.local", role="demo")
        save_calls = _capture_save_refresh_token(monkeypatch)

        before = datetime.now(UTC)
        r = client.post(
            "/api/auth/login",
            json={"email": "demo@test.local", "password": "x"},
            headers={"X-Compendium-Ingress": "tailnet"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["session_policy"] == {
            "idle_minutes": settings.session_idle_minutes_demo,
            "resume": True,
            "remembered": False,
        }
        assert len(save_calls) == 1
        assert save_calls[0]["remembered"] is False
        delta_days = (save_calls[0]["expires_at"] - before).total_seconds() / 86400
        assert 6.9 < delta_days < 7.1


class TestRotateRefreshTokenSessionPolicy:
    """Unit-level: ``auth_service.rotate_refresh_token`` recomputes
    ``remembered`` from the CURRENT ingress verdict passed in -- the
    STORED token's own ``remembered`` flag (spec D1, amended 2026-09-10)
    no longer carries forward on its own."""

    def test_remembered_stored_token_rotated_over_public_drops_to_default(
        self, monkeypatch
    ):
        """A previously-remembered token, rotated with ingress_trusted=False
        (device left the tailnet), drops to the default 7-day/60-min
        policy -- the stored remembered=True flag is ignored."""
        _stub_rotation(monkeypatch, remembered=True, role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)

        before = datetime.now(UTC)
        result = auth_service.rotate_refresh_token("raw-token-value", False)
        assert result is not None
        _access, _refresh, policy = result
        assert policy == {
            "idle_minutes": settings.session_idle_minutes,
            "resume": True,
            "remembered": False,
        }
        assert len(save_calls) == 1
        assert save_calls[0]["remembered"] is False
        delta_days = (save_calls[0]["expires_at"] - before).total_seconds() / 86400
        assert 6.9 < delta_days < 7.1

    def test_default_stored_token_rotated_over_tailnet_upgrades_to_remembered(
        self, monkeypatch
    ):
        """A default (never-remembered) token, rotated with
        ingress_trusted=True for a user/admin role (device joined the
        tailnet), upgrades to the 90-day remembered policy."""
        _stub_rotation(monkeypatch, remembered=False, role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)

        before = datetime.now(UTC)
        result = auth_service.rotate_refresh_token("raw-token-value", True)
        assert result is not None
        _access, _refresh, policy = result
        assert policy == {
            "idle_minutes": settings.session_idle_minutes_remembered,
            "resume": True,
            "remembered": True,
        }
        assert len(save_calls) == 1
        assert save_calls[0]["remembered"] is True
        delta_days = (save_calls[0]["expires_at"] - before).total_seconds() / 86400
        assert 89.9 < delta_days < 90.1

    def test_demo_role_never_gets_remembered_token_on_rotation(self, monkeypatch):
        """Regression (review item 1, still holds post-amendment): the demo
        role can never hold a 90-day token (spec D1 hard constraint), even
        when rotated with ingress_trusted=True. Role must be read before
        minting."""
        _stub_rotation(monkeypatch, remembered=False, role="demo")
        save_calls = _capture_save_refresh_token(monkeypatch)

        before = datetime.now(UTC)
        result = auth_service.rotate_refresh_token("raw-token-value", True)
        assert result is not None
        _access, _refresh, policy = result
        assert policy == {
            "idle_minutes": settings.session_idle_minutes_demo,
            "resume": True,
            "remembered": False,
        }
        assert len(save_calls) == 1
        assert save_calls[0]["remembered"] is False
        delta_days = (save_calls[0]["expires_at"] - before).total_seconds() / 86400
        assert 6.9 < delta_days < 7.1


class TestRefreshEndpointIngressHeader:
    """Endpoint-level: ``/api/auth/refresh`` reads the ingress verdict from
    the actual inbound request headers (not a body field) and passes it
    through to ``rotate_refresh_token``."""

    def test_refresh_endpoint_with_trusted_header_upgrades_policy(self, monkeypatch):
        _stub_rotation(monkeypatch, remembered=False, role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)
        client = TestClient(app)

        r = client.post(
            "/api/auth/refresh",
            json={"refresh_token": "raw-token-value"},
            headers={"X-Compendium-Ingress": "tailnet"},
        )
        assert r.status_code == 200
        assert r.json()["session_policy"] == {
            "idle_minutes": settings.session_idle_minutes_remembered,
            "resume": True,
            "remembered": True,
        }
        assert save_calls[0]["remembered"] is True

    def test_refresh_endpoint_without_header_stays_default_policy(self, monkeypatch):
        _stub_rotation(monkeypatch, remembered=True, role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)
        client = TestClient(app)

        r = client.post("/api/auth/refresh", json={"refresh_token": "raw-token-value"})
        assert r.status_code == 200
        assert r.json()["session_policy"] == {
            "idle_minutes": settings.session_idle_minutes,
            "resume": True,
            "remembered": False,
        }
        assert save_calls[0]["remembered"] is False


class TestIngressTrusted:
    """Unit coverage of ``auth_service.ingress_trusted``."""

    def test_trusted_header_value(self, monkeypatch):
        assert (
            auth_service.ingress_trusted({"X-Compendium-Ingress": "tailnet"}) is True
        )

    def test_wrong_value_is_untrusted(self, monkeypatch):
        assert (
            auth_service.ingress_trusted({"X-Compendium-Ingress": "public"}) is False
        )

    def test_absent_header_defaults_untrusted(self, monkeypatch):
        monkeypatch.setattr(settings, "session_trust_missing_ingress", False)
        assert auth_service.ingress_trusted({}) is False

    def test_absent_header_trusted_with_dev_knob(self, monkeypatch):
        monkeypatch.setattr(settings, "session_trust_missing_ingress", True)
        assert auth_service.ingress_trusted({}) is True

    def test_present_but_wrong_value_stays_untrusted_even_with_dev_knob(
        self, monkeypatch
    ):
        """The dev knob only covers an ABSENT header -- a present-but-wrong
        value is still untrusted regardless."""
        monkeypatch.setattr(settings, "session_trust_missing_ingress", True)
        assert (
            auth_service.ingress_trusted({"X-Compendium-Ingress": "public"}) is False
        )

    def test_case_insensitive_mapping_like_request_headers(self, monkeypatch):
        """``request.headers`` (Starlette) is case-insensitive; a real
        header lookup for the configured header name must not depend on
        exact casing of the sender's header. Uses Starlette's own
        ``Headers`` type directly (what ``request.headers`` actually is)
        rather than a plain dict, so this exercises the real ``.get()``
        contract without spinning up a request."""
        from starlette.datastructures import Headers

        headers = Headers({"x-compendium-ingress": "tailnet"})
        assert auth_service.ingress_trusted(headers) is True


class TestViewAsSessionPolicy:
    def test_view_as_response_has_resume_false(self, client, monkeypatch):
        admin = {"id": 1, "email": "admin@test.local", "name": "Admin"}
        demo = {"id": 2, "email": "demo@traversal.local", "name": "Demo User"}

        monkeypatch.setattr(
            "backend.db.auth_repo.get_role",
            lambda uid: "admin" if uid == admin["id"] else "demo",
        )
        monkeypatch.setattr(
            "backend.db.auth_repo.get_user_by_login",
            lambda identifier: demo if identifier == "demo" else None,
        )

        admin_token = auth_service.create_access_token(admin["id"], admin["email"])
        r = client.post(
            "/api/auth/view-as", json={"profile": "demo"}, headers=_bearer(admin_token)
        )
        assert r.status_code == 200
        body = r.json()
        assert body["session_policy"] == {
            "idle_minutes": settings.session_idle_minutes,
            "resume": False,
            "remembered": False,
        }


class TestReturnToAdminSessionPolicy:
    """Review item 3: return-to-admin's session_policy must equal the
    default (user/admin) row -- remembered False, resume True -- since
    admin re-entry after a view-as never carries a `remembered` flag
    forward (no refresh token round-trips through this endpoint)."""

    def test_return_to_admin_session_policy_is_default_row(self, client, monkeypatch):
        admin_id, admin_email = 1, "admin@test.local"
        demo_id, demo_email = 2, "demo@test.local"

        # Stubs mirror tests/test_api_view_as.py's TestReturnToAdmin /
        # TestViewAsDemo pattern: drive the endpoint via a directly
        # constructed acting_as_demo token (no real view-as round trip
        # needed since only return-to-admin's own repo calls matter here).
        monkeypatch.setattr(
            "backend.db.auth_repo.get_role",
            lambda uid: "admin" if uid == admin_id else "demo",
        )
        monkeypatch.setattr(
            "backend.db.user_repo.get_user_by_id",
            lambda uid: (
                {"id": admin_id, "email": admin_email, "name": "Admin User"}
                if uid == admin_id
                else None
            ),
        )

        acting_token = auth_service.create_access_token(
            demo_id,
            demo_email,
            extra_claims={
                "acting_as_demo": True,
                "admin_origin_user_id": admin_id,
                "admin_origin_email": admin_email,
            },
        )

        r = client.post("/api/auth/return-to-admin", headers=_bearer(acting_token))
        assert r.status_code == 200
        assert r.json()["session_policy"] == {
            "idle_minutes": settings.session_idle_minutes,
            "resume": True,
            "remembered": False,
        }


class TestValidatorRefusesTrustMissingIngressOutsideDevelopment:
    """The dev knob is refused whenever ``environment != "development"`` --
    not only ``== "production"`` -- consistent with the neighbouring JWT
    secret / CORS validators just above it, so a staging environment (or a
    misspelled ``ENVIRONMENT`` value) can't silently enable it either.

    Mirrors how the pre-existing CORS "*" hard-fail is exercised: a direct
    ``Settings(...)`` construction (no monkeypatching of the module-level
    ``settings`` singleton, which is already built at import time -- the
    validator runs at construction, so a fresh instance is required).
    ``jwt_secret_key`` / ``cors_origins`` are passed explicitly so this
    test is hermetic against whatever real values a local ``.env``/
    ``~/.secrets`` happens to hold."""

    def test_session_trust_missing_ingress_refused_in_production(self):
        with pytest.raises(ValueError, match="SESSION_TRUST_MISSING_INGRESS"):
            Settings(
                environment="production",
                jwt_secret_key="a-real-production-secret",
                cors_origins="https://compendium.example.com",
                session_trust_missing_ingress=True,
            )

    def test_session_trust_missing_ingress_refused_in_non_development_environment(
        self,
    ):
        """A non-"production" but also non-"development" environment string
        (e.g. staging, or a typo) must still be refused -- the knob is
        allow-listed to "development" only, not deny-listed to
        "production" only."""
        with pytest.raises(ValueError, match="SESSION_TRUST_MISSING_INGRESS"):
            Settings(
                environment="staging",
                jwt_secret_key="a-real-production-secret",
                cors_origins="https://compendium.example.com",
                session_trust_missing_ingress=True,
            )

    def test_session_trust_missing_ingress_allowed_in_development(self):
        s = Settings(
            environment="development",
            jwt_secret_key="a-real-production-secret",
            cors_origins="https://compendium.example.com",
            session_trust_missing_ingress=True,
        )
        assert s.session_trust_missing_ingress is True


class TestValidatorRefusesDefaultIngressTrustedValueOutsideDevelopment:
    """batch-06 (deploy-flip fix wave), final review: with apps/web's Next
    auth routes no longer relaying a client-supplied ingress header (see
    apps/web/lib/ingress.ts), the header the API sees is either absent or
    set by a genuinely trusted edge. But if the deploy still shipped with
    ``session_ingress_trusted_value`` left at its default, ANY operator
    error that let a caller set the header directly (e.g. a
    misconfigured/absent edge in front of the API itself) would grant the
    remembered/90-day session to that caller, since the default is a
    known, non-secret string documented in .env.example -- not something
    to compare against a hardcoded literal here, so this reads the
    default off the field itself, same as the value must never be
    hardcoded in a commit message or doc.

    Same construction pattern as
    ``TestValidatorRefusesTrustMissingIngressOutsideDevelopment`` above: a
    fresh ``Settings(...)`` (the validator runs at construction), explicit
    ``jwt_secret_key``/``cors_origins`` so the test stays hermetic against
    whatever a local ``.env``/``~/.secrets`` happens to hold. Also pins
    ``session_trust_missing_ingress=False`` explicitly -- this repo's
    gitignored local ``apps/api/.env`` sets it to True for solo local dev
    (see the module docstring/fixture above), which would otherwise trip
    the *sibling* validator first and mask the one under test here.
    """

    def test_default_ingress_trusted_value_refused_in_production(self):
        with pytest.raises(ValueError, match="SESSION_INGRESS_TRUSTED_VALUE"):
            Settings(
                environment="production",
                jwt_secret_key="a-real-production-secret",
                cors_origins="https://compendium.example.com",
                session_trust_missing_ingress=False,
                # session_ingress_trusted_value left at its default on purpose.
            )

    def test_default_ingress_trusted_value_refused_in_non_development_environment(
        self,
    ):
        """Same allow-list-not-deny-list treatment as the sibling ingress
        knob validator: a non-"production", non-"development" environment
        string (staging, or a typo) must still be refused."""
        with pytest.raises(ValueError, match="SESSION_INGRESS_TRUSTED_VALUE"):
            Settings(
                environment="staging",
                jwt_secret_key="a-real-production-secret",
                cors_origins="https://compendium.example.com",
                session_trust_missing_ingress=False,
            )

    def test_non_default_ingress_trusted_value_allowed_in_production(self):
        s = Settings(
            environment="production",
            jwt_secret_key="a-real-production-secret",
            cors_origins="https://compendium.example.com",
            session_trust_missing_ingress=False,
            session_ingress_trusted_value="a-random-operator-chosen-value",
        )
        assert s.session_ingress_trusted_value == "a-random-operator-chosen-value"

    def test_default_ingress_trusted_value_allowed_in_development(self):
        s = Settings(
            environment="development",
            jwt_secret_key="a-real-production-secret",
            cors_origins="https://compendium.example.com",
        )
        assert (
            s.session_ingress_trusted_value
            == Settings.model_fields["session_ingress_trusted_value"].default
        )


class TestDevAuthBypassSwitch:
    """``DEV_AUTH_BYPASS=0`` turns off the development-mode default-user
    bypass so the real login/refresh/expiry paths can be exercised locally
    without leaving ``environment=development`` (which the ingress dev knob
    requires). Outside development the bypass never applied anyway."""

    def test_bypass_off_rejects_unauthenticated_requests_in_development(self, client, monkeypatch):
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "development")
        monkeypatch.setattr(settings, "dev_auth_bypass", False)
        r = client.get("/api/auth/me")
        assert r.status_code == 401

    def test_bypass_on_resolves_default_user_in_development(self, client, monkeypatch):
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "development")
        monkeypatch.setattr(settings, "dev_auth_bypass", True)
        r = client.get("/api/auth/me")
        assert r.status_code != 401

    def test_bypass_stays_inert_in_production_even_with_switch_on(self, client, monkeypatch):
        """mig-06 Task 2, item D: the API is about to get its own public
        hostname, so a request with no token must never resolve to the
        default dev user outside development -- regardless of
        ``dev_auth_bypass``, which exists only to be toggled locally while
        staying in ``environment=development``. ``verify_api_key`` gates
        the bypass on ``settings.is_development and settings.dev_auth_bypass``
        (backend/api/main.py, ~line 221), so flipping the switch on while
        ``environment=production`` must stay a no-op."""
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "production")
        monkeypatch.setattr(settings, "dev_auth_bypass", True)
        r = client.get("/api/auth/me")
        assert r.status_code == 401


class TestTailnetOnlyDeployment:
    """tailnet-owner-demo-split (2026-10-06): a deployment with no public
    ingress at all treats every request as tailnet-trusted."""

    def test_off_by_default(self):
        assert Settings.model_fields["tailnet_only_deployment"].default is False

    def test_absent_header_is_trusted(self, monkeypatch):
        monkeypatch.setattr(settings, "tailnet_only_deployment", True)
        assert auth_service.ingress_trusted({}) is True

    def test_any_header_value_is_trusted(self, monkeypatch):
        monkeypatch.setattr(settings, "tailnet_only_deployment", True)
        assert (
            auth_service.ingress_trusted({"X-Compendium-Ingress": "public"}) is True
        )

    def test_user_login_without_header_is_remembered(self, client, monkeypatch):
        monkeypatch.setattr(settings, "tailnet_only_deployment", True)
        _stub_login_user(monkeypatch, user_id=6, email="user@test.local", role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)
        r = client.post(
            "/api/auth/login", json={"email": "user@test.local", "password": "x"}
        )
        assert r.status_code == 200
        assert r.json()["session_policy"]["remembered"] is True
        assert save_calls[0]["remembered"] is True

    def test_demo_login_stays_not_remembered(self, client, monkeypatch):
        monkeypatch.setattr(settings, "tailnet_only_deployment", True)
        _stub_login_user(monkeypatch, user_id=7, email="demo@test.local", role="demo")
        save_calls = _capture_save_refresh_token(monkeypatch)
        r = client.post(
            "/api/auth/login", json={"email": "demo@test.local", "password": "x"}
        )
        assert r.status_code == 200
        assert r.json()["session_policy"]["remembered"] is False
        assert save_calls[0]["remembered"] is False


class TestValidatorRefusesTailnetOnlyWithCfHeaderTrust:
    """A tailnet-only deployment has no Cloudflare in front of it, so trusting
    CF-Connecting-IP there means the flag landed on a public stack."""

    _prod = dict(
        environment="production",
        jwt_secret_key="a-real-production-secret",
        cors_origins="https://compendium.example.com",
        session_trust_missing_ingress=False,
        session_ingress_trusted_value="a-real-ingress-secret",
    )

    def test_refused_in_production(self):
        with pytest.raises(ValueError, match="TAILNET_ONLY_DEPLOYMENT"):
            Settings(
                **self._prod,
                tailnet_only_deployment=True,
                rate_limit_trust_cf_header=True,
            )

    def test_refused_in_development_too(self):
        with pytest.raises(ValueError, match="TAILNET_ONLY_DEPLOYMENT"):
            Settings(
                environment="development",
                session_trust_missing_ingress=False,
                tailnet_only_deployment=True,
                rate_limit_trust_cf_header=True,
            )

    def test_allowed_alone_in_production(self):
        s = Settings(
            **self._prod,
            tailnet_only_deployment=True,
            rate_limit_trust_cf_header=False,
        )
        assert s.tailnet_only_deployment is True
