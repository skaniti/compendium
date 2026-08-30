"""API tests for batch B 4d: topic-suggestion endpoints (list/accept/dismiss).

Repos are monkeypatched — no DB state; auth uses the dev-mode bypass like the
other API suites. See plan-batch-B.md.
"""

import pytest
from fastapi.testclient import TestClient

from backend.db import auth_repo, cluster_repo


def _groups():
    return [
        {"id": 5, "label": "Fiber Crafts", "source": "suggested", "topic": None,
         "topic_similarity": 0.2, "interest_tier": "recurrent",
         "evidence": {"n_weeks": 3}, "member_count": 2, "page_count": 12,
         "cluster_ids": [11], "cluster_names": ["Crochet"]},
        {"id": 6, "label": "Leetspeak", "source": "suggested", "topic": None,
         "topic_similarity": 0.1, "interest_tier": "casual",
         "evidence": {"n_weeks": 2}, "member_count": 1, "page_count": 3,
         "cluster_ids": [12], "cluster_names": ["Leetspeak Language"]},
        {"id": 7, "label": "Dismissed Thing", "source": "suggested", "topic": None,
         "topic_similarity": 0.1, "interest_tier": "casual",
         "evidence": {}, "member_count": 1, "page_count": 2,
         "cluster_ids": [13], "cluster_names": ["X"]},
        {"id": 8, "label": "science", "source": "keyword", "topic": "science",
         "topic_similarity": 0.31, "interest_tier": "declared",
         "evidence": {}, "member_count": 11, "page_count": 55,
         "cluster_ids": [14], "cluster_names": ["Volcanology"],
         "split_proposal": [
             {"label": "Weather And Volcanology", "cluster_db_ids": [14],
              "n_clusters": 3, "n_pages": 23}]},
    ]


@pytest.fixture
def client(monkeypatch):
    from backend.api.main import app

    prefs_store = {
        "topic_interests": [],
        "dismissed_topics": [{"label": "dismissed thing", "dismissed_at": "2026-07-01"}],
    }
    monkeypatch.setattr(auth_repo, "get_preferences", lambda uid: dict(prefs_store))
    monkeypatch.setattr(
        auth_repo, "update_preferences",
        lambda uid, p: prefs_store.update(p),
    )
    monkeypatch.setattr(
        cluster_repo, "get_groups_for_user",
        lambda uid, recluster_run_id=None, source=None: [
            g for g in _groups() if source is None or g["source"] == source
        ],
    )
    return TestClient(app), prefs_store


def test_list_suggestions_filters_dismissed_and_ranks(client):
    c, _ = client
    resp = c.get("/api/topics/suggestions")
    assert resp.status_code == 200
    body = resp.json()
    labels = [s["label"] for s in body["suggestions"]]
    assert labels == ["Fiber Crafts", "Leetspeak"]  # recurrent first, dismissed gone
    # C2: declared umbrellas with split proposals ride along, not mixed in
    assert [s["topic"] for s in body["splits"]] == ["science"]


def test_accept_suggestion_defaults_to_label(client, monkeypatch):
    c, prefs = client
    import backend.services.super_cluster_service as scs

    async def fake_icon(kw):
        return "yarn"

    monkeypatch.setattr(scs, "select_icon_for_topic", fake_icon)
    relabels = {}
    monkeypatch.setattr(
        cluster_repo, "update_group_acceptance",
        lambda uid, gid, kw: relabels.update(gid=gid, kw=kw) or [11, 12],
    )

    resp = c.post("/api/topics/suggestions/5/accept", json={})
    assert resp.status_code == 200
    body = resp.json()
    assert body["topic"]["keyword"] == "Fiber Crafts"
    assert body["relabeled_clusters"] == 2
    assert relabels == {"gid": 5, "kw": "Fiber Crafts"}
    assert any(t["keyword"] == "Fiber Crafts" for t in prefs["topic_interests"])


def test_accept_unknown_group_404(client):
    c, _ = client
    assert c.post("/api/topics/suggestions/999/accept", json={}).status_code == 404


def test_dismiss_suggestion_records_label(client):
    c, prefs = client
    resp = c.post("/api/topics/suggestions/6/dismiss")
    assert resp.status_code == 200
    labels = [d["label"] for d in prefs["dismissed_topics"]]
    assert "Leetspeak" in labels
