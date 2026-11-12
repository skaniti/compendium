"""API tests for batch B 4d: topic-suggestion endpoints (list/accept/dismiss).

Repos are monkeypatched — no DB state; auth uses the dev-mode bypass like the
other API suites. See plan-batch-B.md.
"""

import pytest
from fastapi.testclient import TestClient

from backend.db import auth_repo, cluster_repo


@pytest.fixture(autouse=True)
def _groups_source(monkeypatch):
    """These tests cover the embedding-groups candidate source; the default
    source is "proposed" (see test_topic_proposals.py)."""
    from backend.config.settings import settings

    monkeypatch.setattr(settings, "supercluster_suggestion_source", "groups")


def _groups():
    return [
        {"id": 5, "label": "Fiber Crafts", "source": "suggested", "topic": None,
         "topic_similarity": 0.2, "interest_tier": "recurrent",
         "evidence": {"n_weeks": 3}, "member_count": 2, "page_count": 20,
         "cluster_ids": [11], "cluster_names": ["Crochet"]},
        {"id": 6, "label": "Leetspeak", "source": "suggested", "topic": None,
         "topic_similarity": 0.1, "interest_tier": "casual",
         "evidence": {"n_weeks": 2}, "member_count": 2, "page_count": 16,
         "cluster_ids": [12], "cluster_names": ["Leetspeak Language"]},
        {"id": 7, "label": "Dismissed Thing", "source": "suggested", "topic": None,
         "topic_similarity": 0.1, "interest_tier": "casual",
         "evidence": {}, "member_count": 2, "page_count": 30,
         "cluster_ids": [13], "cluster_names": ["X"]},
        {"id": 9, "label": "Racing Game Guides", "source": "suggested", "topic": None,
         "topic_similarity": 0.1, "interest_tier": "recurrent",
         "evidence": {}, "member_count": 1, "page_count": 40,
         "cluster_ids": [15], "cluster_names": ["Kart Tips"]},
        {"id": 10, "label": "Assorted Topics", "source": "suggested", "topic": None,
         "topic_similarity": 0.1, "interest_tier": "recurrent",
         "evidence": {"no_single_field": True}, "member_count": 6, "page_count": 80,
         "cluster_ids": [16], "cluster_names": ["Mixed"]},
        {"id": 11, "label": "Machine Learning Models", "source": "suggested",
         "topic": None, "topic_similarity": 0.1, "interest_tier": "recurrent",
         "evidence": {"covered_by": "machine learning"}, "member_count": 4,
         "page_count": 50, "cluster_ids": [17], "cluster_names": ["Nets"]},
        {"id": 12, "label": "Games", "source": "taxonomy", "topic": "games",
         "topic_similarity": None, "interest_tier": "casual",
         "evidence": {}, "member_count": 3, "page_count": 44,
         "cluster_ids": [18], "cluster_names": ["Board Games"]},
        {"id": 13, "label": "Science", "source": "taxonomy", "topic": "science",
         "topic_similarity": 1.0, "interest_tier": "declared",
         "evidence": {}, "member_count": 5, "page_count": 90,
         "cluster_ids": [19], "cluster_names": ["Physics"]},
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
        lambda uid, recluster_run_id=None, source=None, include_proposed=False: [
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
    # recurrent first; dismissed, one-cluster, "no single field", covered and
    # (flag off) taxonomy groups are not offered
    assert labels == ["Fiber Crafts", "Leetspeak"]
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


def test_list_suggestions_offers_undeclared_taxonomy_in_label_first(client, monkeypatch):
    from backend.config.settings import settings

    c, _ = client
    monkeypatch.setattr(settings, "label_first_enabled", True)
    labels = [s["label"] for s in c.get("/api/topics/suggestions").json()["suggestions"]]
    # declared taxonomy group ("Science", topic_similarity 1.0) stays out
    assert labels == ["Fiber Crafts", "Games", "Leetspeak"]  # casual tier: by pages


def test_accept_taxonomy_group_adds_keyword_and_relabels(client, monkeypatch):
    from backend.config.settings import settings

    c, prefs = client
    import backend.services.super_cluster_service as scs

    monkeypatch.setattr(settings, "label_first_enabled", True)

    async def fake_icon(kw):
        return "controller"

    monkeypatch.setattr(scs, "select_icon_for_topic", fake_icon)
    relabels = {}
    monkeypatch.setattr(
        cluster_repo, "update_group_acceptance",
        lambda uid, gid, kw: relabels.update(gid=gid, kw=kw) or [18],
    )

    resp = c.post("/api/topics/suggestions/12/accept", json={})
    assert resp.status_code == 200
    assert resp.json()["topic"]["keyword"] == "Games"  # defaults to the category label
    assert relabels == {"gid": 12, "kw": "Games"}
    assert any(t["keyword"] == "Games" for t in prefs["topic_interests"])

    # the category id rides on the new entry, so a renamed keyword still declares it
    assert [t for t in prefs["topic_interests"] if t["keyword"] == "Games"][0]["category"] == "games"
    prefs["topic_interests"].clear()
    resp = c.post("/api/topics/suggestions/12/accept", json={"keyword": "board games"})
    assert resp.json()["topic"]["keyword"] == "board games"
    assert prefs["topic_interests"][0]["category"] == "games"


def test_dismiss_taxonomy_group_hides_it(client, monkeypatch):
    from backend.config.settings import settings

    c, prefs = client
    monkeypatch.setattr(settings, "label_first_enabled", True)
    assert c.post("/api/topics/suggestions/12/dismiss").status_code == 200
    assert "Games" in [d["label"] for d in prefs["dismissed_topics"]]
    labels = [s["label"] for s in c.get("/api/topics/suggestions").json()["suggestions"]]
    assert "Games" not in labels


def _proposed_group(**over):
    g = {"id": 20, "label": "Birdwatching", "source": "proposed", "topic": None,
         "topic_similarity": None, "interest_tier": "recurrent",
         "evidence": {"cluster_db_ids": [31, 32]}, "member_count": 2, "page_count": 25,
         "cluster_ids": [31, 32], "cluster_names": ["Owls", "Finches"],
         "cluster_slugs": ["owls", "finches"], "split_proposal": None}
    g.update(over)
    return g


@pytest.fixture
def proposed_client(client, monkeypatch):
    from backend.config.settings import settings

    c, prefs = client
    monkeypatch.setattr(settings, "supercluster_suggestion_source", "proposed")
    groups = [_proposed_group(), _proposed_group(id=21, label="Tiny", member_count=1, page_count=40)]
    monkeypatch.setattr(
        cluster_repo, "get_groups_for_user",
        lambda uid, recluster_run_id=None, source=None, include_proposed=False:
            (groups if include_proposed else []),
    )
    return c, prefs


def test_list_returns_proposed_rows_in_the_same_shape(proposed_client):
    c, _ = proposed_client
    body = c.get("/api/topics/suggestions").json()
    assert [s["label"] for s in body["suggestions"]] == ["Birdwatching"]
    s = body["suggestions"][0]
    for key in ("id", "label", "source", "topic", "topic_similarity", "interest_tier", "evidence",
                "member_count", "page_count", "cluster_ids", "cluster_names", "split_proposal",
                "cluster_slugs"):
        assert key in s
    assert s["cluster_names"] == ["Owls", "Finches"] and s["cluster_slugs"] == ["owls", "finches"]


def test_accept_proposed_row_relabels_its_members_and_adds_keyword(proposed_client, monkeypatch):
    c, prefs = proposed_client
    import backend.services.super_cluster_service as scs

    async def fake_icon(kw):
        return "bird"

    monkeypatch.setattr(scs, "select_icon_for_topic", fake_icon)
    calls = {}
    monkeypatch.setattr(
        cluster_repo, "update_proposed_acceptance",
        lambda uid, gid, kw, ids: calls.update(gid=gid, kw=kw, ids=ids) or list(ids),
    )
    monkeypatch.setattr(
        cluster_repo, "update_group_acceptance",
        lambda *a: pytest.fail("a proposed row must not use the group path"),
    )
    body = c.post("/api/topics/suggestions/20/accept", json={}).json()
    assert body["topic"]["keyword"] == "Birdwatching" and body["relabeled_clusters"] == 2
    assert calls == {"gid": 20, "kw": "Birdwatching", "ids": [31, 32]}
    assert any(t["keyword"] == "Birdwatching" and t["icon_id"] == "bird" for t in prefs["topic_interests"])

    prefs["topic_interests"].clear()
    body = c.post("/api/topics/suggestions/20/accept", json={"keyword": "birds"}).json()
    assert body["topic"]["keyword"] == "birds"


def test_dismiss_proposed_row_records_label_and_hides_it(proposed_client):
    c, prefs = proposed_client
    assert c.post("/api/topics/suggestions/20/dismiss").status_code == 200
    assert "Birdwatching" in [d["label"] for d in prefs["dismissed_topics"]]
    assert c.get("/api/topics/suggestions").json()["suggestions"] == []


# --- not-offered rows, case variants, second accepts -------------------------

def test_accept_a_row_that_is_not_offered_is_409_with_the_reason(client):
    c, _ = client
    for gid, reason in ((6 + 0, None), (9, "fewer than 2 clusters"), (10, "no single field"),
                        (11, "covered by machine learning"), (8, "not a suggestion")):
        if reason is None:
            continue
        resp = c.post(f"/api/topics/suggestions/{gid}/accept", json={})
        assert resp.status_code == 409, gid
        assert reason in resp.json()["detail"]
        assert "no longer available" in resp.json()["detail"]


def test_second_accept_is_409(client, monkeypatch):
    c, prefs = client
    import backend.services.super_cluster_service as scs

    async def fake_icon(kw):
        return "yarn"

    monkeypatch.setattr(scs, "select_icon_for_topic", fake_icon)
    monkeypatch.setattr(cluster_repo, "update_group_acceptance", lambda uid, gid, kw: [11])
    assert c.post("/api/topics/suggestions/5/accept", json={}).status_code == 200
    again = c.post("/api/topics/suggestions/5/accept", json={})
    assert again.status_code == 409 and "covered by Fiber Crafts" in again.json()["detail"]
    assert len(prefs["topic_interests"]) == 1


def test_accept_under_a_case_variant_uses_the_existing_spelling_and_adds_nothing(client, monkeypatch):
    c, prefs = client
    prefs["topic_interests"].append({"keyword": "Textile Arts", "icon_id": "loom"})
    seen = {}
    monkeypatch.setattr(
        cluster_repo, "update_group_acceptance",
        lambda uid, gid, kw: seen.update(kw=kw) or [11],
    )
    resp = c.post("/api/topics/suggestions/5/accept", json={"keyword": "textile ARTS"})
    assert resp.status_code == 200
    assert resp.json()["topic"]["keyword"] == "Textile Arts"
    assert seen["kw"] == "Textile Arts"
    assert len(prefs["topic_interests"]) == 1


def test_a_keyword_added_by_hand_hides_the_suggestion_in_the_list(client):
    c, prefs = client
    prefs["topic_interests"].append({"keyword": "fiber crafts", "icon_id": "x"})
    labels = [s["label"] for s in c.get("/api/topics/suggestions").json()["suggestions"]]
    assert "Fiber Crafts" not in labels


def test_dismiss_a_row_that_is_not_offered_is_409_but_an_already_dismissed_one_succeeds(client):
    c, prefs = client
    resp = c.post("/api/topics/suggestions/9/dismiss")  # one cluster: not offered
    assert resp.status_code == 409 and "fewer than 2 clusters" in resp.json()["detail"]
    # group 7 ("Dismissed Thing") is already in dismissed_topics
    resp = c.post("/api/topics/suggestions/7/dismiss")
    assert resp.status_code == 200
    assert len(prefs["dismissed_topics"]) == 1  # no duplicate entry
