"""Unit tests for the singleton-collapse pass (clustering-quality backlog
group, item 3): ``super_cluster_service._collapse_singleton_groups`` and its
wiring into ``assign_super_clusters_hybrid`` via
``settings.supercluster_singleton_merge_threshold``.
"""

import asyncio

import numpy as np
import pytest

from backend.config.settings import settings
from backend.services import super_cluster_service as scs
from backend.services import supercluster_discovery as sd


def _unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def _group(group_index, member_cids, *, source="suggested", topic=None,
           label="Label", member_count=None, page_count=0):
    return {
        "group_index": group_index,
        "topic": topic,
        "topic_similarity": 0.0,
        "interest_tier": "casual",
        "evidence": {},
        "member_count": member_count if member_count is not None else len(member_cids),
        "page_count": page_count,
        "source": source,
        "label": label,
        "split_proposal": None,
    }


def _fixture(near_vec, threshold, *, third_source="suggested"):
    """One multi-member group [10, 20] centered on [1,0,0], one singleton
    group [30] at ``near_vec`` (must be a unit-ish direction; the helper
    re-normalizes). 5 pages: 2 for cluster 10, 2 for cluster 20, 1 for 30."""
    cluster_ids = [10, 20, 30]
    cents = np.vstack([_unit([1, 0, 0]), _unit([1, 0, 0]), _unit(near_vec)])
    groups = [
        _group(0, [10, 20], source="keyword", topic="widgets", label="widgets",
               page_count=4),
        _group(1, [30], source=third_source, topic=None, label="Loner",
               page_count=1),
    ]
    members_by_group = {0: [10, 20], 1: [30]}
    labels = np.array([10, 10, 20, 20, 30])
    pages = [{"db_id": i} for i in range(5)]
    history = {}
    result = scs._collapse_singleton_groups(
        groups, members_by_group, cluster_ids, cents, labels, pages, history,
        threshold=threshold,
    )
    return result


def test_merge_happens_under_threshold():
    # near_vec ~2.6 degrees off [1,0,0] -> cosine distance ~0.001
    groups, members_by_group = _fixture([0.999, 0.045, 0], threshold=0.05)

    assert len(groups) == 1
    survivor = groups[0]
    assert survivor["group_index"] == 0
    assert 1 not in members_by_group
    assert sorted(members_by_group[0]) == [10, 20, 30]
    # absorber keeps its own identity
    assert survivor["source"] == "keyword"
    assert survivor["topic"] == "widgets"
    assert survivor["label"] == "widgets"
    # counts recomputed through _evidence_for, not ad-hoc arithmetic
    assert survivor["member_count"] == 3
    assert survivor["page_count"] == 5


def test_no_merge_over_threshold():
    # near_vec orthogonal to [1,0,0] -> cosine distance 1.0, way over 0.05
    groups, members_by_group = _fixture([0, 1, 0], threshold=0.05)

    assert len(groups) == 2
    assert members_by_group[1] == [30]
    loner = next(g for g in groups if g["group_index"] == 1)
    assert loner["member_count"] == 1
    assert loner["label"] == "Loner"
    # untouched target too
    donor = next(g for g in groups if g["group_index"] == 0)
    assert donor["member_count"] == 2
    assert donor["page_count"] == 4


def test_threshold_zero_disables_pass():
    # Same near-identical vectors as the merge test, but threshold 0 -> no-op
    groups, members_by_group = _fixture([0.999, 0.045, 0], threshold=0.0)

    assert len(groups) == 2
    assert members_by_group == {0: [10, 20], 1: [30]}
    loner = next(g for g in groups if g["group_index"] == 1)
    assert loner["member_count"] == 1


def test_dismissed_singleton_never_merges_as_source():
    groups, members_by_group = _fixture(
        [0.999, 0.045, 0], threshold=0.05, third_source="dismissed",
    )

    assert len(groups) == 2
    assert members_by_group[1] == [30]
    dismissed = next(g for g in groups if g["group_index"] == 1)
    assert dismissed["source"] == "dismissed"
    assert dismissed["member_count"] == 1


def test_dismissed_group_never_merges_as_target():
    """A dismissed multi-member group sits closest to the singleton, but
    must be skipped; a farther-but-eligible multi-member group absorbs it
    instead. Also proves 'never write NULL': the singleton lands on a real
    group, never orphaned."""
    cluster_ids = [10, 20, 30, 40, 41]
    cents = np.vstack([
        _unit([1, 0, 0]),      # 10: dismissed donor family
        _unit([1, 0, 0]),      # 20: dismissed donor family
        _unit([0.99, 0.14, 0]),  # 30: the singleton — very close to 10/20
        _unit([0.8, 0.6, 0]),  # 40: eligible donor family (farther, still <= threshold)
        _unit([0.8, 0.6, 0]),  # 41: eligible donor family
    ])
    groups = [
        _group(0, [10, 20], source="dismissed", topic="ghost", label="ghost"),
        _group(2, [40, 41], source="suggested", topic=None, label="Real Group"),
        _group(1, [30], source="suggested", topic=None, label="Loner"),
    ]
    members_by_group = {0: [10, 20], 2: [40, 41], 1: [30]}
    labels = np.array([10, 20, 30, 40, 41])
    pages = [{"db_id": i} for i in range(5)]

    groups, members_by_group = scs._collapse_singleton_groups(
        groups, members_by_group, cluster_ids, cents, labels, pages, {},
        threshold=0.5,
    )

    assert 1 not in members_by_group
    assert 0 in members_by_group and members_by_group[0] == [10, 20]  # untouched
    assert sorted(members_by_group[2]) == [30, 40, 41]
    real_group = next(g for g in groups if g["group_index"] == 2)
    assert real_group["member_count"] == 3
    assert real_group["label"] == "Real Group"


def test_no_eligible_target_leaves_singletons_untouched():
    """All groups are singletons (or empty) -- legal per discover_groups'
    own docstring; the pass must be a no-op, not a crash."""
    cluster_ids = [10, 20]
    cents = np.vstack([_unit([1, 0, 0]), _unit([1, 0, 0.001])])
    groups = [
        _group(0, [10], source="suggested", label="A"),
        _group(1, [20], source="suggested", label="B"),
    ]
    members_by_group = {0: [10], 1: [20]}
    labels = np.array([10, 20])
    pages = [{"db_id": 0}, {"db_id": 1}]

    out_groups, out_members = scs._collapse_singleton_groups(
        groups, members_by_group, cluster_ids, cents, labels, pages, {},
        threshold=0.9,
    )
    assert len(out_groups) == 2
    assert out_members == {0: [10], 1: [20]}


# ── review fix 1: user member-exclusions block re-fold (2026-08-14) ─────


def test_exclusion_blocks_singleton_rejoining_excluding_group():
    """A user-excluded (keyword, cluster) member peeled off into a
    residual singleton must not fold back into the keyword group that
    excluded it, even though it's the geometrically NEAREST, under-
    threshold target -- but it MAY still merge into a different, farther,
    non-excluded eligible target."""
    cluster_ids = [10, 20, 30, 40, 41]
    cents = np.vstack([
        _unit([1, 0, 0]),        # 10/20: excluding donor family ('kwA')
        _unit([1, 0, 0]),
        _unit([0.99, 0.14, 0]),  # 30: the excluded singleton -- nearest to 10/20
        _unit([0.8, 0.6, 0]),    # 40/41: a different eligible target, farther but in-range
        _unit([0.8, 0.6, 0]),
    ])
    groups = [
        _group(0, [10, 20], source="keyword", topic="kwA", label="kwA"),
        _group(2, [40, 41], source="suggested", topic=None, label="Real Group"),
        _group(1, [30], source="suggested", topic=None, label="Misc"),
    ]
    members_by_group = {0: [10, 20], 2: [40, 41], 1: [30]}
    labels = np.array([10, 20, 30, 40, 41])
    pages = [{"db_id": i} for i in range(5)]
    cluster_names = {10: "A", 20: "B", 30: "Ethics Essays", 40: "C", 41: "D"}
    exclusions = {("kwa", "ethics_essays")}

    groups, members_by_group = scs._collapse_singleton_groups(
        groups, members_by_group, cluster_ids, cents, labels, pages, {},
        threshold=0.5,
        exclusions=exclusions,
        cluster_names=cluster_names,
    )

    assert 1 not in members_by_group
    assert members_by_group[0] == [10, 20]  # excluding donor untouched
    assert sorted(members_by_group[2]) == [30, 40, 41]  # landed on the OTHER target
    survivor = next(g for g in groups if g["group_index"] == 2)
    assert survivor["member_count"] == 3


def test_exclusion_with_no_other_target_leaves_singleton_untouched():
    """Same excluding-donor shape but with no alternative target in range
    -- the excluded member must stay a singleton, not silently fall back
    to the excluded group for lack of anywhere else to go."""
    cluster_ids = [10, 20, 30]
    cents = np.vstack([_unit([1, 0, 0]), _unit([1, 0, 0]), _unit([0.999, 0.045, 0])])
    groups = [
        _group(0, [10, 20], source="keyword", topic="widgets", label="widgets",
               page_count=4),
        _group(1, [30], source="suggested", topic=None, label="Loner", page_count=1),
    ]
    members_by_group = {0: [10, 20], 1: [30]}
    labels = np.array([10, 10, 20, 20, 30])
    pages = [{"db_id": i} for i in range(5)]
    cluster_names = {10: "A", 20: "B", 30: "Loner Page"}
    exclusions = {("widgets", "loner_page")}

    groups, members_by_group = scs._collapse_singleton_groups(
        groups, members_by_group, cluster_ids, cents, labels, pages, {},
        threshold=0.05,
        exclusions=exclusions,
        cluster_names=cluster_names,
    )

    assert len(groups) == 2
    assert members_by_group[1] == [30]


# ── review fix 2: keyword-source singletons need a same-label target ────


def test_keyword_singleton_merges_into_same_label_target_only():
    """A keyword-source singleton may only merge into a target whose
    label matches its own, even when a different-label target is
    geometrically NEARER and under threshold."""
    cluster_ids = [10, 20, 30, 40, 41]
    cents = np.vstack([
        _unit([1, 0, 0]),        # 10/20: 'technology' family -- NEAREST to 30
        _unit([1, 0, 0]),
        _unit([0.99, 0.14, 0]),  # 30: keyword singleton, label 'Productivity Tools'
        _unit([0.8, 0.6, 0]),    # 40/41: 'Productivity Tools' family -- farther
        _unit([0.8, 0.6, 0]),
    ])
    groups = [
        _group(0, [10, 20], source="keyword", topic="technology", label="technology"),
        _group(2, [40, 41], source="keyword", topic="Productivity Tools",
               label="Productivity Tools"),
        _group(1, [30], source="keyword", topic="Productivity Tools",
               label="Productivity Tools"),
    ]
    members_by_group = {0: [10, 20], 2: [40, 41], 1: [30]}
    labels = np.array([10, 20, 30, 40, 41])
    pages = [{"db_id": i} for i in range(5)]

    groups, members_by_group = scs._collapse_singleton_groups(
        groups, members_by_group, cluster_ids, cents, labels, pages, {},
        threshold=0.5,
    )

    assert 1 not in members_by_group
    assert members_by_group[0] == [10, 20]  # different-label 'technology' untouched
    assert sorted(members_by_group[2]) == [30, 40, 41]
    survivor = next(g for g in groups if g["group_index"] == 2)
    assert survivor["label"] == "Productivity Tools"


def test_keyword_singleton_stays_singleton_when_only_target_has_different_label():
    """The blocked run-171 case: a 'technology' keyword singleton sits
    geometrically close to an unrelated 'Productivity Tools' group but
    must NOT merge into it -- it stays a singleton rather than silently
    undoing its own LLM-verified keyword identity."""
    cluster_ids = [10, 20, 30]
    cents = np.vstack([
        _unit([1, 0, 0]),          # 10/20: 'Productivity Tools' family
        _unit([1, 0, 0]),
        _unit([0.999, 0.045, 0]),  # 30: 'technology' singleton, very close
    ])
    groups = [
        _group(0, [10, 20], source="keyword", topic="Productivity Tools",
               label="Productivity Tools"),
        _group(1, [30], source="keyword", topic="technology", label="technology"),
    ]
    members_by_group = {0: [10, 20], 1: [30]}
    labels = np.array([10, 10, 30])
    pages = [{"db_id": i} for i in range(3)]

    groups, members_by_group = scs._collapse_singleton_groups(
        groups, members_by_group, cluster_ids, cents, labels, pages, {},
        threshold=0.05,
    )

    assert len(groups) == 2
    assert members_by_group[1] == [30]
    loner = next(g for g in groups if g["group_index"] == 1)
    assert loner["label"] == "technology"


def test_suggested_singleton_ignores_label_guard():
    """The same-label guard is specific to keyword-source (carve/verified)
    singletons -- a 'suggested' singleton may merge into any eligible
    target regardless of label, same as before fix 2."""
    groups, members_by_group = _fixture([0.999, 0.045, 0], threshold=0.05)
    assert len(groups) == 1
    survivor = groups[0]
    assert survivor["label"] == "widgets"
    assert sorted(members_by_group[0]) == [10, 20, 30]


# ── review fix 3: support-gate residuals can't re-enter their donor ─────


def test_support_gate_pruned_pair_blocks_singleton_rejoining_donor():
    """A member the support-fraction gate just pruned OUT of a group for
    weak individual support must not immediately fold back into that SAME
    group via geometric proximity, even though it's nearest and under
    threshold -- but remains eligible for a different target."""
    cluster_ids = [10, 20, 30, 40, 41]
    cents = np.vstack([
        _unit([1, 0, 0]),        # 10/20: donor group that pruned 30
        _unit([1, 0, 0]),
        _unit([0.99, 0.14, 0]),  # 30: pruned residual singleton, nearest to donor
        _unit([0.8, 0.6, 0]),    # 40/41: a different eligible target
        _unit([0.8, 0.6, 0]),
    ])
    groups = [
        _group(0, [10, 20], source="keyword", topic="kwA", label="kwA"),
        _group(2, [40, 41], source="suggested", topic=None, label="Real Group"),
        _group(1, [30], source="suggested", topic=None, label="Misc"),
    ]
    members_by_group = {0: [10, 20], 2: [40, 41], 1: [30]}
    labels = np.array([10, 20, 30, 40, 41])
    pages = [{"db_id": i} for i in range(5)]
    blocked_pairs = {(0, 30)}  # donor group 0 pruned cluster 30

    groups, members_by_group = scs._collapse_singleton_groups(
        groups, members_by_group, cluster_ids, cents, labels, pages, {},
        threshold=0.5,
        blocked_pairs=blocked_pairs,
    )

    assert 1 not in members_by_group
    assert members_by_group[0] == [10, 20]  # donor untouched
    assert sorted(members_by_group[2]) == [30, 40, 41]


# ── wiring into assign_super_clusters_hybrid ────────────────────────────


def test_hybrid_pipeline_applies_default_collapse_threshold(monkeypatch):
    """End-to-end: two independently keyword-matched 'widgets' groups (a
    keyword may label multiple groups — see ``map_topics_to_groups``)
    merge via a representative ``supercluster_singleton_merge_threshold``
    (patched here to 0.001 for tight, deterministic geometry — NOT the
    real 0.57 production default), and the absorbed cluster's persisted
    label/group FK point at the SURVIVING group.

    One page per cluster (no within-cluster mean-then-normalize averaging)
    so the inter-cluster distances are exactly the vectors chosen below:
    dist(0,1) ~1.25e-7 (clears the strict discovery threshold), dist(0,2)
    ~2e-4 (clears the looser collapse threshold but NOT discovery's)."""
    labels = np.array([0, 1, 2])
    emb = np.vstack([
        _unit([1, 0, 0, 0]),        # cluster 0
        _unit([1, 0.0005, 0, 0]),   # cluster 1: ~same direction as 0
        _unit([1, 0, 0.02, 0]),     # cluster 2: farther, but still close
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(3)]
    cluster_names = {0: "Widget Basics", 1: "Widget Advanced", 2: "Gadget Trivia"}
    slug_to_db_id = {"widget_basics": 11, "widget_advanced": 12, "gadget_trivia": 13}

    # Strict enough that cluster 2 does NOT join {0,1} at discovery time...
    monkeypatch.setattr(settings, "supercluster_group_threshold", 1e-5)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-9)
    # ...but well within reach of the (looser) singleton-collapse pass.
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.001)

    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "widgets"}]},
    )
    monkeypatch.setattr(
        sd, "embed_keywords",
        lambda kws, user_id=None, harness=False: _unit([1, 0, 0, 0]).reshape(1, -1),
    )
    monkeypatch.setattr(
        "backend.db.page_repo.get_visit_history", lambda uid, pids: {}
    )

    async def _no_expansion(kws):
        return {}, 0.0

    monkeypatch.setattr(scs, "_expand_keywords", _no_expansion)

    saved = {}
    monkeypatch.setattr(
        scs.cluster_repo, "save_super_cluster_groups",
        lambda uid, rid, groups: (
            saved.update(groups={g["group_index"]: g for g in groups})
            or {g["group_index"]: 900 + g["group_index"] for g in groups}
        ),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_super_clusters",
        lambda uid, a: saved.update(labels=a),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_cluster_groups",
        lambda uid, a: saved.update(group_fks=a),
    )

    async def fake_suggest(unlabeled, members_by_group, names, sibling_labels=None):
        return {g["group_index"]: "Gadget Trivia" for g in unlabeled}, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    async def approve_all(matched, members_by_group, names):
        return set(), 0.0

    monkeypatch.setattr(scs, "_verify_topic_matches", approve_all)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 90, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )

    # Discovery + keyword-matching alone would have produced 2 SEPARATE
    # 'widgets' groups: {0,1} and {2} independently clear the match
    # threshold (a keyword may label multiple groups -- cluster 2's group
    # is ALSO source='keyword' pre-collapse, not merely 'suggested'); the
    # collapse pass folds the two same-label groups into one.
    assert summary["groups"] == 1
    assert summary["matched"] == 1 and summary["suggested"] == 0
    survivor = next(iter(saved["groups"].values()))
    assert survivor["topic"] == "widgets" and survivor["source"] == "keyword"
    assert survivor["member_count"] == 3
    # cluster 2's page got the SURVIVOR's label/group FK, never left NULL
    assert saved["labels"][13] == "widgets"
    assert saved["group_fks"][13] == saved["group_fks"][11] == saved["group_fks"][12]


def test_hybrid_pipeline_singleton_survives_when_threshold_zero(monkeypatch):
    """0 disables the pass end-to-end: identical geometry to the test
    above (both clusters 0/1 and cluster 2 independently clear the keyword
    match threshold, mirroring run 171's 864/870 carve-fragment shape —
    two same-topic keyword groups that never geometrically remerged at
    discovery), but with the threshold at 0 they stay two separate
    'widgets' groups with distinct group FKs instead of collapsing to one."""
    labels = np.array([0, 1, 2])
    emb = np.vstack([
        _unit([1, 0, 0, 0]),
        _unit([1, 0.0005, 0, 0]),
        _unit([1, 0, 0.02, 0]),
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(3)]
    cluster_names = {0: "Widget Basics", 1: "Widget Advanced", 2: "Gadget Trivia"}
    slug_to_db_id = {"widget_basics": 11, "widget_advanced": 12, "gadget_trivia": 13}

    monkeypatch.setattr(settings, "supercluster_group_threshold", 1e-5)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-9)
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)

    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "widgets"}]},
    )
    monkeypatch.setattr(
        sd, "embed_keywords",
        lambda kws, user_id=None, harness=False: _unit([1, 0, 0, 0]).reshape(1, -1),
    )
    monkeypatch.setattr(
        "backend.db.page_repo.get_visit_history", lambda uid, pids: {}
    )

    async def _no_expansion(kws):
        return {}, 0.0

    monkeypatch.setattr(scs, "_expand_keywords", _no_expansion)

    saved = {}
    monkeypatch.setattr(
        scs.cluster_repo, "save_super_cluster_groups",
        lambda uid, rid, groups: (
            saved.update(groups={g["group_index"]: g for g in groups})
            or {g["group_index"]: 900 + g["group_index"] for g in groups}
        ),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_super_clusters",
        lambda uid, a: saved.update(labels=a),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_cluster_groups",
        lambda uid, a: saved.update(group_fks=a),
    )

    async def fake_suggest(unlabeled, members_by_group, names, sibling_labels=None):
        return {g["group_index"]: "Gadget Trivia" for g in unlabeled}, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    async def approve_all(matched, members_by_group, names):
        return set(), 0.0

    monkeypatch.setattr(scs, "_verify_topic_matches", approve_all)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 91, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )
    # No collapse -> discovery's own two groups stand, both independently
    # keyword-matched (unlike the merged-to-1/matched=1 result above).
    assert summary["groups"] == 2
    assert summary["matched"] == 2 and summary["suggested"] == 0
    assert saved["labels"][13] == "widgets"
    assert saved["group_fks"][13] != saved["group_fks"][11]


def test_hybrid_pipeline_support_gate_prune_blocked_from_rejoining_donor(monkeypatch):
    """End-to-end version of ``test_support_gate_pruned_pair_blocks_singleton_
    rejoining_donor`` above: that unit test injects ``blocked_pairs``
    directly into ``_collapse_singleton_groups``, so it can't catch a
    regression in the WIRING at the ``assign_super_clusters_hybrid`` call
    site (~line 1135) that actually threads the real support-gate's pruned
    pairs through as ``blocked_pairs``. This test drives the REAL support
    gate (``supercluster_group_support_min=0.75``) with a real, non-zero
    ``supercluster_singleton_merge_threshold`` so collapse actually runs.

    5 clusters, single page each (so cluster centroid == the page's own
    embedding, no averaging noise): A/B/C start in ONE discovered group,
    matched to keyword 'kwA'. A and B individually clear the match
    threshold; C does not (own sim ~0.17 vs threshold 0.30) -- support
    fraction 2/3 < 0.75 prunes C into a 1-member residual group. C's own
    embedding is geometrically close to BOTH its donor's post-prune
    centroid (dist ~0.234, well under the 0.6 collapse threshold -- it
    WOULD rejoin the donor if not blocked) AND a separate, unrelated D/E
    group's centroid (dist ~0.55, also under 0.6) -- proving the block is
    scoped to the specific (donor, C) pair, not a blanket 'C can never
    merge anywhere' guard.
    """
    def rot2(angle_deg, extra=(0.0, 0.0)):
        a = np.radians(angle_deg)
        return _unit([np.cos(a), np.sin(a), extra[0], extra[1]])

    A = rot2(38)          # cluster 0: donor member, passes match threshold
    B = rot2(42)          # cluster 1: donor member, passes match threshold
    C = rot2(80)          # cluster 2: pruned by support gate (own sim ~0.17)
    D = rot2(80, extra=(2.0, 0.0))    # cluster 3: unrelated alt-target member
    E = rot2(80, extra=(2.06, 0.0))   # cluster 4: unrelated alt-target member

    labels = np.array([0, 1, 2, 3, 4])
    emb = np.vstack([A, B, C, D, E])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(5)]
    cluster_names = {
        0: "Widget Alpha", 1: "Widget Beta", 2: "Widget Gamma",
        3: "Real Alpha", 4: "Real Beta",
    }
    slug_to_db_id = {
        "widget_alpha": 11, "widget_beta": 12, "widget_gamma": 13,
        "real_alpha": 14, "real_beta": 15,
    }

    # Discovery: A/B/C merge into one group (avg-link dist to C ~0.234);
    # D/E form a separate group (dist to A/B ~0.32-0.36) at this cut.
    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.35)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    # Keep A/B as one fine subgroup (dist ~0.0024) -- no split proposal noise.
    monkeypatch.setattr(settings, "supercluster_split_threshold", 0.01)
    monkeypatch.setattr(settings, "supercluster_carve_margin", 0.05)
    # Drives the REAL support-fraction gate: 2/3 passing < 0.75 -> prunes C.
    monkeypatch.setattr(settings, "supercluster_group_support_min", 0.75)
    # Looser than both dist(C, donor)~0.234 and dist(C, D/E)~0.55, so BOTH
    # are geometrically eligible candidates -- only blocked_pairs decides.
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.6)

    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "kwA"}]},
    )
    monkeypatch.setattr(
        sd, "embed_keywords",
        lambda kws, user_id=None, harness=False: _unit([1, 0, 0, 0]).reshape(1, -1),
    )
    monkeypatch.setattr(
        "backend.db.page_repo.get_visit_history", lambda uid, pids: {}
    )

    async def _no_expansion(kws):
        return {}, 0.0

    monkeypatch.setattr(scs, "_expand_keywords", _no_expansion)

    saved = {}
    monkeypatch.setattr(
        scs.cluster_repo, "save_super_cluster_groups",
        lambda uid, rid, groups: (
            saved.update(groups={g["group_index"]: g for g in groups})
            or {g["group_index"]: 900 + g["group_index"] for g in groups}
        ),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_super_clusters",
        lambda uid, a: saved.update(labels=a),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_cluster_groups",
        lambda uid, a: saved.update(group_fks=a),
    )

    async def fake_suggest(unlabeled, members_by_group, names, sibling_labels=None):
        # D/E's group is the real alt target; the pruned residual (before
        # collapse) is the other unlabeled group.
        return {
            g["group_index"]: (
                "Real Group"
                if any(cid in (3, 4) for cid in members_by_group[g["group_index"]])
                else "Misc"
            )
            for g in unlabeled
        }, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    async def approve_all(matched, members_by_group, names):
        return set(), 0.0

    monkeypatch.setattr(scs, "_verify_topic_matches", approve_all)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 92, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )

    # Donor keeps exactly its 2 passing members -- C never rejoined it.
    donor = next(g for g in saved["groups"].values() if g["topic"] == "kwA")
    assert donor["member_count"] == 2
    # C (cluster_id 13) was absorbed into the OTHER eligible target instead.
    alt = next(
        g for g in saved["groups"].values()
        if g["source"] == "suggested" and g["label"] == "Real Group"
    )
    assert alt["member_count"] == 3
    assert summary["groups"] == 2  # donor + (D,E,C) -- no leftover singleton
    assert saved["labels"][11] == "kwA" and saved["labels"][12] == "kwA"
    assert saved["labels"][13] == "Real Group"  # pruned member painted honestly
    assert saved["group_fks"][13] == saved["group_fks"][14] == saved["group_fks"][15]
    assert saved["group_fks"][13] != saved["group_fks"][11]
