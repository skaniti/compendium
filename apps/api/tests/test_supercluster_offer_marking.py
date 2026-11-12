"""Hybrid recluster marks suggested groups the owner should not be offered:
`no_single_field` (the v2 labeller answered null) and `covered_by` (the label
near-duplicates an existing supercluster). Marks live in the group's evidence
JSON; the group itself stays on the graph. Synthetic data only."""

import asyncio

import numpy as np

from backend.config.settings import settings
from backend.services import super_cluster_service as scs
from backend.services import supercluster_discovery as sd


def _unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def _run(monkeypatch, suggest, keywords=("Machine Learning",)):
    """Two orthogonal one-cluster groups, a keyword aligned with neither."""
    labels = np.array([0, 0, 1, 1])
    emb = np.vstack([
        _unit([1, 0.1, 0, 0]), _unit([1, -0.1, 0, 0]),
        _unit([0, 0, 1, 0.1]), _unit([0, 0, 1, -0.1]),
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(4)]
    names = {0: "Kite Making Basics", 1: "Tide Tables"}
    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.5)
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": k} for k in keywords]},
    )
    monkeypatch.setattr(
        sd, "embed_keywords",
        lambda kws, user_id=None, harness=False: np.vstack(
            [_unit([0, 1, 0, 0])] * len(kws)
        ),
    )
    monkeypatch.setattr("backend.db.page_repo.get_visit_history", lambda uid, pids: {})

    async def no_expansion(kws):
        return {}, 0.0

    async def approve(matched, members_by_group, names_):
        return set(), 0.0

    monkeypatch.setattr(scs, "_expand_keywords", no_expansion)
    monkeypatch.setattr(scs, "_verify_topic_matches", approve)
    monkeypatch.setattr(scs, "_suggest_group_labels", suggest)

    saved = {}
    monkeypatch.setattr(
        scs.cluster_repo, "save_super_cluster_groups",
        lambda uid, rid, groups: (
            saved.update(groups=groups) or {g["group_index"]: 900 + g["group_index"] for g in groups}
        ),
    )
    monkeypatch.setattr(scs.cluster_repo, "update_super_clusters", lambda uid, a: saved.update(labels=a))
    monkeypatch.setattr(scs.cluster_repo, "update_cluster_groups", lambda uid, a: saved.update(fks=a))
    asyncio.run(
        scs.assign_super_clusters_hybrid(1, 77, labels, names, pages, emb,
                                         {"kite_making_basics": 31, "tide_tables": 32})
    )
    return saved


def _by_cluster(saved, db_cluster_id):
    return next(
        g for g in saved["groups"]
        if 900 + g["group_index"] == saved["fks"][db_cluster_id]
    )


def test_null_label_uses_fallback_and_marks_no_single_field(monkeypatch):
    async def suggest(unlabeled, members_by_group, names, sibling_labels=None, **_):
        # first group -> null, second group -> a named field
        return {
            g["group_index"]: (None if 0 in members_by_group[g["group_index"]] else "Energy")
            for g in unlabeled
        }, 0.0

    saved = _run(monkeypatch, suggest)
    grab_bag = _by_cluster(saved, 31)
    assert grab_bag["label"] == "Kite Making Basics"  # fallback: biggest member cluster's name
    assert grab_bag["evidence"]["no_single_field"] is True
    assert "covered_by" not in grab_bag["evidence"]
    assert saved["labels"][31] == "Kite Making Basics"  # still painted on the graph
    named = _by_cluster(saved, 32)
    assert named["label"] == "Energy" and "no_single_field" not in named["evidence"]


def test_missing_label_is_a_fallback_but_not_no_single_field(monkeypatch):
    async def suggest(unlabeled, members_by_group, names, sibling_labels=None, **_):
        return {}, 0.0  # model failed or skipped the groups

    saved = _run(monkeypatch, suggest)
    for cid in (31, 32):
        assert "no_single_field" not in _by_cluster(saved, cid)["evidence"]


def test_label_covered_by_existing_supercluster_is_marked(monkeypatch):
    async def suggest(unlabeled, members_by_group, names, sibling_labels=None, **_):
        return {g["group_index"]: "Applied Machine Learning" for g in unlabeled}, 0.0

    saved = _run(monkeypatch, suggest)
    for cid in (31, 32):
        assert _by_cluster(saved, cid)["evidence"]["covered_by"] == "Machine Learning"


def test_labeller_receives_owner_topics_and_cluster_page_counts(monkeypatch):
    seen = {}

    async def suggest(unlabeled, members_by_group, names, sibling_labels=None,
                      existing_topics=None, cluster_page_counts=None):
        seen.update(topics=existing_topics, counts=cluster_page_counts)
        return {}, 0.0

    _run(monkeypatch, suggest, keywords=("Machine Learning", "zoology"))
    assert seen["topics"] == ["Machine Learning", "zoology"]
    assert seen["counts"] == {0: 2, 1: 2}


def test_singleton_collapse_keeps_the_target_groups_offer_marks():
    labels = np.array([0, 0, 1, 2])
    cents = np.vstack([_unit([1, 0, 0]), _unit([1, 0.05, 0]), _unit([1, 0.02, 0])])
    pages = [{"db_id": 1}, {"db_id": 2}, {"db_id": 3}, {"db_id": 4}]
    groups = [
        {"group_index": 0, "label": "Grab Bag", "topic": None, "source": "suggested",
         "member_count": 2, "page_count": 3, "interest_tier": "casual",
         "evidence": {"no_single_field": True, "covered_by": "x"}},
        {"group_index": 1, "label": "Lone", "topic": None, "source": "suggested",
         "member_count": 1, "page_count": 1, "interest_tier": "casual", "evidence": {}},
    ]
    members = {0: [0, 1], 1: [2]}
    out, _ = scs._collapse_singleton_groups(
        groups, members, [0, 1, 2], cents, labels, pages, {}, threshold=0.5,
    )
    assert [g["group_index"] for g in out] == [0]
    assert out[0]["member_count"] == 3
    assert out[0]["evidence"]["no_single_field"] is True
    assert out[0]["evidence"]["covered_by"] == "x"
