"""Proposed rows against the real test database: storage, member resolution,
exclusion from the graph payload and from group readers, the status count,
and accept (relabels members, row no longer offered). Synthetic data only."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from tests.test_api_clustering_status import (  # noqa: F401  (fixtures + helpers)
    _clean_tables,
    _make_user,
    _pg_reachable,
    _seed_completed_run,
)

pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.config.settings import settings
from backend.db import auth_repo, cluster_repo
from backend.db.connection import get_conn
from backend.models.graph import KnowledgeGraph
from backend.services import topic_proposals as tp
from backend.utils.graph_export import to_d3_elements


@pytest.fixture
def seeded(monkeypatch):
    """A user with a completed run of 5 clusters x 6 pages and the proposal
    source on; the model proposes one topic over clusters 0-2."""
    monkeypatch.setattr(settings, "label_first_enabled", False)
    monkeypatch.setattr(settings, "supercluster_suggestion_source", "proposed")
    user = _make_user()
    run_id = _seed_completed_run(user["id"], [6, 6, 6, 6, 6])
    clusters = cluster_repo.get_clusters_for_user(user["id"], run_id)
    ids = [c["id"] for c in sorted(clusters, key=lambda c: c["cluster_slug"])]

    import backend.services.llm_service as ls

    answer = {"topics": [{"label": "Birdwatching", "cluster_ids": ids[:3]}]}
    llm = SimpleNamespace(complete=None)

    async def complete(**kw):
        return SimpleNamespace(content=json.dumps(answer), cost_usd=0.0002)

    llm.complete = complete
    monkeypatch.setattr(ls, "LLMService", lambda: llm)
    return user, run_id, ids


def _payload(user_id):
    return json.dumps(to_d3_elements(KnowledgeGraph(), user_id), sort_keys=True, default=str)


def test_proposals_are_stored_but_invisible_to_group_readers_and_graph(seeded):
    user, run_id, ids = seeded
    before = _payload(user["id"])
    out = asyncio.run(tp.store_proposals_for_run(user["id"], run_id))
    assert out["proposed"] == 1 and out["candidates"] == 5

    # stored with member ids in evidence; owns no clusters
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT source, label, member_count, page_count, evidence "
                    "FROM super_cluster_groups WHERE user_id = %s", (user["id"],))
        (source, label, members, pages, evidence), = cur.fetchall()
        cur.execute("SELECT COUNT(*) FROM clusters WHERE user_id = %s AND group_id IS NOT NULL", (user["id"],))
        assert cur.fetchone()[0] == 0
    assert (source, label, members, pages) == ("proposed", "Birdwatching", 3, 18)
    assert evidence["cluster_db_ids"] == ids[:3]

    # default readers (graph payload, group lists) do not see it
    assert cluster_repo.get_groups_for_user(user["id"]) == []
    assert _payload(user["id"]) == before
    # the explicit reader resolves members from the evidence ids
    (g,) = cluster_repo.get_groups_for_user(user["id"], include_proposed=True)
    assert g["cluster_ids"] == ids[:3] and len(g["cluster_names"]) == 3 and len(g["cluster_slugs"]) == 3
    # the dev Clusters view counts only painted suggested groups
    from backend.db import cluster_view_repo

    assert cluster_view_repo.get_group_counts(user["id"], run_id)["suggested"] == 0
    assert all(c["group"] is None for c in cluster_view_repo.get_clusters(user["id"], run_id))


def test_status_count_and_endpoint_offer_the_proposal(seeded):
    from backend.api.main import app, verify_api_key

    user, run_id, ids = seeded
    asyncio.run(tp.store_proposals_for_run(user["id"], run_id))
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    try:
        tc = TestClient(app)
        assert tc.get("/api/clustering/status").json()["stats_line1"].endswith("· 1 suggested")
        (s,) = tc.get("/api/topics/suggestions").json()["suggestions"]
        assert s["label"] == "Birdwatching" and s["cluster_ids"] == ids[:3]
    finally:
        app.dependency_overrides.pop(verify_api_key, None)


def test_accept_relabels_member_clusters_and_stops_the_offer(seeded, monkeypatch):
    from backend.api.main import app, verify_api_key, verify_not_plain_demo
    import backend.services.super_cluster_service as scs

    user, run_id, ids = seeded
    asyncio.run(tp.store_proposals_for_run(user["id"], run_id))

    async def fake_icon(kw):
        return "bird"

    monkeypatch.setattr(scs, "select_icon_for_topic", fake_icon)
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    app.dependency_overrides[verify_not_plain_demo] = lambda: user["id"]
    try:
        tc = TestClient(app)
        (s,) = tc.get("/api/topics/suggestions").json()["suggestions"]
        body = tc.post(f"/api/topics/suggestions/{s['id']}/accept", json={"keyword": "birds"}).json()
        assert body["relabeled_clusters"] == 3
        sc = cluster_repo.get_super_cluster_map(user["id"], run_id)
        labelled = [slug for slug, v in sc.items() if v == "birds"]
        assert len(labelled) == 3
        assert tc.get("/api/topics/suggestions").json()["suggestions"] == []
        assert tc.get("/api/clustering/status").json()["stats_line1"].count("suggested") == 0
        # the row stays 'proposed' (owns no clusters) and records the keyword
        (g,) = cluster_repo.get_groups_for_user(user["id"], include_proposed=True)
        assert g["source"] == "proposed" and g["evidence"]["accepted_as"] == "birds"
        assert cluster_repo.get_groups_for_user(user["id"]) == []
    finally:
        app.dependency_overrides.pop(verify_api_key, None)
        app.dependency_overrides.pop(verify_not_plain_demo, None)


def test_accepting_a_proposal_whose_members_already_belong_to_a_group(seeded, monkeypatch):
    """Hybrid mode: the member clusters sit in a suggested group (group_id set).
    Accept relabels them but leaves group_id for the next recluster."""
    from backend.api.main import app, verify_api_key, verify_not_plain_demo
    import backend.services.super_cluster_service as scs

    user, run_id, ids = seeded
    (old_group,) = cluster_repo.save_super_cluster_groups(
        user["id"], run_id,
        [{"group_index": 0, "label": "Old Group", "source": "suggested",
          "interest_tier": "casual", "member_count": 3, "page_count": 18}],
    ).values()
    cluster_repo.update_cluster_groups(user["id"], {i: old_group for i in ids[:3]})
    cluster_repo.update_super_clusters(user["id"], {i: "Old Group" for i in ids[:3]})
    asyncio.run(tp.store_proposals_for_run(user["id"], run_id))

    async def fake_icon(kw):
        return "bird"

    monkeypatch.setattr(scs, "select_icon_for_topic", fake_icon)
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    app.dependency_overrides[verify_not_plain_demo] = lambda: user["id"]
    try:
        tc = TestClient(app)
        (s,) = tc.get("/api/topics/suggestions").json()["suggestions"]
        assert s["source"] == "proposed"
        assert tc.post(f"/api/topics/suggestions/{s['id']}/accept", json={}).status_code == 200
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT DISTINCT group_id, super_cluster FROM clusters "
                        "WHERE user_id = %s AND id = ANY(%s)", (user["id"], ids[:3]))
            assert cur.fetchall() == [(old_group, "Birdwatching")]
        # a second accept is refused, and the keyword was added once
        again = tc.post(f"/api/topics/suggestions/{s['id']}/accept", json={})
        assert again.status_code == 409
        assert [t["keyword"] for t in auth_repo.get_preferences(user["id"])["topic_interests"]] == ["Birdwatching"]
    finally:
        app.dependency_overrides.pop(verify_api_key, None)
        app.dependency_overrides.pop(verify_not_plain_demo, None)
