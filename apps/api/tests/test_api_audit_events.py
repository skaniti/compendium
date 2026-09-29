"""GET /api/admin/audit-events (audit-and-ops-journal Task 3). Real DB."""

import pytest
from fastapi.testclient import TestClient

from backend.config.settings import settings
from backend.db import audit_repo, auth_repo, user_repo
from backend.db.connection import get_conn
from backend.services import auth_service

URL = "/api/admin/audit-events"


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        connect(settings.test_database_url).close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
        cur.execute("DELETE FROM audit_events")
    admin = user_repo.create_user("admin@test.local", name="Admin")
    auth_repo.set_role(admin["id"], "admin")
    demo = user_repo.create_user("demo@traversal.local", name="Demo")
    auth_repo.set_role(demo["id"], "demo")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM audit_events")
    for i in range(5):
        audit_repo.record(
            "auth.login.ok" if i % 2 == 0 else "auth.login.failed", subject_user_id=admin["id"]
        )
    return {"admin": admin, "demo": demo}


@pytest.fixture
def client():
    from backend.api.main import app

    return TestClient(app)


def _h(user, **claims):
    tok = auth_service.create_access_token(user["id"], user["email"], extra_claims=claims or None)
    return {"Authorization": f"Bearer {tok}"}


def test_admin_lists_newest_first(env, client):
    r = client.get(URL, headers=_h(env["admin"]))
    assert r.status_code == 200
    events = r.json()["events"]
    assert len(events) == 5
    ids = [e["id"] for e in events]
    assert ids == sorted(ids, reverse=True)
    assert "T" in events[0]["at"]


def test_paging_with_before_id(env, client):
    h = _h(env["admin"])
    first = client.get(URL, params={"limit": 2}, headers=h).json()["events"]
    assert len(first) == 2
    nxt = client.get(URL, params={"limit": 2, "before_id": first[-1]["id"]}, headers=h).json()[
        "events"
    ]
    assert len(nxt) == 2
    assert nxt[0]["id"] < first[-1]["id"]


def test_filter_by_event(env, client):
    ev = client.get(URL, params={"event": "auth.login.failed"}, headers=_h(env["admin"])).json()[
        "events"
    ]
    assert len(ev) == 2 and {e["event"] for e in ev} == {"auth.login.failed"}


def test_limit_clamped(env, client):
    r = client.get(URL, params={"limit": 9999}, headers=_h(env["admin"]))
    assert r.status_code == 200


def test_demo_forbidden(env, client):
    assert client.get(URL, headers=_h(env["demo"])).status_code == 403


def test_admin_acting_as_demo_forbidden(env, client):
    h = _h(env["admin"], acting_as_demo=True, admin_origin_user_id=env["admin"]["id"])
    assert client.get(URL, headers=h).status_code == 403


def test_unauthenticated_401(env, client):
    assert client.get(URL).status_code == 401
