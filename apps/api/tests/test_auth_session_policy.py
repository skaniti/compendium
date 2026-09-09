"""Endpoint + unit tests for session-expiry-tuning Task 1 (docs/project-plans/
2026-09-09-125949-session-expiry-tuning/spec.md, decisions D1 and D5).

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
from backend.config.settings import settings
from backend.services import auth_service


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def client():
    return TestClient(app)


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
    def test_demo_login_with_remember_true_ignored(self, client, monkeypatch):
        _stub_login_user(monkeypatch, user_id=5, email="demo@test.local", role="demo")
        save_calls = _capture_save_refresh_token(monkeypatch)

        before = datetime.now(UTC)
        r = client.post(
            "/api/auth/login",
            json={"email": "demo@test.local", "password": "x", "remember": True},
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

    def test_user_login_with_remember_true(self, client, monkeypatch):
        _stub_login_user(monkeypatch, user_id=6, email="user@test.local", role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)

        before = datetime.now(UTC)
        r = client.post(
            "/api/auth/login",
            json={"email": "user@test.local", "password": "x", "remember": True},
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

    def test_login_without_remember_gets_default_policy(self, client, monkeypatch):
        _stub_login_user(monkeypatch, user_id=7, email="plain@test.local", role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)

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


class TestRotateRefreshTokenSessionPolicy:
    def test_remembered_token_rotation_carries_flag_and_90_day_lifetime(
        self, client, monkeypatch
    ):
        _stub_rotation(monkeypatch, remembered=True, role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)

        before = datetime.now(UTC)
        r = client.post("/api/auth/refresh", json={"refresh_token": "raw-token-value"})
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

    def test_normal_token_rotation_stays_7_days_not_remembered(self, client, monkeypatch):
        _stub_rotation(monkeypatch, remembered=False, role="user")
        save_calls = _capture_save_refresh_token(monkeypatch)

        before = datetime.now(UTC)
        r = client.post("/api/auth/refresh", json={"refresh_token": "raw-token-value"})
        assert r.status_code == 200
        body = r.json()
        assert body["session_policy"] == {
            "idle_minutes": settings.session_idle_minutes,
            "resume": True,
            "remembered": False,
        }
        assert len(save_calls) == 1
        assert save_calls[0]["remembered"] is False
        delta_days = (save_calls[0]["expires_at"] - before).total_seconds() / 86400
        assert 6.9 < delta_days < 7.1

    def test_demo_role_never_gets_remembered_token_on_rotation(
        self, client, monkeypatch
    ):
        """Regression (review item 1): the demo role can never hold a
        90-day token (spec D1 hard constraint), even when the STORED token
        carries remembered=True -- e.g. it was minted while the user held a
        different role, or the role was demoted afterward. Role must be
        read before minting; minting with the stale flag and only
        correcting the reported policy afterward was the pre-fix bug."""
        _stub_rotation(monkeypatch, remembered=True, role="demo")
        save_calls = _capture_save_refresh_token(monkeypatch)

        before = datetime.now(UTC)
        r = client.post("/api/auth/refresh", json={"refresh_token": "raw-token-value"})
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
