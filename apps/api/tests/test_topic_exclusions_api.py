"""Endpoint tests for class-(e) SC member exclusions (Task 4).

Purely mock-based -- no PG required. Mirrors the `mocked_client` harness in
tests/test_api_dq_bot.py (TestRunNowAbortMocked): verify_api_key is
dependency-overridden and repo calls are monkeypatched at their source
module. The endpoints in backend/api/main.py do lazy `from backend.db
import ...` imports inside the function body, so patching
`backend.db.<repo>.<fn>` (rather than an attribute on the main module) takes
effect regardless of import timing.
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


class TestListExclusions:
    def test_list_returns_stored_exclusions(self, client, monkeypatch):
        existing = [
            {
                "keyword": "kwA",
                "cluster_slug": "ethics_essays",
                "cluster_name": "Ethics Essays",
                "created_at": "2026-07-01T00:00:00+00:00",
            }
        ]
        _prefs_store(monkeypatch, {"sc_member_exclusions": existing})

        resp = client.get("/api/topics/exclusions")
        assert resp.status_code == 200
        assert resp.json() == {"exclusions": existing}

    def test_list_empty_when_unset(self, client, monkeypatch):
        _prefs_store(monkeypatch)

        resp = client.get("/api/topics/exclusions")
        assert resp.status_code == 200
        assert resp.json() == {"exclusions": []}


class TestAddExclusion:
    def test_add_appends_new_entry(self, client, monkeypatch):
        store = _prefs_store(monkeypatch)
        monkeypatch.setattr(
            "backend.db.cluster_repo.get_clusters_for_user", lambda uid, rid=None: []
        )

        resp = client.post(
            "/api/topics/exclusions",
            json={"keyword": "kwA", "cluster_name": "Ethics Essays"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["exclusions"]) == 1
        entry = body["exclusions"][0]
        assert entry["keyword"] == "kwA"
        assert entry["cluster_slug"] == "ethics_essays"
        assert entry["cluster_name"] == "Ethics Essays"
        assert "created_at" in entry
        assert body["unlabeled"] is False
        # persisted via update_preferences, not just returned
        assert store["preferences"]["sc_member_exclusions"] == body["exclusions"]

    def test_add_dedupes_case_insensitively(self, client, monkeypatch):
        _prefs_store(monkeypatch)
        monkeypatch.setattr(
            "backend.db.cluster_repo.get_clusters_for_user", lambda uid, rid=None: []
        )

        r1 = client.post(
            "/api/topics/exclusions",
            json={"keyword": "kwA", "cluster_name": "Ethics Essays"},
        )
        r2 = client.post(
            "/api/topics/exclusions",
            json={"keyword": "KWA", "cluster_name": "Ethics Essays"},
        )
        assert len(r1.json()["exclusions"]) == 1
        assert len(r2.json()["exclusions"]) == 1

    def test_add_unlabels_currently_painted_cluster(self, client, monkeypatch):
        _prefs_store(monkeypatch)
        monkeypatch.setattr(
            "backend.db.cluster_repo.get_clusters_for_user",
            lambda uid, rid=None: [
                {
                    "id": 501,
                    "cluster_slug": "ethics_essays",
                    "cluster_name": "Ethics Essays",
                    "super_cluster": "kwA",
                },
            ],
        )
        updates = {}
        monkeypatch.setattr(
            "backend.db.cluster_repo.update_super_clusters",
            lambda uid, a: updates.setdefault("labels", a),
        )
        monkeypatch.setattr(
            "backend.db.cluster_repo.update_cluster_groups",
            lambda uid, a: updates.setdefault("groups", a),
        )
        monkeypatch.setattr(
            "backend.services.graph_builder.build_graph_from_db",
            lambda uid: object(),
        )
        monkeypatch.setattr(
            "backend.services.graph_service.save_graph", lambda g, uid: None
        )

        resp = client.post(
            "/api/topics/exclusions",
            json={"keyword": "kwA", "cluster_name": "Ethics Essays"},
        )
        assert resp.status_code == 200
        assert resp.json()["unlabeled"] is True
        assert updates["labels"] == {501: None}
        assert updates["groups"] == {501: None}

    def test_add_does_not_unlabel_when_labeled_differently(self, client, monkeypatch):
        _prefs_store(monkeypatch)
        monkeypatch.setattr(
            "backend.db.cluster_repo.get_clusters_for_user",
            lambda uid, rid=None: [
                {
                    "id": 501,
                    "cluster_slug": "ethics_essays",
                    "cluster_name": "Ethics Essays",
                    "super_cluster": "kwB",
                },
            ],
        )

        resp = client.post(
            "/api/topics/exclusions",
            json={"keyword": "kwA", "cluster_name": "Ethics Essays"},
        )
        assert resp.status_code == 200
        assert resp.json()["unlabeled"] is False

    def test_add_unlabel_failure_is_non_fatal(self, client, monkeypatch):
        """Graph rebuild failure must not fail the request -- the cluster
        mutation stands; graph_cache can be rebuilt later."""
        _prefs_store(monkeypatch)
        monkeypatch.setattr(
            "backend.db.cluster_repo.get_clusters_for_user",
            lambda uid, rid=None: [
                {
                    "id": 501,
                    "cluster_slug": "ethics_essays",
                    "cluster_name": "Ethics Essays",
                    "super_cluster": "kwA",
                },
            ],
        )
        monkeypatch.setattr(
            "backend.db.cluster_repo.update_super_clusters", lambda uid, a: None
        )
        monkeypatch.setattr(
            "backend.db.cluster_repo.update_cluster_groups", lambda uid, a: None
        )

        def _boom(uid):
            raise RuntimeError("graph db unreachable")

        monkeypatch.setattr(
            "backend.services.graph_builder.build_graph_from_db", _boom
        )

        resp = client.post(
            "/api/topics/exclusions",
            json={"keyword": "kwA", "cluster_name": "Ethics Essays"},
        )
        assert resp.status_code == 200
        assert resp.json()["unlabeled"] is True


class TestRemoveExclusion:
    def test_delete_removes_matching_pair(self, client, monkeypatch):
        existing = [
            {
                "keyword": "kwA",
                "cluster_slug": "ethics_essays",
                "cluster_name": "Ethics Essays",
                "created_at": "x",
            },
            {
                "keyword": "kwB",
                "cluster_slug": "star_charts",
                "cluster_name": "Star Charts",
                "created_at": "x",
            },
        ]
        store = _prefs_store(monkeypatch, {"sc_member_exclusions": existing})

        resp = client.request(
            "DELETE",
            "/api/topics/exclusions",
            json={"keyword": "kwA", "cluster_name": "Ethics Essays"},
        )
        assert resp.status_code == 200
        remaining = resp.json()["exclusions"]
        assert len(remaining) == 1
        assert remaining[0]["keyword"] == "kwB"
        assert store["preferences"]["sc_member_exclusions"] == remaining

    def test_delete_no_op_when_not_present(self, client, monkeypatch):
        existing = [
            {
                "keyword": "kwA",
                "cluster_slug": "ethics_essays",
                "cluster_name": "Ethics Essays",
                "created_at": "x",
            },
        ]
        _prefs_store(monkeypatch, {"sc_member_exclusions": existing})

        resp = client.request(
            "DELETE",
            "/api/topics/exclusions",
            json={"keyword": "kwZ", "cluster_name": "Nonexistent"},
        )
        assert resp.status_code == 200
        assert resp.json()["exclusions"] == existing
