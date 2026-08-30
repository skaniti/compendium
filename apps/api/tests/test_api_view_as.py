"""Endpoint contract tests for the JWT view-as-demo / return-to-admin switch.

Migration batch 04 (auth/session parity), task 1. The originating plan text
(``users.view_as_user_id`` + "effective_id" plumbing) was corrected by a
drift audit before implementation: migration 030 (030_drop_view_as_user_id.sql)
dropped that column and its code paths outright. There is no DB-side
aliasing left to port. What's implemented instead is new auth logic living
entirely in extra JWT claims -- see backend/services/auth_service.py's
``create_access_token(extra_claims=...)`` and backend/api/main.py's
``get_current_claims`` dependency.

── Step 1 findings: existing token/plumbing shape (read before writing code) ──

``auth_service.create_access_token`` (pre-existing, backend/services/
auth_service.py:29-53) minted claims ``{sub: str(user_id), email, iat, exp,
type: "access"}`` via HS256, with no acting/effective-identity claim of any
kind and no ``extra_claims`` parameter -- this task adds that parameter.

``verify_api_key`` (backend/api/main.py:189-225, left untouched by this
task) decodes ``Authorization: Bearer`` in production, bypasses auth
entirely in dev mode, and never exposed the decoded claims dict to callers
-- only the resolved ``user_id`` (``claims["sub"]``). Nothing in the
pre-existing code read any other claim. This task adds a sibling
dependency, ``get_current_claims``, that decodes the same Bearer token but
returns the full claims dict (or ``{}`` for dev-bypass/API-key auth)
instead of raising, so view-as/return-to-admin/``/me``/the preferences
gate can read ``acting_as_demo`` without changing ``verify_api_key``'s
contract.

``users.view_as_user_id`` (migration 027_user_aliasing.sql) no longer
exists -- confirmed dropped by migration 030_drop_view_as_user_id.sql,
whose own comment says the code paths that read it were removed alongside
it. ``backend/db/auth_repo.py`` has no ``effective_id`` concept anywhere.

The Dash reference mechanism being ported, ``/__view_as_demo`` /
``/__return_to_admin`` (frontend/dash/app.py:1566-1659), does the
equivalent switch via Flask session markers (``admin_origin_user_id``,
``admin_origin_email``) instead of JWT claims -- the session cookie is
that implementation's authority, and it re-mints a JWT matching whichever
identity is currently active but the JWT itself never carries acting-state
there. Guard order mirrored here: admin role re-checked from the DB (never
trusted from the client) -> no-nest check -> demo role verification for
view-as; return-to-admin acts only on the server-signed
acting_as_demo/admin_origin_user_id claims, re-checking the origin
admin's role from the DB rather than trusting the token's stale claim.
"""

import pytest
from fastapi.testclient import TestClient


def _pg_reachable() -> bool:
    try:
        from backend.config.settings import settings
        from psycopg2 import connect

        conn = connect(settings.test_database_url)
        conn.close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _pg_reachable(),
    reason="Test PostgreSQL not reachable",
)


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _seed_page(user_id: int, capture_id: str, title: str) -> int:
    """Seed one active page so ``build_graph_from_db`` yields a node whose id
    is the slug of *title*. Used by the view-as data-scoping test."""
    from datetime import datetime, timezone

    from backend.db import capture_repo, page_repo

    now = datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc)
    cap = capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture_id,
        source="desktop_active",
        started_at=now,
        ended_at=now,
    )
    page_id = page_repo.insert_pages(
        cap["id"],
        [
            {
                "url": f"https://example.com/{capture_id}",
                "title": title,
                "domain": "example.com",
                "visited_at": now,
            }
        ],
    )[0]
    page_repo.update_page_status(page_id, "active")
    return page_id


@pytest.fixture
def prod_auth(monkeypatch):
    """Force production-mode auth so verify_api_key / get_current_claims
    exercise the production guard behavior: missing/invalid credentials
    401 instead of degrading to the dev-default identity. (Since the dev
    view-as round-trip fix, a valid Bearer token is honored in dev mode
    too -- see TestDevModeViewAsRoundTrip -- but the no-token and
    bad-token paths still differ per mode, so the guards above stay
    pinned to production.)
    """
    from backend.config.settings import settings

    monkeypatch.setattr(settings, "environment", "production")
    return settings


@pytest.fixture
def dev_auth(monkeypatch):
    """Force development-mode auth explicitly (rather than relying on the
    environment default) so the dev-bypass fallback paths are under test
    regardless of what .env sets."""
    from backend.config.settings import settings

    monkeypatch.setattr(settings, "environment", "development")
    return settings


def _seed_role_users() -> dict:
    """Fresh admin / demo / plain-role users, truncated per call.

    ``demo`` is discoverable exactly the way the view-as handler resolves
    it: ``get_user_by_login("demo")`` (via the username column) OR email
    ``demo@traversal.local`` -- both are set here so either resolution path
    in the implementation would find it.
    """
    from backend.db import auth_repo as ar, user_repo
    from backend.db.connection import get_conn
    from backend.services.auth_service import hash_password

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE users CASCADE")

    admin = user_repo.create_user("admin@test.local", name="Admin User")
    ar.set_password(admin["id"], hash_password("adminpass123"))
    ar.set_role(admin["id"], "admin")

    demo = user_repo.create_user("demo@traversal.local", name="Demo User")
    ar.set_password(demo["id"], hash_password("demopass123"))
    ar.set_role(demo["id"], "demo")

    plain = user_repo.create_user("plain@test.local", name="Plain User")
    ar.set_password(plain["id"], hash_password("plainpass123"))
    # role left at column default 'user'

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET username = %s WHERE id = %s",
                ("adminuser", admin["id"]),
            )
            cur.execute(
                "UPDATE users SET username = %s WHERE id = %s",
                ("demo", demo["id"]),
            )

    return {"admin": admin, "demo": demo, "plain": plain}


@pytest.fixture
def users(prod_auth):
    return _seed_role_users()


@pytest.fixture
def dev_users(dev_auth):
    return _seed_role_users()


@pytest.fixture
def client():
    from backend.api.main import app

    return TestClient(app)


class TestCreateAccessTokenExtraClaims:
    """Unit-level coverage for item 1: extra_claims support in auth_service."""

    def test_extra_claims_are_merged_into_payload(self):
        from backend.services.auth_service import create_access_token, decode_access_token

        token = create_access_token(
            42, "user@example.com", extra_claims={"acting_as_demo": True, "admin_origin_user_id": 7}
        )
        claims = decode_access_token(token)
        assert claims["acting_as_demo"] is True
        assert claims["admin_origin_user_id"] == 7

    def test_reserved_claims_cannot_be_overridden(self):
        from backend.services.auth_service import create_access_token, decode_access_token

        token = create_access_token(
            42,
            "user@example.com",
            extra_claims={"sub": "999", "email": "attacker@example.com", "type": "refresh"},
        )
        claims = decode_access_token(token)
        assert claims["sub"] == "42"
        assert claims["email"] == "user@example.com"
        assert claims["type"] == "access"

    def test_backward_compatible_without_extra_claims(self):
        from backend.services.auth_service import create_access_token, decode_access_token

        token = create_access_token(7, "x@example.com")
        claims = decode_access_token(token)
        assert claims["sub"] == "7"
        assert "acting_as_demo" not in claims


class TestViewAsDemo:
    def test_admin_view_as_demo_success_and_me_reflects_it(self, client, users):
        from backend.services.auth_service import create_access_token

        admin, demo = users["admin"], users["demo"]
        admin_token = create_access_token(admin["id"], admin["email"])

        r = client.post(
            "/api/auth/view-as", json={"profile": "demo"}, headers=_bearer(admin_token)
        )
        assert r.status_code == 200
        body = r.json()
        assert body["token_type"] == "bearer"
        assert "refresh_token" not in body
        assert body["user"] == {"id": demo["id"], "email": demo["email"], "name": demo["name"]}

        acting_token = body["access_token"]
        me = client.get("/api/auth/me", headers=_bearer(acting_token))
        assert me.status_code == 200
        me_body = me.json()
        assert me_body["id"] == demo["id"]
        assert me_body["role"] == "demo"
        assert me_body["acting_as_demo"] is True
        assert me_body.get("admin_origin_email") == admin["email"]

    def test_view_as_data_read_is_demo_scoped(self, client, users):
        """Per-user scoping of a data read made with the acting token.

        Seeds real pages rather than ``graph_cache`` rows: since migration
        batch 03 task R2, ``GET /api/graph`` rebuilds from Postgres on every
        call (see ``get_graph``) and no longer reads the cache, so a seeded
        cache row would prove nothing. Node ids are the title slugs
        ``build_graph_from_db`` derives, so the assertions are unchanged.
        """
        from backend.services.auth_service import create_access_token

        admin, demo = users["admin"], users["demo"]
        _seed_page(admin["id"], "cap_view_as_admin", "Admin Node")
        _seed_page(demo["id"], "cap_view_as_demo", "Demo Node")

        admin_token = create_access_token(admin["id"], admin["email"])
        view_as = client.post(
            "/api/auth/view-as", json={"profile": "demo"}, headers=_bearer(admin_token)
        )
        acting_token = view_as.json()["access_token"]

        r = client.get("/api/graph", headers=_bearer(acting_token))
        assert r.status_code == 200
        node_ids = {n["id"] for n in r.json()["nodes"]}
        assert "demo_node" in node_ids
        assert "admin_node" not in node_ids

    def test_non_admin_view_as_forbidden(self, client, users):
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        token = create_access_token(plain["id"], plain["email"])
        r = client.post("/api/auth/view-as", json={"profile": "demo"}, headers=_bearer(token))
        assert r.status_code == 403

    def test_nested_view_as_forbidden(self, client, users):
        """An admin-role token that already carries acting_as_demo must be
        refused -- constructed directly (rather than via a real view-as
        round trip) so this exercises the no-nest claims check on its own,
        independent of the admin-role check that would also reject a
        demo-role actor for an unrelated reason."""
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        token = create_access_token(
            admin["id"], admin["email"], extra_claims={"acting_as_demo": True}
        )
        r = client.post("/api/auth/view-as", json={"profile": "demo"}, headers=_bearer(token))
        assert r.status_code == 403

    def test_invalid_profile_rejected(self, client, users):
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        token = create_access_token(admin["id"], admin["email"])
        r = client.post("/api/auth/view-as", json={"profile": "admin"}, headers=_bearer(token))
        assert r.status_code in (400, 422)

    def test_demo_account_unavailable_forbidden(self, client, users):
        """If the resolved 'demo' account's role isn't actually 'demo'
        (re-roled/demoted), view-as must refuse rather than mint a token
        for a non-demo account under the demo label."""
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        admin, demo = users["admin"], users["demo"]
        ar.set_role(demo["id"], "user")

        admin_token = create_access_token(admin["id"], admin["email"])
        r = client.post(
            "/api/auth/view-as", json={"profile": "demo"}, headers=_bearer(admin_token)
        )
        assert r.status_code == 403


class TestReturnToAdmin:
    def test_round_trip_restores_admin(self, client, users):
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        admin_token = create_access_token(admin["id"], admin["email"])
        view_as = client.post(
            "/api/auth/view-as", json={"profile": "demo"}, headers=_bearer(admin_token)
        )
        acting_token = view_as.json()["access_token"]

        r = client.post("/api/auth/return-to-admin", headers=_bearer(acting_token))
        assert r.status_code == 200
        body = r.json()
        assert body["user"] == {"id": admin["id"], "email": admin["email"], "name": admin["name"]}
        # Same no-refresh contract as view-as -- a refresh here would let
        # the admin identity be silently renewed without re-authenticating.
        assert "refresh_token" not in body

        me = client.get("/api/auth/me", headers=_bearer(body["access_token"]))
        assert me.status_code == 200
        assert me.json()["role"] == "admin"
        assert me.json()["acting_as_demo"] is False

    def test_return_without_claim_forbidden(self, client, users):
        """A direct demo login (no acting_as_demo/admin_origin_user_id claim)
        cannot manufacture a return -- verified no-op, mirrors Dash's
        session.get('admin_origin_user_id') is None branch."""
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        token = create_access_token(demo["id"], demo["email"])
        r = client.post("/api/auth/return-to-admin", headers=_bearer(token))
        assert r.status_code == 403

    def test_return_forbidden_when_origin_admin_demoted(self, client, users):
        """The most security-relevant guard in this change: re-checks
        get_role(admin_origin_user_id) from the DB rather than trusting the
        token's claim. Mint a genuine acting-as-demo token via a real
        view-as call, THEN demote the origin admin, and confirm the stale
        token can no longer be exchanged back for admin privileges."""
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        admin_token = create_access_token(admin["id"], admin["email"])
        view_as = client.post(
            "/api/auth/view-as", json={"profile": "demo"}, headers=_bearer(admin_token)
        )
        acting_token = view_as.json()["access_token"]

        ar.set_role(admin["id"], "user")  # demote after the token was minted

        r = client.post("/api/auth/return-to-admin", headers=_bearer(acting_token))
        assert r.status_code == 403

    def test_return_forbidden_on_malformed_origin_claim(self, client, users):
        """admin_origin_user_id must be coercible to int; a malformed value
        (only reachable with our own signing key -- defense in depth, not
        an exploitable path through the public API) 403s instead of 500ing."""
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        token = create_access_token(
            demo["id"],
            demo["email"],
            extra_claims={"acting_as_demo": True, "admin_origin_user_id": "not-a-number"},
        )
        r = client.post("/api/auth/return-to-admin", headers=_bearer(token))
        assert r.status_code == 403


class TestDevModeViewAsRoundTrip:
    """Regression: in development mode the auth dependencies must prefer a
    present, successfully-decoding Bearer token over the dev bypass.

    Before the fix, both ``verify_api_key`` and ``get_current_claims``
    short-circuited on ``settings.is_development`` BEFORE reading the
    Authorization header, so the demo JWT minted by ``/api/auth/view-as``
    was discarded by every subsequent request and ``/api/auth/me`` kept
    reporting the dev-default admin identity (compendium batch-03
    results.md follow-up #4).
    """

    def test_acting_token_round_trips_in_dev(self, client, dev_users):
        """The actual dev UX: an anonymous request (dev bypass) launches
        view-as, and the minted demo token is then honored -- /me reports
        the demo identity + acting claim, not the dev-default user."""
        from backend.api.main import get_default_user_id
        from backend.db import auth_repo as ar

        demo = dev_users["demo"]
        ar.set_role(get_default_user_id(), "admin")

        r = client.post("/api/auth/view-as", json={"profile": "demo"})
        assert r.status_code == 200
        acting_token = r.json()["access_token"]

        me = client.get("/api/auth/me", headers=_bearer(acting_token))
        assert me.status_code == 200
        body = me.json()
        assert body["id"] == demo["id"]
        assert body["role"] == "demo"
        assert body["acting_as_demo"] is True

    def test_valid_bearer_token_wins_over_dev_bypass(self, client, dev_users):
        from backend.services.auth_service import create_access_token

        admin = dev_users["admin"]
        token = create_access_token(admin["id"], admin["email"])
        me = client.get("/api/auth/me", headers=_bearer(token))
        assert me.status_code == 200
        assert me.json()["id"] == admin["id"]
        assert me.json()["acting_as_demo"] is False

    def test_anonymous_dev_request_still_bypasses(self, client, dev_users):
        """Anonymous local-dev ergonomics preserved: no token resolves to
        the dev-default identity, not a 401."""
        from backend.api.main import get_default_user_id

        dev_uid = get_default_user_id()
        me = client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["id"] == dev_uid
        assert me.json()["acting_as_demo"] is False

    def test_undecodable_bearer_falls_back_to_bypass_in_dev(self, client, dev_users):
        """Dev mode never 401s: a garbage/expired token degrades to the
        dev-default identity instead of breaking local dev."""
        from backend.api.main import get_default_user_id

        dev_uid = get_default_user_id()
        me = client.get("/api/auth/me", headers=_bearer("not-a-jwt"))
        assert me.status_code == 200
        assert me.json()["id"] == dev_uid


class TestLoginParity:
    def test_login_with_username(self, client, users):
        admin = users["admin"]
        r = client.post(
            "/api/auth/login", json={"email": "adminuser", "password": "adminpass123"}
        )
        assert r.status_code == 200
        assert r.json()["user"]["id"] == admin["id"]

    def test_login_with_email_still_works(self, client, users):
        admin = users["admin"]
        r = client.post(
            "/api/auth/login", json={"email": admin["email"], "password": "adminpass123"}
        )
        assert r.status_code == 200
        assert r.json()["user"]["id"] == admin["id"]


class TestPreferencesWriteGate:
    def test_plain_demo_write_forbidden(self, client, users):
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        token = create_access_token(demo["id"], demo["email"])
        r = client.patch(
            "/api/auth/preferences", json={"preferences": {"theme": "dark"}}, headers=_bearer(token)
        )
        assert r.status_code == 403

    def test_acting_as_demo_write_allowed(self, client, users):
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        admin_token = create_access_token(admin["id"], admin["email"])
        view_as = client.post(
            "/api/auth/view-as", json={"profile": "demo"}, headers=_bearer(admin_token)
        )
        acting_token = view_as.json()["access_token"]

        r = client.patch(
            "/api/auth/preferences",
            json={"preferences": {"theme": "dark"}},
            headers=_bearer(acting_token),
        )
        assert r.status_code == 200
        assert r.json().get("theme") == "dark"

    def test_admin_write_unaffected(self, client, users):
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        token = create_access_token(admin["id"], admin["email"])
        r = client.patch(
            "/api/auth/preferences",
            json={"preferences": {"theme": "light"}},
            headers=_bearer(token),
        )
        assert r.status_code == 200
        assert r.json().get("theme") == "light"


class TestAgentInternalsGate:
    """GET /api/agent/internals -- admin-context-only REST port of the Dash
    "Agent Internals" gear panel (graph_canvas.py). Same predicate as the
    preferences write gate above: real admin role OR an acting_as_demo
    token; plain demo/regular-user logins are refused."""

    def test_admin_sees_system_prompt_and_tools(self, client, users):
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        token = create_access_token(admin["id"], admin["email"])
        r = client.get("/api/agent/internals", headers=_bearer(token))
        assert r.status_code == 200
        body = r.json()
        assert set(body.keys()) == {"system_prompt", "tools"}
        assert isinstance(body["system_prompt"], str) and body["system_prompt"]
        assert isinstance(body["tools"], list) and len(body["tools"]) > 0

    def test_plain_user_forbidden(self, client, users):
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        token = create_access_token(plain["id"], plain["email"])
        r = client.get("/api/agent/internals", headers=_bearer(token))
        assert r.status_code == 403

    def test_plain_demo_without_acting_claim_forbidden(self, client, users):
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        token = create_access_token(demo["id"], demo["email"])
        r = client.get("/api/agent/internals", headers=_bearer(token))
        assert r.status_code == 403

    def test_acting_as_demo_allowed(self, client, users):
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        admin_token = create_access_token(admin["id"], admin["email"])
        view_as = client.post(
            "/api/auth/view-as", json={"profile": "demo"}, headers=_bearer(admin_token)
        )
        acting_token = view_as.json()["access_token"]

        r = client.get("/api/agent/internals", headers=_bearer(acting_token))
        assert r.status_code == 200
        body = r.json()
        assert body["tools"]
