"""Unit tests for batch B 4b: hybrid supercluster assignment in prod
(assign_super_clusters_hybrid). See plan-batch-B.md.
"""

import asyncio
import os

import numpy as np
import pytest

from backend.config.settings import settings
from backend.services import super_cluster_service as scs
from backend.services import supercluster_discovery as sd


def _unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def test_hybrid_assignment_end_to_end(monkeypatch):
    # Two tight orthogonal families (clusters 0+1 ~ axis0, cluster 2 ~ axis1)
    # plus one noise page. Keyword "volcanoes" aligned with axis0 → group of
    # clusters {0,1} gets the keyword; cluster 2's group goes suggested.
    labels = np.array([0, 0, 1, 1, 2, 2, -1])
    emb = np.vstack([
        _unit([10, 0.5, 0, 0]), _unit([10, -0.5, 0, 0]),      # cluster 0
        _unit([10, 0.3, 0.2, 0]), _unit([10, -0.3, 0.2, 0]),  # cluster 1
        _unit([0, 0, 10, 0.4]), _unit([0, 0, 10, -0.4]),      # cluster 2
        _unit([0, 0, 0, 1]),                                   # noise
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(7)]
    cluster_names = {0: "Volcano Wiki", 1: "Eruptions", 2: "Knitting"}
    slug_to_db_id = {"volcano_wiki": 11, "eruptions": 12, "knitting": 13}

    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.5)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    # fine cut low enough to separate clusters 0 and 1 (centroid cosine
    # distance ~2e-4) so the declared volcano group gets a split proposal
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-7)
    # this test exercises split proposals, not singleton collapse
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)

    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "volcanoes"}]},
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
        return {g["group_index"]: "Fiber Crafts" for g in unlabeled}, 0.001

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    async def fake_verify(matched, members_by_group, names):
        return set(), 0.0  # verifier approves everything in this test

    monkeypatch.setattr(scs, "_verify_topic_matches", fake_verify)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 55, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )

    assert summary["groups"] == 2
    assert summary["matched"] == 1 and summary["suggested"] == 1

    groups = list(saved["groups"].values())
    kw = next(g for g in groups if g["source"] == "keyword")
    sug = next(g for g in groups if g["source"] == "suggested")
    assert kw["topic"] == "volcanoes" and kw["label"] == "volcanoes"
    assert kw["interest_tier"] == "declared"
    assert sug["label"] == "Fiber Crafts" and sug["topic"] is None

    # C2: the declared umbrella spans two fine subgroups -> split proposal
    # with db ids of both member clusters; the suggested group gets none
    split = kw["split_proposal"]
    assert split and len(split) == 2
    assert sorted(i for p in split for i in p["cluster_db_ids"]) == [11, 12]
    assert sug["split_proposal"] is None

    # cluster labels: volcano clusters carry the keyword, knitting the suggestion
    assert saved["labels"][11] == "volcanoes"
    assert saved["labels"][12] == "volcanoes"
    assert saved["labels"][13] == "Fiber Crafts"
    # FK plumbing: same group id for 11/12, different for 13
    assert saved["group_fks"][11] == saved["group_fks"][12] != saved["group_fks"][13]


def test_sibling_labels_computed_from_real_call_site(monkeypatch):
    """Closes a wiring gap `tests/test_naming_registry.py`'s unit test can't
    reach: that test reimplements the call site's sibling_labels
    computation inline, so it would still pass even if
    `assign_super_clusters_hybrid` dropped the `sibling_labels=` kwarg
    entirely. This test drives the REAL pipeline (same fixture as
    `test_hybrid_assignment_end_to_end` above -- one matched keyword group
    "volcanoes", one unmatched group that goes to suggestion) with a
    capturing `_suggest_group_labels` stub, and asserts the kwarg the real
    call site actually passes is non-None, sorted, deduped, and contains
    the matched group's FINAL label."""
    labels = np.array([0, 0, 1, 1, 2, 2, -1])
    emb = np.vstack([
        _unit([10, 0.5, 0, 0]), _unit([10, -0.5, 0, 0]),      # cluster 0
        _unit([10, 0.3, 0.2, 0]), _unit([10, -0.3, 0.2, 0]),  # cluster 1
        _unit([0, 0, 10, 0.4]), _unit([0, 0, 10, -0.4]),      # cluster 2
        _unit([0, 0, 0, 1]),                                   # noise
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(7)]
    cluster_names = {0: "Volcano Wiki", 1: "Eruptions", 2: "Knitting"}
    slug_to_db_id = {"volcano_wiki": 11, "eruptions": 12, "knitting": 13}

    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.5)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-7)
    # this test is about sibling_labels wiring, not singleton collapse
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)

    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "volcanoes"}]},
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

    monkeypatch.setattr(
        scs.cluster_repo, "save_super_cluster_groups",
        lambda uid, rid, groups: {g["group_index"]: 900 + g["group_index"] for g in groups},
    )
    monkeypatch.setattr(scs.cluster_repo, "update_super_clusters", lambda uid, a: None)
    monkeypatch.setattr(scs.cluster_repo, "update_cluster_groups", lambda uid, a: None)

    captured = {}

    async def capturing_fake_suggest(unlabeled, members_by_group, names, sibling_labels=None):
        captured["sibling_labels"] = sibling_labels
        return {g["group_index"]: "Fiber Crafts" for g in unlabeled}, 0.001

    monkeypatch.setattr(scs, "_suggest_group_labels", capturing_fake_suggest)

    async def fake_verify(matched, members_by_group, names):
        return set(), 0.0  # verifier approves everything in this test

    monkeypatch.setattr(scs, "_verify_topic_matches", fake_verify)

    asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 55, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )

    assert "sibling_labels" in captured, "_suggest_group_labels was never called"
    assert captured["sibling_labels"] is not None
    assert captured["sibling_labels"] == sorted(set(captured["sibling_labels"]))
    assert captured["sibling_labels"] == ["volcanoes"]


def test_hybrid_works_with_zero_keywords(monkeypatch):
    """The F13 dead end (no keywords → all NULL) is gone: groups are still
    discovered and labeled via suggestions."""
    labels = np.array([0, 0])
    emb = np.vstack([_unit([1, 0.1, 0]), _unit([1, -0.1, 0])])
    pages = [{"db_id": 1, "page_content_id": 2}, {"db_id": 3, "page_content_id": 4}]

    # single group, no singleton possible here; pinned for consistency
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences", lambda uid: {"topic_interests": []}
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
        lambda uid, rid, groups: {g["group_index"]: 500 for g in groups},
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_super_clusters",
        lambda uid, a: saved.update(labels=a),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_cluster_groups", lambda uid, a: None
    )

    async def fake_suggest(unlabeled, members_by_group, names, sibling_labels=None):
        return {}, 0.0  # LLM failed → fallback label path

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 56, labels, {0: "Deep Sea Fish"}, pages, emb,
            {"deep_sea_fish": 21},
        )
    )
    assert summary["groups"] == 1 and summary["suggested"] == 1
    # fallback = biggest member cluster's name, never NULL
    assert saved["labels"][21] == "Deep Sea Fish"


def test_bogus_label_prompt_version_fails_open_not_out(monkeypatch):
    """Review fix (2026-08-14): a typo'd SUPERCLUSTER_LABEL_PROMPT_VERSION
    used to raise KeyError from get_prompt_raw() OUTSIDE
    _suggest_group_labels' LLM fail-open try, crashing the whole recluster.
    Same minimal fixture as test_hybrid_works_with_zero_keywords above, but
    drives the REAL _suggest_group_labels (not mocked) with a bogus
    registry version -- the KeyError must be swallowed by the SAME
    fail-open path an LLM/transport failure takes, landing on the fallback
    label, not propagate out of assign_super_clusters_hybrid."""
    labels = np.array([0, 0])
    emb = np.vstack([_unit([1, 0.1, 0]), _unit([1, -0.1, 0])])
    pages = [{"db_id": 1, "page_content_id": 2}, {"db_id": 3, "page_content_id": 4}]

    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
    monkeypatch.setattr(settings, "supercluster_label_prompt_version", "bogus_v99")
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences", lambda uid: {"topic_interests": []}
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
        lambda uid, rid, groups: {g["group_index"]: 500 for g in groups},
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_super_clusters",
        lambda uid, a: saved.update(labels=a),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_cluster_groups", lambda uid, a: None
    )

    # _suggest_group_labels is NOT mocked -- the real function must hit
    # get_prompt_raw("supercluster_label_bogus_v99", ...), catch the
    # resulting KeyError inside its own try, and degrade to ({}, 0.0).
    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 57, labels, {0: "Deep Sea Fish"}, pages, emb,
            {"deep_sea_fish": 22},
        )
    )
    assert summary["groups"] == 1 and summary["suggested"] == 1
    assert summary["naming_cost"] == 0.0
    # fallback = biggest member cluster's name, never NULL, never a crash
    assert saved["labels"][22] == "Deep Sea Fish"


def test_dismissed_suggestion_not_painted(monkeypatch):
    """Design audit 2026-07-11 §1C: a suggested group whose fresh label
    matches preferences.dismissed_topics keeps its row (source='dismissed')
    but is not painted — member clusters get no super_cluster label and no
    group FK, so the territory disappears from the graph and the badge."""
    labels = np.array([0, 0, 1, 1])
    emb = np.vstack([
        _unit([1, 0.1, 0, 0]), _unit([1, -0.1, 0, 0]),   # cluster 0
        _unit([0, 0, 1, 0.1]), _unit([0, 0, 1, -0.1]),   # cluster 1
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(4)]
    cluster_names = {0: "Crochet Patterns", 1: "Solar Panels"}
    slug_to_db_id = {"crochet_patterns": 61, "solar_panels": 62}

    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.5)
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {
            "topic_interests": [],
            # stored lowercase; the fresh label arrives title-cased —
            # the match must be case-insensitive
            "dismissed_topics": [{"label": "fiber crafts",
                                  "dismissed_at": "2026-07-01"}],
        },
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
            or {g["group_index"]: 950 + g["group_index"] for g in groups}
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
        return {
            g["group_index"]: (
                "Fiber Crafts"
                if 0 in members_by_group[g["group_index"]]
                else "Solar Punk"
            )
            for g in unlabeled
        }, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 60, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )
    assert summary["groups"] == 2
    assert summary["suggested"] == 1 and summary["dismissed"] == 1

    by_label = {g["label"]: g for g in saved["groups"].values()}
    assert by_label["Fiber Crafts"]["source"] == "dismissed"
    assert by_label["Solar Punk"]["source"] == "suggested"
    # only the live suggestion is painted onto its cluster
    assert saved["labels"] == {62: "Solar Punk"}
    assert list(saved["group_fks"].keys()) == [62]


def test_fallback_group_label_picks_biggest_member():
    labels = np.array([0, 0, 0, 1])
    assert scs._fallback_group_label(
        [0, 1], {0: "Big Topic", 1: "Small Topic"}, labels
    ) == "Big Topic"


@pytest.mark.skipif(
    not os.environ.get("OPENAI_API_KEY"), reason="OPENAI_API_KEY not set"
)
def test_verifier_demotes_rejected_match(monkeypatch):
    """C4: a verifier rejection turns a keyword group into a suggested one
    (suggested label + recomputed tier), without touching approved matches."""
    labels = np.array([0, 0, 1, 1])
    emb = np.vstack([
        _unit([1, 0.1, 0, 0]), _unit([1, -0.1, 0, 0]),   # cluster 0
        _unit([0, 0, 1, 0.1]), _unit([0, 0, 1, -0.1]),   # cluster 1
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(4)]
    cluster_names = {0: "Widget Models", 1: "Ergo Keyboards"}
    slug_to_db_id = {"widget_models": 31, "ergo_keyboards": 32}

    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.3)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.25)
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "3d printing"}]},
    )
    # keyword vector overlaps BOTH group axes at ~0.30 — inside the verify
    # band (< VERIFY_SIM_CEILING), so both matches get audited
    monkeypatch.setattr(
        sd, "embed_keywords",
        lambda kws, user_id=None, harness=False: _unit([1, 0, 1, 3]).reshape(1, -1),
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
            or {g["group_index"]: 800 + g["group_index"] for g in groups}
        ),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_super_clusters",
        lambda uid, a: saved.update(labels=a),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_cluster_groups", lambda uid, a: None
    )

    async def fake_verify(matched, members_by_group, names):
        # reject whichever group holds the Ergo cluster (index 1);
        # zero cost so the cost-event branch stays out of the unit test
        bad = next(g["group_index"] for g in matched
                   if 1 in members_by_group[g["group_index"]])
        return {bad}, 0.0

    async def fake_suggest(unlabeled, members_by_group, names, sibling_labels=None):
        return {g["group_index"]: "Ergonomic Input Devices" for g in unlabeled}, 0.0

    monkeypatch.setattr(scs, "_verify_topic_matches", fake_verify)
    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 57, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )
    assert summary["matched"] == 1 and summary["suggested"] == 1
    assert saved["labels"][31] == "3d printing"
    assert saved["labels"][32] == "Ergonomic Input Devices"


def test_accepted_split_subdivides_umbrella(monkeypatch):
    """C2 accept (keep-both): an umbrella in preferences.split_topics gets
    its group re-cut along the fine partition; pieces re-map independently
    (here both pieces keep the umbrella keyword — keep-both in action)."""
    labels = np.array([0, 0, 1, 1, 2, 2])
    emb = np.vstack([
        _unit([10, 0.5, 0, 0]), _unit([10, -0.5, 0, 0]),      # cluster 0
        _unit([10, 0.3, 0.2, 0]), _unit([10, -0.3, 0.2, 0]),  # cluster 1
        _unit([0, 0, 10, 0.4]), _unit([0, 0, 10, -0.4]),      # cluster 2
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(6)]
    cluster_names = {0: "Volcano Wiki", 1: "Eruptions", 2: "Knitting"}
    slug_to_db_id = {"volcano_wiki": 11, "eruptions": 12, "knitting": 13}

    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.5)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-7)
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "volcanoes"}],
                     "split_topics": ["Volcanoes"]},  # case-insensitive
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
            saved.update(groups=groups)
            or {g["group_index"]: 900 + g["group_index"] for g in groups}
        ),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_super_clusters", lambda uid, a: None
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_cluster_groups", lambda uid, a: None
    )

    async def fake_suggest(unlabeled, members_by_group, names, sibling_labels=None):
        return {g["group_index"]: "Suggested" for g in unlabeled}, 0.0

    async def fake_verify(matched, members_by_group, names):
        return set(), 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)
    monkeypatch.setattr(scs, "_verify_topic_matches", fake_verify)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 59, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )
    # without the split: 2 groups (volcanoes + knitting); with it: 3
    assert summary["groups"] == 3
    volcano_groups = [g for g in saved["groups"] if g["topic"] == "volcanoes"]
    assert len(volcano_groups) == 2  # umbrella kept on both pieces
    assert all(g["member_count"] == 1 for g in volcano_groups)


def test_strong_matches_audited_and_rescued_by_carve(monkeypatch):
    """P1 (fix-design 2026-07-16): matches at/above VERIFY_SIM_CEILING are
    audited too — run 142's 0.5053 group was wrong and the verifier catches
    it when shown (stable x2), while the strong 0.529 true group passes.
    A wrongly-rejected strong group's members still return via the carve
    path (individual sim >= ceiling auto-accepts), so a reject-happy
    verifier cannot destroy a genuinely strong topic."""
    labels = np.array([0, 0])
    emb = np.vstack([_unit([1, 0.1, 0]), _unit([1, -0.1, 0])])
    pages = [{"db_id": 1, "page_content_id": 2}, {"db_id": 3, "page_content_id": 4}]

    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.3)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.25)
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "3d printing"}]},
    )
    monkeypatch.setattr(  # sim ~1.0 — far above the ceiling
        sd, "embed_keywords",
        lambda kws, user_id=None, harness=False: _unit([1, 0, 0]).reshape(1, -1),
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
            saved.update(groups=groups)
            or {g["group_index"]: 700 + g["group_index"] for g in groups}
        ),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_super_clusters", lambda uid, a: None
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_cluster_groups", lambda uid, a: None
    )

    audited = []

    async def reject_all(matched, members_by_group, names):
        audited.extend(g["group_index"] for g in matched)
        return {g["group_index"] for g in matched}, 0.0

    monkeypatch.setattr(scs, "_verify_topic_matches", reject_all)

    async def fake_suggest(unlabeled, members_by_group, names, sibling_labels=None):
        return {g["group_index"]: "Misc" for g in unlabeled}, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 58, labels, {0: "Widgets"}, pages, emb, {"widgets": 41}
        )
    )
    # The strong (sim ~1.0) group WAS audited (old code skipped it) ...
    assert 0 in audited
    # ... and demoted — but the cluster's own claim (~1.0 >= 0.45 ceiling)
    # auto-accepts through the carve path, so the keyword survives.
    assert summary["matched"] == 1
    kw_groups = [g for g in saved["groups"] if g["source"] == "keyword"]
    assert len(kw_groups) == 1 and kw_groups[0]["topic"] == "3d printing"


def test_verify_parser_and_fail_open(monkeypatch):
    from types import SimpleNamespace

    matched = [{"group_index": 3, "topic": "3d printing"}]
    members = {3: [0]}
    names = {0: "Ergo"}

    class LLMStub:
        def __init__(self, content):
            self._c = content

        async def complete(self, **kwargs):
            assert kwargs["response_format"] == "json_object"
            return SimpleNamespace(content=self._c, cost_usd=0.0001, latency_ms=1)

    monkeypatch.setattr(scs, "LLMService", lambda: LLMStub(
        '{"verdicts": [{"group_id": 3, "fits": false, "reason": "keyboards"}]}'
    ))
    rejected, _ = asyncio.run(scs._verify_topic_matches(matched, members, names))
    assert rejected == {3}

    # fail-open on garbage
    monkeypatch.setattr(scs, "LLMService", lambda: LLMStub("{broken"))
    rejected, _ = asyncio.run(scs._verify_topic_matches(matched, members, names))
    assert rejected == set()


def _carve_fixture(monkeypatch, saved, verify_impl):
    """3 clusters, ONE geometric group (cut 0.95). kwA=axis0 owns the group;
    cluster 2 is axis1-dominant -> cluster-level claim for kwB."""
    labels = np.array([0, 0, 1, 1, 2, 2])
    emb = np.vstack([
        _unit([10, 0.5, 0, 0]), _unit([10, -0.5, 0, 0]),   # cluster 0
        _unit([10, 0.3, 0.2, 0]), _unit([10, -0.3, 0.2, 0]),  # cluster 1
        _unit([3, 9, 0, 0]), _unit([3.2, 9, 0, 0]),        # cluster 2 -> kwB
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(6)]
    cluster_names = {0: "Volcano Wiki", 1: "Eruptions", 2: "Star Charts"}
    slug_to_db_id = {"volcano_wiki": 11, "eruptions": 12, "star_charts": 13}

    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.95)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-7)
    monkeypatch.setattr(settings, "supercluster_carve_margin", 0.05)
    monkeypatch.setattr(settings, "supercluster_group_support_min", 0.0)
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "kwA"}, {"keyword": "kwB"}]},
    )
    monkeypatch.setattr(
        sd, "embed_keywords",
        lambda kws, user_id=None, harness=False: np.vstack(
            [_unit([1, 0, 0, 0]), _unit([0, 1, 0, 0])]
        ),
    )
    monkeypatch.setattr(
        "backend.db.page_repo.get_visit_history", lambda uid, pids: {}
    )

    async def _no_expansion(kws):
        return {}, 0.0

    monkeypatch.setattr(scs, "_expand_keywords", _no_expansion)

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
        return {g["group_index"]: "Misc" for g in unlabeled}, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)
    monkeypatch.setattr(scs, "_verify_topic_matches", verify_impl)
    return labels, emb, pages, cluster_names, slug_to_db_id


def test_carve_out_moves_strong_cluster_to_other_keyword(monkeypatch):
    saved = {}

    async def approve_all(matched, members_by_group, names):
        return set(), 0.0

    labels, emb, pages, names, slugs = _carve_fixture(monkeypatch, saved, approve_all)

    async def must_not_audit(entries, names_):
        pytest.fail("must not audit above-ceiling claims")

    monkeypatch.setattr(scs, "_verify_topic_members", must_not_audit)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(1, 55, labels, names, pages, emb, slugs)
    )
    groups = list(saved["groups"].values())
    kw_groups = [g for g in groups if g["source"] == "keyword"]
    assert {g["topic"] for g in kw_groups} == {"kwA", "kwB"}
    carved = next(g for g in kw_groups if g["topic"] == "kwB")
    assert carved["member_count"] == 1 and carved["interest_tier"] == "declared"
    donor = next(g for g in kw_groups if g["topic"] == "kwA")
    assert donor["member_count"] == 2  # cluster 2 left the donor
    assert saved["labels"][13] == "kwB"  # Star Charts painted with the claim
    assert summary["matched"] == 2


def test_carve_out_reverts_when_verifier_rejects(monkeypatch):
    saved = {}

    async def reject_member_claims(entries, names_):
        return {(e["group_index"], e["cluster_id"]) for e in entries}, 0.0

    # axis2 family, suggested donor; cluster 2 claims kwB in the audit band
    labels = np.array([0, 0, 1, 1, 2, 2])
    emb = np.vstack([
        _unit([0, 0, 10, 0.5]), _unit([0, 0, 10, -0.5]),
        _unit([0, 0, 10, 0.3]), _unit([0, 0, 10, -0.3]),
        _unit([0, 0, 10, 4]), _unit([0, 0, 10, 4.2]),   # cluster 2: kwB ~0.37
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(6)]
    names = {0: "A", 1: "B", 2: "C"}
    slugs = {"a": 11, "b": 12, "c": 13}
    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.95)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-7)
    monkeypatch.setattr(settings, "supercluster_carve_margin", 0.05)
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "kwB"}]},
    )
    monkeypatch.setattr(
        sd, "embed_keywords",
        lambda kws, user_id=None, harness=False: _unit([0, 0, 0, 1]).reshape(1, -1),
    )
    monkeypatch.setattr(
        "backend.db.page_repo.get_visit_history", lambda uid, pids: {}
    )

    async def _no_expansion(kws):
        return {}, 0.0

    monkeypatch.setattr(scs, "_expand_keywords", _no_expansion)

    saved_holder = saved
    monkeypatch.setattr(
        scs.cluster_repo, "save_super_cluster_groups",
        lambda uid, rid, groups: (
            saved_holder.update(groups={g["group_index"]: g for g in groups})
            or {g["group_index"]: 900 + g["group_index"] for g in groups}
        ),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_super_clusters",
        lambda uid, a: saved_holder.update(labels=a),
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_cluster_groups",
        lambda uid, a: saved_holder.update(group_fks=a),
    )

    async def fake_suggest(unlabeled, members_by_group, names_, sibling_labels=None):
        return {g["group_index"]: "Misc" for g in unlabeled}, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    async def approve(m, mb, n):
        return set(), 0.0

    # Group verify approves (the donor group here is suggested so it gets an
    # empty payload anyway); the carve pass rejects every audited member.
    monkeypatch.setattr(scs, "_verify_topic_matches", approve)
    monkeypatch.setattr(scs, "_verify_topic_members", reject_member_claims)

    asyncio.run(
        scs.assign_super_clusters_hybrid(1, 55, labels, names, pages, emb, slugs)
    )
    groups = list(saved["groups"].values())
    # carve was audited (kwB sim ~0.37 < 0.45) and rejected -> reverted:
    assert all(g["source"] != "keyword" for g in groups)
    assert saved["labels"][13] == "Misc"  # cluster C stays with its donor
    # donor group kept all 3 members
    assert sum(g["member_count"] for g in groups) == 3


# ── _expand_keywords (depth-1 umbrella expansion, 2026-07-14 spec) ───────


class _FakeLLMResponse:
    def __init__(self, content):
        self.content = content
        self.cost_usd = 0.0002
        self.latency_ms = 5.0


def test_expand_keywords_parses_and_filters(monkeypatch):
    async def fake_complete(self, **kwargs):
        return _FakeLLMResponse(
            '{"expansions": [{"topic": "science", "terms": ["physics", '
            '"geology", " ", "chemistry"]}, {"topic": "unknown", '
            '"terms": ["x"]}]}'
        )

    monkeypatch.setattr(scs.LLMService, "complete", fake_complete)
    result, cost = asyncio.run(scs._expand_keywords(["science", "art"]))
    assert result == {"science": ["physics", "geology", "chemistry"]}
    assert cost == 0.0002


def test_expand_keywords_fail_open(monkeypatch):
    async def boom(self, **kwargs):
        raise RuntimeError("api down")

    monkeypatch.setattr(scs.LLMService, "complete", boom)
    result, cost = asyncio.run(scs._expand_keywords(["science"]))
    assert result == {} and cost == 0.0


def test_expansion_terms_rescue_umbrella_keyword(monkeypatch):
    """Keyword vec is orthogonal to every cluster; its expansion term is on
    the cluster axis -> group matches via the term (max-over-terms)."""
    saved = {}
    labels = np.array([0, 0, 1, 1])
    emb = np.vstack([
        _unit([10, 0.5, 0, 0]), _unit([10, -0.5, 0, 0]),
        _unit([10, 0.3, 0.2, 0]), _unit([10, -0.3, 0.2, 0]),
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(4)]
    names = {0: "Fluid Dynamics", 1: "Geology"}
    slugs = {"fluid_dynamics": 11, "geology": 12}
    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.5)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-7)
    monkeypatch.setattr(settings, "supercluster_keyword_expansion", True)
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
    prefs_written = {}
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "science"}]},
    )
    monkeypatch.setattr(
        "backend.db.auth_repo.update_preferences",
        lambda uid, p: prefs_written.update(p),
    )

    async def fake_expand(kws):
        return {"science": ["physics"]}, 0.0001

    monkeypatch.setattr(scs, "_expand_keywords", fake_expand)
    # embed_keywords now receives the FLAT list ["science", "physics"]
    monkeypatch.setattr(
        sd, "embed_keywords",
        lambda kws, user_id=None, harness=False: np.vstack(
            [_unit([0, 0, 0, 1]) if k == "science" else _unit([1, 0, 0, 0])
             for k in kws]
        ),
    )
    monkeypatch.setattr(
        "backend.db.page_repo.get_visit_history", lambda uid, pids: {}
    )
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

    async def fake_suggest(unlabeled, members_by_group, names_, sibling_labels=None):
        return {g["group_index"]: "Misc" for g in unlabeled}, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    async def approve_all(matched, members_by_group, names_):
        return set(), 0.0

    monkeypatch.setattr(scs, "_verify_topic_matches", approve_all)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(1, 55, labels, names, pages, emb, slugs)
    )
    assert summary["matched"] == 1
    kw = next(g for g in saved["groups"].values() if g["source"] == "keyword")
    assert kw["topic"] == "science"
    # lazy persistence wrote the terms back into topic_interests
    assert prefs_written["topic_interests"][0]["expansion_terms"] == ["physics"]


# ── _verify_topic_members + per-member carve audit (fix-design P3) ───────


def test_verify_topic_members_parser_and_fail_open(monkeypatch):
    from types import SimpleNamespace

    entries = [
        {"group_index": 9, "topic": "astronomy", "cluster_id": 5, "similarity": 0.31},
        {"group_index": 9, "topic": "astronomy", "cluster_id": 6, "similarity": 0.41},
    ]
    names = {5: "Samsung Galaxy Z Fold 8", 6: "Extraterrestrial Life Theories"}

    class LLMStub:
        def __init__(self, content):
            self._c = content

        async def complete(self, **kwargs):
            assert kwargs["response_format"] == "json_object"
            return SimpleNamespace(content=self._c, cost_usd=0.0001, latency_ms=1)

    monkeypatch.setattr(scs, "LLMService", lambda: LLMStub(
        '{"verdicts": ['
        '{"group_id": 9, "cluster": "Samsung Galaxy Z Fold 8", "fits": false, "reason": "phones"},'
        '{"group_id": 9, "cluster": "Extraterrestrial Life Theories", "fits": true, "reason": "ok"}]}'
    ))
    rejected, _ = asyncio.run(scs._verify_topic_members(entries, names))
    assert rejected == {(9, 5)}

    # fail-open on garbage
    monkeypatch.setattr(scs, "LLMService", lambda: LLMStub("{broken"))
    rejected, _ = asyncio.run(scs._verify_topic_members(entries, names))
    assert rejected == set()

    # fail-open on transport error
    class LLMBoom:
        async def complete(self, **kwargs):
            raise RuntimeError("api down")

    monkeypatch.setattr(scs, "LLMService", lambda: LLMBoom())
    rejected, _ = asyncio.run(scs._verify_topic_members(entries, names))
    assert rejected == set()


def test_carve_audit_is_per_member_not_group_max(monkeypatch):
    """The run-142 blind spot: a weak carve member must not ride through
    unaudited behind a strong co-claimant. Strong member (>= 0.45)
    auto-accepts without audit; weak member is audited individually and a
    rejection dissolves ONLY that member back to its donor."""
    saved = {}

    async def approve_groups(matched, members_by_group, names):
        return set(), 0.0

    # Geometry: kwA = axis0, kwB = axis1. Cluster 2 sims ~0.95 to kwB
    # (strong claim, above ceiling). Cluster 1's ARGMAX is kwB at ~0.36
    # (audit band) with kwA ~0.29 (margin satisfied: 0.36 >= 0.29+0.05);
    # its bulk is on axis2 so it still groups with cluster 0 under the
    # 0.95 cosine-distance cut. The group centroid stays kwA-dominant.
    labels = np.array([0, 0, 1, 1, 2, 2])
    emb = np.vstack([
        _unit([10, 0.5, 0, 0]), _unit([10, -0.5, 0, 0]),     # cluster 0: kwA ~1.0
        _unit([3, 3.9, 9, 0]), _unit([3, 3.5, 9, 0]),        # cluster 1: kwB ~0.36, kwA ~0.29
        _unit([3, 9, 0, 0]), _unit([3.2, 9, 0, 0]),          # cluster 2: kwB ~0.95
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(6)]
    cluster_names = {0: "Volcano Wiki", 1: "Ash Clouds Maybe", 2: "Star Charts"}
    slug_to_db_id = {"volcano_wiki": 11, "ash_clouds_maybe": 12, "star_charts": 13}

    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.95)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-7)
    monkeypatch.setattr(settings, "supercluster_carve_margin", 0.05)
    monkeypatch.setattr(settings, "supercluster_group_support_min", 0.0)
    # The surviving kwB singleton (cluster 2, geometrically close to the
    # kwA donor by design of this fixture) is exactly the shape the
    # singleton-collapse pass targets. Left UNPINNED (real production
    # default, currently 0.57) deliberately, as of the review 2026-08-14
    # same-label guard (fix 2): a keyword-source singleton may only merge
    # into a target whose label matches its own, and the only nearby
    # target here is the kwA donor — a DIFFERENT label — so the guard
    # blocks the merge and this test's carve-audit assertions hold at the
    # real threshold too, pinning that production behavior.
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {"topic_interests": [{"keyword": "kwA"}, {"keyword": "kwB"}]},
    )
    monkeypatch.setattr(
        sd, "embed_keywords",
        lambda kws, user_id=None, harness=False: np.vstack(
            [_unit([1, 0, 0, 0]), _unit([0, 1, 0, 0])]
        ),
    )
    monkeypatch.setattr(
        "backend.db.page_repo.get_visit_history", lambda uid, pids: {}
    )

    async def _no_expansion(kws):
        return {}, 0.0

    monkeypatch.setattr(scs, "_expand_keywords", _no_expansion)
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
        return {g["group_index"]: "Misc" for g in unlabeled}, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)
    monkeypatch.setattr(scs, "_verify_topic_matches", approve_groups)

    audited_entries = []

    async def reject_weak_members(entries, names_):
        audited_entries.extend(entries)
        return {(e["group_index"], e["cluster_id"]) for e in entries}, 0.0

    monkeypatch.setattr(scs, "_verify_topic_members", reject_weak_members)

    asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 55, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )
    # Only the weak claim (cluster 1, ~0.37) was audited; the strong claim
    # (cluster 2, ~0.95 >= ceiling) auto-accepted without an LLM call.
    assert [e["cluster_id"] for e in audited_entries] == [1]
    # kwB carve survives with ONLY the strong member; the rejected weak
    # member stayed with its donor group.
    kwb = next(g for g in saved["groups"].values() if g["topic"] == "kwB")
    assert kwb["member_count"] == 1
    assert saved["labels"][13] == "kwB"
    assert saved["labels"][12] == "kwA"  # rejected claimant stays with donor


# ── support-fraction gate (fix-design P2) ────────────────────────────────


def _support_gate_fixture(monkeypatch, saved, support_min):
    """3 clusters forced into ONE group. kwA=axis0. Clusters 0/1 strongly
    axis0 (own sim ~1.0); cluster 2 nearly orthogonal (own sim ~0.2, below
    the 0.30 member threshold) but the group centroid still matches."""
    labels = np.array([0, 0, 1, 1, 2, 2])
    emb = np.vstack([
        _unit([10, 0.5, 0, 0]), _unit([10, -0.5, 0, 0]),      # cluster 0 ~1.0
        _unit([10, 0.3, 0.2, 0]), _unit([10, -0.3, 0.2, 0]),  # cluster 1 ~1.0
        _unit([2, 0, 10, 0]), _unit([2, 0, 9.5, 0]),          # cluster 2 ~0.2
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(6)]
    cluster_names = {0: "Volcano Wiki", 1: "Eruptions", 2: "Ethics Essays"}
    slug_to_db_id = {"volcano_wiki": 11, "eruptions": 12, "ethics_essays": 13}

    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.95)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-7)
    monkeypatch.setattr(settings, "supercluster_carve_margin", 0.05)
    monkeypatch.setattr(settings, "supercluster_group_support_min", support_min)
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
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
        return {g["group_index"]: "Misc" for g in unlabeled}, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    async def approve_all(matched, members_by_group, names):
        return set(), 0.0

    monkeypatch.setattr(scs, "_verify_topic_matches", approve_all)

    async def approve_members(entries, names_):
        return set(), 0.0

    monkeypatch.setattr(scs, "_verify_topic_members", approve_members)
    return labels, emb, pages, cluster_names, slug_to_db_id


def test_support_gate_decomposes_passenger_heavy_group(monkeypatch):
    saved = {}
    labels, emb, pages, cluster_names, slug_to_db_id = _support_gate_fixture(
        monkeypatch, saved, support_min=0.75
    )
    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 60, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )
    # sf = 2/3 < 0.75 -> the below-threshold member leaves the keyword group
    kw = next(g for g in saved["groups"].values() if g["topic"] == "kwA")
    assert kw["member_count"] == 2
    residual = next(
        g for g in saved["groups"].values()
        if g["source"] == "suggested" and g["label"] == "Misc"
    )
    assert residual["member_count"] == 1
    assert saved["labels"][11] == "kwA" and saved["labels"][12] == "kwA"
    assert saved["labels"][13] == "Misc"  # pruned member painted honestly
    assert saved["group_fks"][13] != saved["group_fks"][11]
    assert summary["matched"] == 1 and summary["suggested"] == 1


def test_support_gate_disabled_at_zero(monkeypatch):
    saved = {}
    labels, emb, pages, cluster_names, slug_to_db_id = _support_gate_fixture(
        monkeypatch, saved, support_min=0.0
    )
    asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 61, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )
    kw = next(g for g in saved["groups"].values() if g["topic"] == "kwA")
    assert kw["member_count"] == 3          # legacy behavior: passengers ride
    assert saved["labels"][13] == "kwA"


def test_support_gate_drops_keyword_group_with_zero_support(monkeypatch):
    """Two clusters each individually BELOW the member threshold (~0.24)
    whose NORMALIZED group centroid still clears it (~0.33) — the pure
    passenger-amplification geometry: their orthogonal bulks (axis1 vs
    axis2) partially cancel in the mean while the shared kwA component
    survives normalization. sf=0 -> the keyword group dissolves entirely
    into the residual; no carve rescues (claims < 0.30)."""
    saved = {}
    labels = np.array([0, 0, 1, 1])
    emb = np.vstack([
        _unit([1, 4, 0, 0]), _unit([1, 4.1, 0, 0]),    # cluster 0: kwA ~0.24, bulk axis1
        _unit([1, 0, 4, 0]), _unit([1, 0, 4.1, 0]),    # cluster 1: kwA ~0.24, bulk axis2
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(4)]
    cluster_names = {0: "Morality Essays", 1: "Wiki Policy"}
    slug_to_db_id = {"morality_essays": 11, "wiki_policy": 12}

    # cut 0.96: the two clusters' mutual cosine distance is ~0.94 (sim
    # ~0.06 via the shared kwA component) — merge with a little margin
    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.96)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-7)
    monkeypatch.setattr(settings, "supercluster_carve_margin", 0.05)
    monkeypatch.setattr(settings, "supercluster_group_support_min", 0.75)
    monkeypatch.setattr(settings, "supercluster_singleton_merge_threshold", 0.0)
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
        return {g["group_index"]: "Misc" for g in unlabeled}, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    async def approve_all(matched, members_by_group, names):
        return set(), 0.0

    monkeypatch.setattr(scs, "_verify_topic_matches", approve_all)

    async def approve_members(entries, names_):
        return set(), 0.0

    monkeypatch.setattr(scs, "_verify_topic_members", approve_members)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 62, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )
    assert summary["matched"] == 0
    assert all(g["source"] != "keyword" for g in saved["groups"].values())
    assert saved["labels"][11] == "Misc" and saved["labels"][12] == "Misc"


# ── class-(e) member exclusions (sc-followups 2026-07-16) ──────────────


def test_member_exclusion_moves_excluded_cluster_to_residual(monkeypatch):
    """A user-dismissed (keyword, cluster) pair is a hard exclusion. Uses a
    cohesive group where ALL 3 members individually clear the match
    threshold (support fraction 3/3 >= support_min) so the support gate
    alone would NOT remove any member -- only the explicit exclusion pulls
    the targeted cluster out into a residual suggested group."""
    saved = {}
    labels = np.array([0, 0, 1, 1, 2, 2])
    emb = np.vstack([
        _unit([10, 0.5, 0, 0]), _unit([10, -0.5, 0, 0]),      # cluster 0
        _unit([10, 0.3, 0.2, 0]), _unit([10, -0.3, 0.2, 0]),  # cluster 1
        _unit([10, 0.2, 0, 0.3]), _unit([10, -0.2, 0, 0.3]),  # cluster 2 (excluded)
    ])
    pages = [{"db_id": 100 + i, "page_content_id": 200 + i} for i in range(6)]
    cluster_names = {0: "Volcano Wiki", 1: "Eruptions", 2: "Ethics Essays"}
    slug_to_db_id = {"volcano_wiki": 11, "eruptions": 12, "ethics_essays": 13}

    monkeypatch.setattr(settings, "supercluster_group_threshold", 0.95)
    monkeypatch.setattr(settings, "supercluster_topic_match_threshold", 0.30)
    monkeypatch.setattr(settings, "supercluster_split_threshold", 1e-7)
    monkeypatch.setattr(settings, "supercluster_carve_margin", 0.05)
    monkeypatch.setattr(settings, "supercluster_group_support_min", 0.75)
    # The excluded cluster's residual singleton is geometrically close to
    # its former kwA donor by this fixture's design (0.95 group_threshold
    # pulls all 3 clusters into one group pre-exclusion) — exactly what
    # the singleton-collapse pass would otherwise fold back together. Left
    # UNPINNED (real production default, currently 0.57) deliberately, as
    # of the review 2026-08-14 exclusion guard (fix 1): the collapse pass
    # now skips any target whose topic matches an entry in
    # `sc_member_exclusions` for the singleton's own member, so the
    # excluded cluster can never fold back into the group that excluded
    # it — this test now pins that production behavior at the real
    # threshold instead of relying on threshold=0 to dodge the collision.
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {
            "topic_interests": [{"keyword": "kwA"}],
            "sc_member_exclusions": [
                {
                    "keyword": "kwA",
                    "cluster_slug": "ethics_essays",
                    "cluster_name": "Ethics Essays",
                    "created_at": "2026-07-16T00:00:00+00:00",
                },
            ],
        },
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
        return {g["group_index"]: "Misc" for g in unlabeled}, 0.0

    monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

    async def approve_all(matched, members_by_group, names):
        return set(), 0.0

    monkeypatch.setattr(scs, "_verify_topic_matches", approve_all)

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(
            1, 70, labels, cluster_names, pages, emb, slug_to_db_id
        )
    )
    kw = next(g for g in saved["groups"].values() if g["topic"] == "kwA")
    assert kw["member_count"] == 2
    residual = next(
        g for g in saved["groups"].values()
        if g["source"] == "suggested" and g["label"] == "Misc"
    )
    assert residual["member_count"] == 1
    assert saved["labels"][11] == "kwA" and saved["labels"][12] == "kwA"
    assert saved["labels"][13] == "Misc"  # excluded member painted honestly
    assert saved["group_fks"][13] != saved["group_fks"][11]
    assert summary["matched"] == 1 and summary["suggested"] == 1


def test_member_exclusion_filters_carve_claim(monkeypatch):
    """An excluded cluster whose own argmax differs from its group's topic
    must not re-enter via carve: the exclusions set is applied to `claims`
    BEFORE `_apply_carve_outs`, not only to already-materialized groups.

    Reuses `_carve_fixture` (Star Charts' own argmax is kwB, well above the
    carve auto-accept ceiling -- normally carved into its own kwB group per
    test_carve_out_moves_strong_cluster_to_other_keyword). Excluding
    (kwB, star_charts) must leave it exactly where it started: inside the
    kwA donor group with the other two members."""
    saved = {}

    async def approve_all(matched, members_by_group, names):
        return set(), 0.0

    labels, emb, pages, names, slugs = _carve_fixture(monkeypatch, saved, approve_all)
    monkeypatch.setattr(
        "backend.db.auth_repo.get_preferences",
        lambda uid: {
            "topic_interests": [{"keyword": "kwA"}, {"keyword": "kwB"}],
            "sc_member_exclusions": [
                {
                    "keyword": "kwB",
                    "cluster_slug": "star_charts",
                    "cluster_name": "Star Charts",
                    "created_at": "2026-07-16T00:00:00+00:00",
                },
            ],
        },
    )

    summary = asyncio.run(
        scs.assign_super_clusters_hybrid(1, 71, labels, names, pages, emb, slugs)
    )
    groups = list(saved["groups"].values())
    assert all(g["topic"] != "kwB" for g in groups)  # no kwB carve materialized
    kw_groups = [g for g in groups if g["source"] == "keyword"]
    assert {g["topic"] for g in kw_groups} == {"kwA"}
    donor = kw_groups[0]
    assert donor["member_count"] == 3  # Star Charts stayed with its donor
    assert saved["labels"][13] == "kwA"
    assert summary["matched"] == 1
