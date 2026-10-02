"""Endpoint contract tests for the plain-demo mutation gate (migration
batch 02, task 8, deliverable 3; extended by the task-8 fix wave, I2):
``verify_not_plain_demo``, applied to nine mutation endpoints --

    POST   /api/recluster
    POST   /api/topics
    DELETE /api/topics/{keyword}
    PATCH  /api/topics/{keyword}                    (rename, task 8 deliverable 2)
    PUT    /api/topics/{keyword}/icon
    POST   /api/topics/exclusions
    DELETE /api/topics/exclusions
    POST   /api/topics/suggestions/{group_id}/accept  (fix wave I2)
    POST   /api/topics/suggestions/{group_id}/dismiss (fix wave I2)

Mirrors Dash's role_guard.is_plain_demo(): a DIRECT demo login (role ==
"demo", no acting_as_demo claim) is refused; an admin-launched
view-as-demo session (acting_as_demo == True) and any normal-role user
pass through untouched. The FastAPI equivalent pre-dates this task only on
PATCH /api/auth/preferences (main.py:2786) -- covered by
tests/test_api_view_as.py's TestPreferencesWriteGate, left as-is here.

Mirrors batch-04's tests/test_api_view_as.py fixtures (prod_auth, users,
client) -- real Postgres-backed admin/demo/plain users and real JWT
tokens via auth_service.create_access_token, so the dependency's
ar.get_role(user_id) DB lookup and get_current_claims' JWT decode are
exercised for real rather than mocked. Service-layer calls the gated
handlers make on success (LLM icon selection, supercluster reassignment,
full reclustering) are monkeypatched to lightweight call-recording stubs
in every test -- the gate outcome is what's under test, not the endpoint
body. NO real LLM/network/clustering calls happen in this file.
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


@pytest.fixture(autouse=True)
def _force_non_hybrid_mode(monkeypatch):
    """Force a non-hybrid supercluster_mode for every test in this file.

    add/remove/rename topic only call assign_super_clusters when
    settings.supercluster_mode != "hybrid" -- the real ambient setting in
    this deployment IS "hybrid", which would silently skip that call and
    make the "acting-as-demo/normal-user passes the gate AND the handler
    body ran" assertions meaningless. Forcing it here keeps those
    assertions deterministic regardless of deployment config.
    """
    from backend.config.settings import settings

    monkeypatch.setattr(settings, "supercluster_mode", "keywords")


@pytest.fixture
def prod_auth(monkeypatch):
    """Force production-mode auth so verify_api_key / get_current_claims take
    the real JWT Bearer path instead of the dev bypass. The dev bypass
    always resolves to the dev-default user and never touches claims at
    all, which would short-circuit every guard under test here."""
    from backend.config.settings import settings

    monkeypatch.setattr(settings, "environment", "production")
    return settings


@pytest.fixture
def users(prod_auth):
    """Fresh admin / demo / plain-role users, truncated per test. Mirrors
    tests/test_api_view_as.py's ``users`` fixture: ``demo`` is discoverable
    both by username 'demo' and email 'demo@traversal.local' -- the two
    paths the view-as resolver tries."""
    from backend.db import auth_repo as ar, user_repo
    from backend.db.connection import get_conn
    from backend.services.auth_service import hash_password

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                TRUNCATE graph_cache, cluster_edges, page_clusters,
                         super_cluster_groups, clusters, recluster_runs,
                         pages, page_content, captures, users
                CASCADE
                """
            )

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
def client():
    from backend.api.main import app

    return TestClient(app)


def _acting_as_demo_token(client, admin_token):
    r = client.post(
        "/api/auth/view-as", json={"profile": "demo"}, headers=_bearer(admin_token)
    )
    assert r.status_code == 200
    return r.json()["access_token"]


def _mock_recluster(monkeypatch):
    """Stub ClusteringService.recluster_all -- POST /api/recluster's only
    body -- so a passing-gate request never runs real HDBSCAN/LLM work."""
    calls = []

    async def _fake(self, batch_mode=False):
        calls.append(self._user_id)
        return {"status": "ok"}

    monkeypatch.setattr(
        "backend.services.clustering_service.ClusteringService.recluster_all", _fake
    )
    return calls


def _mock_select_icon(monkeypatch):
    calls = []

    async def _fake(topic_keyword):
        calls.append(topic_keyword)
        return "icon_x"

    monkeypatch.setattr("backend.services.super_cluster_service.select_icon_for_topic", _fake)
    return calls


def _mock_assign(monkeypatch):
    calls = []

    async def _fake(user_id, topics):
        calls.append((user_id, topics))

    monkeypatch.setattr("backend.services.super_cluster_service.assign_super_clusters", _fake)
    return calls


def _mock_apply_exclusion(monkeypatch):
    calls = []

    def _fake(user_id, keyword, cluster_slug):
        calls.append((user_id, keyword, cluster_slug))
        return False

    monkeypatch.setattr(
        "backend.services.super_cluster_service.apply_member_exclusion_now", _fake
    )
    return calls


# One suggested group, shape-matched to cluster_repo.get_groups_for_user's
# return contract. Stubbed rather than backed by real recluster_runs/
# super_cluster_groups rows -- mirrors tests/test_topic_suggestions_api.py's
# monkeypatch approach, avoiding a real completed-run fixture just to grow a
# group_id to look up.
_SUGGESTED_GROUP = [
    {
        "id": 5,
        "label": "Fiber Crafts",
        "source": "suggested",
        "topic": None,
        "topic_similarity": 0.2,
        "interest_tier": "recurrent",
        "evidence": {"n_weeks": 3},
        "member_count": 2,
        "page_count": 12,
        "cluster_ids": [11],
        "cluster_names": ["Crochet"],
    }
]


def _mock_groups(monkeypatch, groups):
    from backend.db import cluster_repo

    monkeypatch.setattr(
        cluster_repo,
        "get_groups_for_user",
        lambda user_id, recluster_run_id=None, source=None: groups,
    )


def _mock_update_group_acceptance(monkeypatch):
    from backend.db import cluster_repo

    calls = []

    def _fake(user_id, group_id, keyword):
        calls.append((user_id, group_id, keyword))
        return [11, 12]

    monkeypatch.setattr(cluster_repo, "update_group_acceptance", _fake)
    return calls


class TestReclusterGate:
    def test_direct_demo_forbidden(self, client, users, monkeypatch):
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        calls = _mock_recluster(monkeypatch)
        token = create_access_token(demo["id"], demo["email"])

        r = client.post("/api/recluster", headers=_bearer(token))
        assert r.status_code == 403
        assert calls == []

    def test_acting_as_demo_allowed(self, client, users, monkeypatch):
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        calls = _mock_recluster(monkeypatch)
        admin_token = create_access_token(admin["id"], admin["email"])
        acting_token = _acting_as_demo_token(client, admin_token)

        r = client.post("/api/recluster", headers=_bearer(acting_token))
        assert r.status_code != 403
        assert len(calls) == 1

    def test_normal_user_allowed(self, client, users, monkeypatch):
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        calls = _mock_recluster(monkeypatch)
        token = create_access_token(plain["id"], plain["email"])

        r = client.post("/api/recluster", headers=_bearer(token))
        assert r.status_code != 403
        assert len(calls) == 1


class TestAddTopicGate:
    def test_direct_demo_forbidden(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        icon_calls = _mock_select_icon(monkeypatch)
        assign_calls = _mock_assign(monkeypatch)
        token = create_access_token(demo["id"], demo["email"])

        r = client.post("/api/topics", json={"keyword": "newtopic"}, headers=_bearer(token))
        assert r.status_code == 403
        assert icon_calls == []
        assert assign_calls == []
        assert ar.get_preferences(demo["id"]).get("topic_interests", []) == []

    def test_acting_as_demo_allowed(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        admin, demo = users["admin"], users["demo"]
        _mock_select_icon(monkeypatch)
        assign_calls = _mock_assign(monkeypatch)
        admin_token = create_access_token(admin["id"], admin["email"])
        acting_token = _acting_as_demo_token(client, admin_token)

        r = client.post(
            "/api/topics", json={"keyword": "newtopic"}, headers=_bearer(acting_token)
        )
        assert r.status_code != 403
        assert len(assign_calls) == 1
        assert ar.get_preferences(demo["id"])["topic_interests"][0]["keyword"] == "newtopic"

    def test_normal_user_allowed(self, client, users, monkeypatch):
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        _mock_select_icon(monkeypatch)
        assign_calls = _mock_assign(monkeypatch)
        token = create_access_token(plain["id"], plain["email"])

        r = client.post("/api/topics", json={"keyword": "newtopic"}, headers=_bearer(token))
        assert r.status_code != 403
        assert len(assign_calls) == 1


class TestRemoveTopicGate:
    def test_direct_demo_forbidden(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        ar.update_preferences(
            demo["id"], {"topic_interests": [{"keyword": "existing", "icon_id": "x"}]}
        )
        assign_calls = _mock_assign(monkeypatch)
        token = create_access_token(demo["id"], demo["email"])

        r = client.delete("/api/topics/existing", headers=_bearer(token))
        assert r.status_code == 403
        assert assign_calls == []
        assert ar.get_preferences(demo["id"])["topic_interests"] == [
            {"keyword": "existing", "icon_id": "x"}
        ]

    def test_acting_as_demo_allowed(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        admin, demo = users["admin"], users["demo"]
        ar.update_preferences(
            demo["id"], {"topic_interests": [{"keyword": "existing", "icon_id": "x"}]}
        )
        assign_calls = _mock_assign(monkeypatch)
        admin_token = create_access_token(admin["id"], admin["email"])
        acting_token = _acting_as_demo_token(client, admin_token)

        r = client.delete("/api/topics/existing", headers=_bearer(acting_token))
        assert r.status_code != 403
        assert len(assign_calls) == 1
        assert ar.get_preferences(demo["id"])["topic_interests"] == []

    def test_normal_user_allowed(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        ar.update_preferences(
            plain["id"], {"topic_interests": [{"keyword": "existing", "icon_id": "x"}]}
        )
        assign_calls = _mock_assign(monkeypatch)
        token = create_access_token(plain["id"], plain["email"])

        r = client.delete("/api/topics/existing", headers=_bearer(token))
        assert r.status_code != 403
        assert len(assign_calls) == 1


class TestRenameTopicGate:
    def test_direct_demo_forbidden(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        ar.update_preferences(
            demo["id"], {"topic_interests": [{"keyword": "existing", "icon_id": "x"}]}
        )
        assign_calls = _mock_assign(monkeypatch)
        token = create_access_token(demo["id"], demo["email"])

        r = client.patch(
            "/api/topics/existing", json={"keyword": "renamed"}, headers=_bearer(token)
        )
        assert r.status_code == 403
        assert assign_calls == []
        assert ar.get_preferences(demo["id"])["topic_interests"] == [
            {"keyword": "existing", "icon_id": "x"}
        ]

    def test_acting_as_demo_allowed(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        admin, demo = users["admin"], users["demo"]
        ar.update_preferences(
            demo["id"], {"topic_interests": [{"keyword": "existing", "icon_id": "x"}]}
        )
        assign_calls = _mock_assign(monkeypatch)
        admin_token = create_access_token(admin["id"], admin["email"])
        acting_token = _acting_as_demo_token(client, admin_token)

        r = client.patch(
            "/api/topics/existing", json={"keyword": "renamed"}, headers=_bearer(acting_token)
        )
        assert r.status_code != 403
        assert len(assign_calls) == 1
        assert ar.get_preferences(demo["id"])["topic_interests"][0]["keyword"] == "renamed"

    def test_normal_user_allowed(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        ar.update_preferences(
            plain["id"], {"topic_interests": [{"keyword": "existing", "icon_id": "x"}]}
        )
        assign_calls = _mock_assign(monkeypatch)
        token = create_access_token(plain["id"], plain["email"])

        r = client.patch(
            "/api/topics/existing", json={"keyword": "renamed"}, headers=_bearer(token)
        )
        assert r.status_code != 403
        assert len(assign_calls) == 1


class TestTopicIconGate:
    """No service-layer mocking needed here -- override_topic_icon does a
    plain preferences write with no LLM/clustering call in its body."""

    def test_direct_demo_forbidden(self, client, users):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        ar.update_preferences(
            demo["id"], {"topic_interests": [{"keyword": "existing", "icon_id": "old"}]}
        )
        token = create_access_token(demo["id"], demo["email"])

        r = client.put(
            "/api/topics/existing/icon", json={"icon_id": "new"}, headers=_bearer(token)
        )
        assert r.status_code == 403
        assert ar.get_preferences(demo["id"])["topic_interests"][0]["icon_id"] == "old"

    def test_acting_as_demo_allowed(self, client, users):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        admin, demo = users["admin"], users["demo"]
        ar.update_preferences(
            demo["id"], {"topic_interests": [{"keyword": "existing", "icon_id": "old"}]}
        )
        admin_token = create_access_token(admin["id"], admin["email"])
        acting_token = _acting_as_demo_token(client, admin_token)

        r = client.put(
            "/api/topics/existing/icon", json={"icon_id": "new"}, headers=_bearer(acting_token)
        )
        assert r.status_code != 403
        assert ar.get_preferences(demo["id"])["topic_interests"][0]["icon_id"] == "new"

    def test_normal_user_allowed(self, client, users):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        ar.update_preferences(
            plain["id"], {"topic_interests": [{"keyword": "existing", "icon_id": "old"}]}
        )
        token = create_access_token(plain["id"], plain["email"])

        r = client.put(
            "/api/topics/existing/icon", json={"icon_id": "new"}, headers=_bearer(token)
        )
        assert r.status_code != 403


class TestAddExclusionGate:
    def test_direct_demo_forbidden(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        apply_calls = _mock_apply_exclusion(monkeypatch)
        token = create_access_token(demo["id"], demo["email"])

        r = client.post(
            "/api/topics/exclusions",
            json={"keyword": "kw", "cluster_name": "Some Cluster"},
            headers=_bearer(token),
        )
        assert r.status_code == 403
        assert apply_calls == []
        assert ar.get_preferences(demo["id"]).get("sc_member_exclusions", []) == []

    def test_acting_as_demo_allowed(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        admin, demo = users["admin"], users["demo"]
        apply_calls = _mock_apply_exclusion(monkeypatch)
        admin_token = create_access_token(admin["id"], admin["email"])
        acting_token = _acting_as_demo_token(client, admin_token)

        r = client.post(
            "/api/topics/exclusions",
            json={"keyword": "kw", "cluster_name": "Some Cluster"},
            headers=_bearer(acting_token),
        )
        assert r.status_code != 403
        assert len(apply_calls) == 1
        assert len(ar.get_preferences(demo["id"])["sc_member_exclusions"]) == 1

    def test_normal_user_allowed(self, client, users, monkeypatch):
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        apply_calls = _mock_apply_exclusion(monkeypatch)
        token = create_access_token(plain["id"], plain["email"])

        r = client.post(
            "/api/topics/exclusions",
            json={"keyword": "kw", "cluster_name": "Some Cluster"},
            headers=_bearer(token),
        )
        assert r.status_code != 403
        assert len(apply_calls) == 1


class TestRemoveExclusionGate:
    """No service-layer mocking needed here -- remove_member_exclusion does
    a plain preferences filter/write with no downstream service call."""

    _EXISTING = [
        {
            "keyword": "kw",
            "cluster_slug": "some_cluster",
            "cluster_name": "Some Cluster",
            "created_at": "2026-07-01T00:00:00+00:00",
        }
    ]

    def test_direct_demo_forbidden(self, client, users):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        ar.update_preferences(demo["id"], {"sc_member_exclusions": self._EXISTING})
        token = create_access_token(demo["id"], demo["email"])

        r = client.request(
            "DELETE",
            "/api/topics/exclusions",
            json={"keyword": "kw", "cluster_name": "Some Cluster"},
            headers=_bearer(token),
        )
        assert r.status_code == 403
        assert ar.get_preferences(demo["id"])["sc_member_exclusions"] == self._EXISTING

    def test_acting_as_demo_allowed(self, client, users):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        admin, demo = users["admin"], users["demo"]
        ar.update_preferences(demo["id"], {"sc_member_exclusions": self._EXISTING})
        admin_token = create_access_token(admin["id"], admin["email"])
        acting_token = _acting_as_demo_token(client, admin_token)

        r = client.request(
            "DELETE",
            "/api/topics/exclusions",
            json={"keyword": "kw", "cluster_name": "Some Cluster"},
            headers=_bearer(acting_token),
        )
        assert r.status_code != 403
        assert ar.get_preferences(demo["id"])["sc_member_exclusions"] == []

    def test_normal_user_allowed(self, client, users):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        ar.update_preferences(plain["id"], {"sc_member_exclusions": self._EXISTING})
        token = create_access_token(plain["id"], plain["email"])

        r = client.request(
            "DELETE",
            "/api/topics/exclusions",
            json={"keyword": "kw", "cluster_name": "Some Cluster"},
            headers=_bearer(token),
        )
        assert r.status_code != 403
        assert ar.get_preferences(plain["id"])["sc_member_exclusions"] == []


class TestAcceptSuggestionGate:
    """Fix wave I2: accept is a full structural mutation -- appends to
    topic_interests, fires select_icon_for_topic (LLM), and relabels member
    clusters immediately. Dash gates the equivalent callback
    (topic_suggestions.py:314)."""

    def test_direct_demo_forbidden(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        _mock_groups(monkeypatch, _SUGGESTED_GROUP)
        icon_calls = _mock_select_icon(monkeypatch)
        relabel_calls = _mock_update_group_acceptance(monkeypatch)
        token = create_access_token(demo["id"], demo["email"])

        r = client.post(
            "/api/topics/suggestions/5/accept", json={}, headers=_bearer(token)
        )
        assert r.status_code == 403
        assert icon_calls == []
        assert relabel_calls == []
        assert ar.get_preferences(demo["id"]).get("topic_interests", []) == []

    def test_acting_as_demo_allowed(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        admin, demo = users["admin"], users["demo"]
        _mock_groups(monkeypatch, _SUGGESTED_GROUP)
        _mock_select_icon(monkeypatch)
        relabel_calls = _mock_update_group_acceptance(monkeypatch)
        admin_token = create_access_token(admin["id"], admin["email"])
        acting_token = _acting_as_demo_token(client, admin_token)

        r = client.post(
            "/api/topics/suggestions/5/accept", json={}, headers=_bearer(acting_token)
        )
        assert r.status_code != 403
        assert len(relabel_calls) == 1
        assert ar.get_preferences(demo["id"])["topic_interests"][0]["keyword"] == "Fiber Crafts"

    def test_normal_user_allowed(self, client, users, monkeypatch):
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        _mock_groups(monkeypatch, _SUGGESTED_GROUP)
        _mock_select_icon(monkeypatch)
        relabel_calls = _mock_update_group_acceptance(monkeypatch)
        token = create_access_token(plain["id"], plain["email"])

        r = client.post(
            "/api/topics/suggestions/5/accept", json={}, headers=_bearer(token)
        )
        assert r.status_code != 403
        assert len(relabel_calls) == 1


class TestDismissSuggestionGate:
    """Fix wave I2: dismiss writes dismissed_topics (weak negative interest
    signal). Dash gates the equivalent callback (topic_suggestions.py:386,
    448)."""

    def test_direct_demo_forbidden(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        _mock_groups(monkeypatch, _SUGGESTED_GROUP)
        token = create_access_token(demo["id"], demo["email"])

        r = client.post("/api/topics/suggestions/5/dismiss", headers=_bearer(token))
        assert r.status_code == 403
        assert ar.get_preferences(demo["id"]).get("dismissed_topics", []) == []

    def test_acting_as_demo_allowed(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        admin, demo = users["admin"], users["demo"]
        _mock_groups(monkeypatch, _SUGGESTED_GROUP)
        admin_token = create_access_token(admin["id"], admin["email"])
        acting_token = _acting_as_demo_token(client, admin_token)

        r = client.post(
            "/api/topics/suggestions/5/dismiss", headers=_bearer(acting_token)
        )
        assert r.status_code != 403
        assert any(
            d["label"] == "Fiber Crafts"
            for d in ar.get_preferences(demo["id"])["dismissed_topics"]
        )

    def test_normal_user_allowed(self, client, users, monkeypatch):
        from backend.db import auth_repo as ar
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        _mock_groups(monkeypatch, _SUGGESTED_GROUP)
        token = create_access_token(plain["id"], plain["email"])

        r = client.post("/api/topics/suggestions/5/dismiss", headers=_bearer(token))
        assert r.status_code != 403
        assert any(
            d["label"] == "Fiber Crafts"
            for d in ar.get_preferences(plain["id"])["dismissed_topics"]
        )


# ===========================================================================
# Public-demo containment sweep (2026-08-26)
#
# compendium.example.com is publicly reachable and its `demo` credential is
# printed on a resume, so the demo session is a PUBLIC identity. These tests
# pin the guardrails added when that was audited:
#
#   * GET /api/logs was UNAUTHENTICATED and reachable through Dash's
#     /api/<path> proxy -- i.e. the whole log stream (cluster/topic names
#     inferred from the real corpus, captured domains) was world-readable.
#     Now verify_admin_context.
#   * Ingest (/api/captures, /api/passive-captures) reached the LLM skip-gate
#     and the unvalidated URL fetcher (SSRF surface) on a demo session.
#   * Page-override and tag writes mutated shared state from demo.
#
# Same three-way shape as the gates above: plain demo refused, acting-as-demo
# and normal users untouched.
# ===========================================================================


class TestLogsAdminGate:
    """GET /api/logs -- admin context, not merely authenticated."""

    def test_unauthenticated_refused(self, client, users):
        r = client.get("/api/logs")
        assert r.status_code == 401

    def test_direct_demo_forbidden(self, client, users):
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        token = create_access_token(demo["id"], demo["email"])
        assert client.get("/api/logs", headers=_bearer(token)).status_code == 403

    def test_normal_user_forbidden(self, client, users):
        """Logs carry cross-user operational detail -- 'authenticated' is not
        a sufficient bar, so even a plain non-demo user is refused."""
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        token = create_access_token(plain["id"], plain["email"])
        assert client.get("/api/logs", headers=_bearer(token)).status_code == 403

    def test_admin_allowed(self, client, users):
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        token = create_access_token(admin["id"], admin["email"])
        r = client.get("/api/logs", headers=_bearer(token))
        assert r.status_code == 200
        assert "records" in r.json()


class TestCaptureIngestGate:
    """Ingest is the demo's path to both LLM spend and the URL fetcher."""

    _PAYLOAD = {
        "captureId": "test_demo_gate_1",
        "startedAt": "2026-08-26T00:00:00Z",
        "pages": [{"url": "https://example.com/x", "title": "x", "visitedAt": "2026-08-26T00:00:00Z"}],
    }

    def test_direct_demo_forbidden(self, client, users):
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        token = create_access_token(demo["id"], demo["email"])
        r = client.post("/api/captures", json=self._PAYLOAD, headers=_bearer(token))
        assert r.status_code == 403

    def test_passive_capture_direct_demo_forbidden(self, client, users):
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        token = create_access_token(demo["id"], demo["email"])
        r = client.post("/api/passive-captures", json=self._PAYLOAD, headers=_bearer(token))
        assert r.status_code == 403

    def test_normal_user_not_gated(self, client, users):
        """The browser extension and Android collector post here as a normal
        user -- the gate must not touch them (403 is the only failure mode
        under test; any other status means the gate let it through)."""
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        token = create_access_token(plain["id"], plain["email"])
        r = client.post("/api/captures", json=self._PAYLOAD, headers=_bearer(token))
        assert r.status_code != 403

    @pytest.mark.parametrize("path", ["/api/captures", "/api/passive-captures"])
    def test_acting_as_demo_forbidden(self, client, users, path):
        """verify_not_demo_identity is stricter than the plain-demo gate: an
        admin's view-as-demo token must not ingest real browsing into the
        demo account either."""
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        admin_token = create_access_token(admin["id"], admin["email"])
        demo_token = _acting_as_demo_token(client, admin_token)
        r = client.post(path, json=self._PAYLOAD, headers=_bearer(demo_token))
        assert r.status_code == 403
        assert "ingest" in r.json()["detail"]

    @pytest.mark.parametrize("path", ["/api/captures", "/api/passive-captures"])
    def test_admin_not_gated(self, client, users, path):
        from backend.services.auth_service import create_access_token

        admin = users["admin"]
        token = create_access_token(admin["id"], admin["email"])
        r = client.post(path, json=self._PAYLOAD, headers=_bearer(token))
        assert r.status_code != 403

    def test_passive_capture_normal_user_not_gated(self, client, users):
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        token = create_access_token(plain["id"], plain["email"])
        r = client.post("/api/passive-captures", json=self._PAYLOAD, headers=_bearer(token))
        assert r.status_code != 403


class TestTagWriteGate:
    def test_direct_demo_forbidden(self, client, users):
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        token = create_access_token(demo["id"], demo["email"])
        r = client.post("/api/tags", json={"name": "demo-write"}, headers=_bearer(token))
        assert r.status_code == 403

    def test_normal_user_allowed(self, client, users):
        from backend.services.auth_service import create_access_token

        plain = users["plain"]
        token = create_access_token(plain["id"], plain["email"])
        r = client.post("/api/tags", json={"name": "ok-write"}, headers=_bearer(token))
        assert r.status_code != 403

    def test_demo_can_still_read_tags(self, client, users):
        """Containment is write-shaped here: the demo must still RENDER."""
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        token = create_access_token(demo["id"], demo["email"])
        assert client.get("/api/tags", headers=_bearer(token)).status_code == 200


class TestDemoReadSurfacesStillWork:
    """Guard against over-gating: the demo must remain a working demo."""

    @pytest.mark.parametrize("path", ["/api/graph", "/api/diary/windows", "/api/auth/me"])
    def test_demo_reads_allowed(self, client, users, path):
        from backend.services.auth_service import create_access_token

        demo = users["demo"]
        token = create_access_token(demo["id"], demo["email"])
        assert client.get(path, headers=_bearer(token)).status_code == 200
