"""Endpoint tests for PATCH /api/topics/{keyword} (migration batch 02, task
8, deliverable 2) -- REST equivalent of Dash's sc_rename_topic
(frontend/dash/callbacks/topics.py:1509).

Purely mock-based -- no PG required. Mirrors the `mocked_client` harness in
tests/test_topic_exclusions_api.py: verify_api_key is dependency-overridden
and repo calls are monkeypatched at their source module. main.py's handler
does a lazy `from backend.db import auth_repo as ar` / `from
backend.services.super_cluster_service import assign_super_clusters` inside
the function body, so patching the source module's attribute (rather than
an attribute on the main module) takes effect regardless of import timing.

NO real LLM/network calls: assign_super_clusters is monkeypatched to a
lightweight async stub in every test that reaches it.
"""

import pytest
from fastapi.testclient import TestClient

from backend.api.main import app, verify_api_key


@pytest.fixture
def client():
    app.dependency_overrides[verify_api_key] = lambda: 42
    yield TestClient(app)
    app.dependency_overrides.pop(verify_api_key, None)


def _prefs_store(monkeypatch, initial=None):
    """Stand in for auth_repo.get_preferences/update_preferences with a tiny
    mutable dict, round-tripping like the real shallow-merge
    `preferences || %s::jsonb` UPDATE."""
    store = {"preferences": dict(initial or {})}

    def get_preferences(user_id):
        return store["preferences"]

    def update_preferences(user_id, patch):
        store["preferences"].update(patch)

    monkeypatch.setattr("backend.db.auth_repo.get_preferences", get_preferences)
    monkeypatch.setattr("backend.db.auth_repo.update_preferences", update_preferences)
    return store


def _mock_assign(monkeypatch):
    """Stub out the LLM/clustering-backed assign_super_clusters call and
    return a list that records each (user_id, topics) call it received."""
    calls = []

    async def _fake_assign(user_id, topics):
        calls.append((user_id, topics))

    monkeypatch.setattr(
        "backend.services.super_cluster_service.assign_super_clusters", _fake_assign
    )
    return calls


class TestRenameNotFound:
    def test_unknown_topic_404(self, client, monkeypatch):
        _prefs_store(monkeypatch, {"topic_interests": [{"keyword": "astro", "icon_id": "star"}]})
        _mock_assign(monkeypatch)

        resp = client.patch("/api/topics/nonexistent", json={"keyword": "newname"})
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Topic 'nonexistent' not found"


class TestRenameDuplicate:
    def test_dup_name_rejected_case_insensitively(self, client, monkeypatch):
        _prefs_store(
            monkeypatch,
            {
                "topic_interests": [
                    {"keyword": "astro", "icon_id": "star"},
                    {"keyword": "baking", "icon_id": "cake"},
                ]
            },
        )
        calls = _mock_assign(monkeypatch)

        resp = client.patch("/api/topics/astro", json={"keyword": "BAKING"})
        assert resp.status_code == 400
        assert calls == []


class TestRenameNoop:
    def test_same_name_case_insensitive_is_a_noop(self, client, monkeypatch):
        store = _prefs_store(
            monkeypatch, {"topic_interests": [{"keyword": "astro", "icon_id": "star"}]}
        )
        calls = _mock_assign(monkeypatch)

        resp = client.patch("/api/topics/astro", json={"keyword": "ASTRO"})
        assert resp.status_code == 200
        assert resp.json() == {"topics": [{"keyword": "astro", "icon_id": "star"}]}
        # True no-op: no persistence write, no reassignment.
        assert store["preferences"]["topic_interests"] == [
            {"keyword": "astro", "icon_id": "star"}
        ]
        assert calls == []


class TestRenameSuccess:
    def test_rename_persists_and_preserves_icon_and_order(self, client, monkeypatch):
        from backend.config.settings import settings

        # Explicit non-hybrid mode: the real ambient settings.supercluster_mode
        # is environment-configured (may be "hybrid" in this deployment), and
        # this test asserts the non-hybrid reassignment branch specifically.
        monkeypatch.setattr(settings, "supercluster_mode", "keywords")
        store = _prefs_store(
            monkeypatch,
            {
                "topic_interests": [
                    {"keyword": "astro", "icon_id": "star"},
                    {"keyword": "baking", "icon_id": "cake"},
                ]
            },
        )
        calls = _mock_assign(monkeypatch)

        resp = client.patch("/api/topics/astro", json={"keyword": "astronomy"})
        assert resp.status_code == 200
        expected = [
            {"keyword": "astronomy", "icon_id": "star"},
            {"keyword": "baking", "icon_id": "cake"},
        ]
        assert resp.json() == {"topics": expected}
        # Persisted, not just returned.
        assert store["preferences"]["topic_interests"] == expected
        # assign_super_clusters called in the (default) non-hybrid mode.
        assert len(calls) == 1
        assert calls[0] == (42, expected)

    def test_rename_matches_path_keyword_case_insensitively(self, client, monkeypatch):
        store = _prefs_store(
            monkeypatch, {"topic_interests": [{"keyword": "Astro", "icon_id": "star"}]}
        )
        _mock_assign(monkeypatch)

        resp = client.patch("/api/topics/ASTRO", json={"keyword": "astronomy"})
        assert resp.status_code == 200
        assert resp.json() == {"topics": [{"keyword": "astronomy", "icon_id": "star"}]}
        assert store["preferences"]["topic_interests"][0]["keyword"] == "astronomy"

    def test_whitespace_is_stripped_from_new_name(self, client, monkeypatch):
        _prefs_store(monkeypatch, {"topic_interests": [{"keyword": "astro", "icon_id": "star"}]})
        _mock_assign(monkeypatch)

        resp = client.patch("/api/topics/astro", json={"keyword": "  astronomy  "})
        assert resp.status_code == 200
        assert resp.json()["topics"][0]["keyword"] == "astronomy"

    def test_stripped_empty_name_rejected(self, client, monkeypatch):
        _prefs_store(monkeypatch, {"topic_interests": [{"keyword": "astro", "icon_id": "star"}]})
        _mock_assign(monkeypatch)

        resp = client.patch("/api/topics/astro", json={"keyword": "   "})
        assert resp.status_code == 400


class TestRenameHybridGuard:
    def test_hybrid_mode_skips_reassignment(self, client, monkeypatch):
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "supercluster_mode", "hybrid")
        _prefs_store(monkeypatch, {"topic_interests": [{"keyword": "astro", "icon_id": "star"}]})
        calls = _mock_assign(monkeypatch)

        resp = client.patch("/api/topics/astro", json={"keyword": "astronomy"})
        assert resp.status_code == 200
        assert calls == []

    def test_non_hybrid_mode_reassigns(self, client, monkeypatch):
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "supercluster_mode", "keywords")
        _prefs_store(monkeypatch, {"topic_interests": [{"keyword": "astro", "icon_id": "star"}]})
        calls = _mock_assign(monkeypatch)

        resp = client.patch("/api/topics/astro", json={"keyword": "astronomy"})
        assert resp.status_code == 200
        assert len(calls) == 1


class TestRenameAuth:
    def test_unauthed_request_rejected_in_prod_mode(self, monkeypatch):
        """Force production-mode auth -- the dev bypass (default in tests)
        would otherwise resolve a default user and never exercise the auth
        gate at all. Mirrors tests/test_api_diary.py's prod-mode pattern.
        No dependency override here -- exercising the real auth path."""
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "production")
        tc = TestClient(app)

        resp = tc.patch("/api/topics/astro", json={"keyword": "astronomy"})
        assert resp.status_code == 401
