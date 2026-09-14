"""Unit tests for batch B 4a: cluster identity persistence (greedy Jaccard
matching + stable_id/name carry-forward). See the 2026-07-08
clustering-supercluster-rethink plan (private), plan-batch-B.md.
"""

import numpy as np
import pytest

from backend.config.settings import settings
from backend.services import clustering_service as cs
from backend.services.clustering_service import ClusteringService


def _pages(content_ids):
    return [{"db_id": 100 + i, "page_content_id": c} for i, c in enumerate(content_ids)]


def _prev(clusters):
    """[{id, name, stable_id, content_ids}] shorthand."""
    return [
        {"id": cid, "cluster_name": name, "stable_id": sid, "content_ids": set(ids)}
        for cid, name, sid, ids in clusters
    ]


def test_greedy_matching_threshold_and_one_to_one(monkeypatch):
    monkeypatch.setattr(settings, "cluster_identity_jaccard", 0.5)
    # new cluster 0 = contents {1,2,3}; cluster 1 = {4,5}; cluster 2 = {9}
    labels = np.array([0, 0, 0, 1, 1, 2])
    pages = _pages([1, 2, 3, 4, 5, 9])
    prev = _prev([
        (11, "Volcanoes", "sid-vol", [1, 2, 3, 6]),      # jac 3/4 vs cluster 0
        (12, "Also Volcanoes", "sid-vol2", [1, 2]),      # jac 2/3 vs cluster 0 (loses greedy)
        (13, "Knitting", "sid-knit", [4, 5]),            # jac 1.0 vs cluster 1
        (14, "Unrelated", "sid-x", [7, 8]),              # no overlap
    ])
    monkeypatch.setattr(
        cs.cluster_repo, "get_previous_run_membership", lambda uid: prev
    )
    svc = ClusteringService(user_id=1)
    m = svc._match_clusters_to_previous(1, [0, 1, 2], labels, pages)

    assert m[0]["stable_id"] == "sid-vol" and m[0]["name"] == "Volcanoes"
    assert m[1]["stable_id"] == "sid-knit"
    assert 2 not in m  # {9} matches nothing
    # one-to-one: sid-vol2 not assigned anywhere despite qualifying overlap
    assert all(v["stable_id"] != "sid-vol2" for v in m.values())


def test_no_previous_run_returns_empty(monkeypatch):
    monkeypatch.setattr(
        cs.cluster_repo, "get_previous_run_membership", lambda uid: []
    )
    svc = ClusteringService(user_id=1)
    assert svc._match_clusters_to_previous(1, [0], np.array([0]), _pages([1])) == {}


def test_null_previous_stable_id_gets_minted(monkeypatch):
    monkeypatch.setattr(settings, "cluster_identity_jaccard", 0.5)
    prev = _prev([(11, "Legacy Row", None, [1, 2])])
    monkeypatch.setattr(
        cs.cluster_repo, "get_previous_run_membership", lambda uid: prev
    )
    svc = ClusteringService(user_id=1)
    m = svc._match_clusters_to_previous(1, [0], np.array([0, 0]), _pages([1, 2]))
    assert m[0]["name"] == "Legacy Row"
    assert m[0]["stable_id"]  # minted uuid, bootstraps identity from legacy rows


def test_write_clusters_stable_id_plumbing(monkeypatch):
    captured = {}

    def fake_save_clusters(user_id, run_id, cluster_dicts):
        captured["dicts"] = cluster_dicts
        return {c["cluster_slug"]: i + 1 for i, c in enumerate(cluster_dicts)}

    monkeypatch.setattr(cs.cluster_repo, "save_clusters", fake_save_clusters)
    monkeypatch.setattr(cs.cluster_repo, "save_page_clusters", lambda pairs: None)
    monkeypatch.setattr(cs.cluster_repo, "save_edges", lambda run, edges: None)

    labels = np.array([0, 0, 1, 1])
    pages = _pages([1, 2, 3, 4])
    emb = np.eye(4, 8)
    names = {0: "Carried Name", 1: "Fresh Name"}
    svc = ClusteringService(user_id=1)

    # identity ON: matched cluster carries, unmatched mints
    monkeypatch.setattr(settings, "cluster_identity_enabled", True)
    svc._write_clusters_to_db(
        1, 99, labels.copy(), names, pages, emb,
        identity_matches={0: {"stable_id": "sid-carried", "name": "Carried Name",
                              "jaccard": 1.0}},
    )
    by_name = {c["cluster_name"]: c for c in captured["dicts"]}
    assert by_name["Carried Name"]["stable_id"] == "sid-carried"
    assert by_name["Carried Name"]["name_carried"] is True
    assert by_name["Fresh Name"]["stable_id"] and \
        by_name["Fresh Name"]["stable_id"] != "sid-carried"
    assert by_name["Fresh Name"]["name_carried"] is False

    # identity OFF: legacy NULL columns
    monkeypatch.setattr(settings, "cluster_identity_enabled", False)
    svc._write_clusters_to_db(1, 99, labels.copy(), names, pages, emb)
    assert all(c["stable_id"] is None and c["name_carried"] is False
               for c in captured["dicts"])
