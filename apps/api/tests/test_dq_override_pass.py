"""Unit tests for clustering_service.apply_dq_overrides (dqBot Tier 1, spec S6).

Pure-function tests only -- no DB, no ClusteringService instantiation. The
function operates purely on in-memory labels/cluster_names/identity_matches;
the DB-touching wiring (fetch overrides, mark_applied, S3 expiry) lives in
ClusteringService.recluster_all and is covered separately below via a mocked
wiring test where the existing clustering test suite's pattern supports it
without a DB (see test_clustering_dq_hook.py's precedent for mocking a
guarded post-recluster side-effect with unittest.mock.patch).
"""

import numpy as np
import pytest

from backend.services.clustering_service import apply_dq_overrides


def _pages(content_ids):
    """[{"db_id", "page_content_id"}, ...] aligned with a labels array."""
    return [{"db_id": 100 + i, "page_content_id": c} for i, c in enumerate(content_ids)]


def _override(id_, override_type, subject, payload=None):
    return {
        "id": id_,
        "user_id": 1,
        "override_type": override_type,
        "subject": subject,
        "payload": payload,
        "status": "active",
        "source_rec_id": None,
        "created_at": None,
        "last_applied_run": None,
        "last_applied_at": None,
        "apply_count": 0,
    }


# ── No-op baseline ───────────────────────────────────────────────────────


def test_no_overrides_is_noop():
    labels = np.array([0, 0, 1])
    cluster_names = {0: "A", 1: "B"}
    result = apply_dq_overrides(labels, cluster_names, {}, _pages([1, 2, 3]), None, [])
    assert result["applied_override_ids"] == []
    assert result["cluster_names"] == {0: "A", 1: "B"}
    assert result["stats"]["dormant"] == 0
    assert list(result["labels"]) == [0, 0, 1]


# ── pin_label ─────────────────────────────────────────────────────────────


def test_pin_label_happy():
    labels = np.array([0, 0, 1])
    cluster_names = {0: "Old Name", 1: "Other"}
    identity_matches = {0: {"stable_id": "s0", "name": "Old Name", "jaccard": 0.9}}
    overrides = [_override(1, "pin_label", {"stable_id": "s0"}, {"label": "Pinned Name"})]

    result = apply_dq_overrides(
        labels, cluster_names, identity_matches, _pages([1, 2, 3]), None, overrides
    )

    assert result["applied_override_ids"] == [1]
    assert result["cluster_names"][0] == "Pinned Name"
    assert result["stats"]["pin_label"] == {"applied": 1, "dormant": 0}
    assert result["stats"]["dormant"] == 0


def test_pin_label_dormant_when_stable_id_unmatched():
    labels = np.array([0, 0, 1])
    cluster_names = {0: "Old Name", 1: "Other"}
    identity_matches = {0: {"stable_id": "s0", "name": "Old Name", "jaccard": 0.9}}
    overrides = [_override(1, "pin_label", {"stable_id": "s-gone"}, {"label": "Pinned Name"})]

    result = apply_dq_overrides(
        labels, cluster_names, identity_matches, _pages([1, 2, 3]), None, overrides
    )

    assert result["applied_override_ids"] == []
    assert result["cluster_names"] == {0: "Old Name", 1: "Other"}
    assert result["stats"]["pin_label"] == {"applied": 0, "dormant": 1}
    assert result["stats"]["dormant"] == 1


def test_pin_label_malformed_payload_is_dormant_not_crash():
    labels = np.array([0])
    cluster_names = {0: "Old Name"}
    identity_matches = {0: {"stable_id": "s0", "name": "Old Name", "jaccard": 0.9}}
    # payload missing "label" -- must not raise
    overrides = [_override(1, "pin_label", {"stable_id": "s0"}, {})]

    result = apply_dq_overrides(
        labels, cluster_names, identity_matches, _pages([1]), None, overrides
    )

    assert result["applied_override_ids"] == []
    assert result["stats"]["pin_label"]["dormant"] == 1
    assert result["cluster_names"] == {0: "Old Name"}


# ── exclude_from_cluster ─────────────────────────────────────────────────


def test_exclude_from_cluster_happy():
    # cluster 0 has content ids 1,2,3; cluster 1 has content id 4
    labels = np.array([0, 0, 0, 1])
    pages = _pages([1, 2, 3, 4])
    identity_matches = {0: {"stable_id": "s0", "name": "A", "jaccard": 0.9}}
    overrides = [
        _override(1, "exclude_from_cluster", {"stable_id": "s0"}, {"page_content_ids": [2]})
    ]

    result = apply_dq_overrides(
        labels, {0: "A", 1: "B"}, identity_matches, pages, None, overrides
    )

    assert result["applied_override_ids"] == [1]
    assert list(result["labels"]) == [0, -1, 0, 1]
    assert result["stats"]["exclude_from_cluster"] == {"applied": 1, "dormant": 0}


def test_exclude_from_cluster_only_touches_matched_cluster_rows():
    # content id 4 lives in cluster 1, NOT the matched cluster 0 -- listing
    # it in the exclude payload must not touch cluster 1's membership.
    labels = np.array([0, 0, 1])
    pages = _pages([1, 2, 4])
    identity_matches = {0: {"stable_id": "s0", "name": "A", "jaccard": 0.9}}
    overrides = [
        _override(
            1, "exclude_from_cluster", {"stable_id": "s0"}, {"page_content_ids": [2, 4]}
        )
    ]

    result = apply_dq_overrides(labels, {0: "A", 1: "B"}, identity_matches, pages, None, overrides)

    # content id 2 (in cluster 0, the matched one) is excluded; content id 4
    # (in cluster 1, unmatched) is untouched despite being listed.
    assert list(result["labels"]) == [0, -1, 1]


def test_exclude_from_cluster_dormant_when_unmatched():
    labels = np.array([0, 0, 1])
    pages = _pages([1, 2, 4])
    overrides = [
        _override(1, "exclude_from_cluster", {"stable_id": "s-gone"}, {"page_content_ids": [2]})
    ]

    result = apply_dq_overrides(labels, {0: "A", 1: "B"}, {}, pages, None, overrides)

    assert result["applied_override_ids"] == []
    assert list(result["labels"]) == [0, 0, 1]
    assert result["stats"]["exclude_from_cluster"]["dormant"] == 1


# ── never_cocluster ───────────────────────────────────────────────────────


def test_never_cocluster_evicts_lower_probability():
    # both pages in cluster 0; page at idx0 (content 10) has higher prob
    labels = np.array([0, 0])
    pages = _pages([10, 20])
    probabilities = np.array([0.9, 0.3])
    overrides = [
        _override(
            1, "never_cocluster", {"page_content_id_a": 10, "page_content_id_b": 20}
        )
    ]

    result = apply_dq_overrides(labels, {0: "A"}, {}, pages, probabilities, overrides)

    assert result["applied_override_ids"] == [1]
    # the lower-probability member (content id 20, idx 1) is evicted
    assert list(result["labels"]) == [0, -1]
    assert result["stats"]["never_cocluster"] == {"applied": 1, "dormant": 0}


def test_never_cocluster_no_probabilities_evicts_higher_content_id():
    labels = np.array([0, 0])
    pages = _pages([10, 20])
    overrides = [
        _override(
            1, "never_cocluster", {"page_content_id_a": 10, "page_content_id_b": 20}
        )
    ]

    result = apply_dq_overrides(labels, {0: "A"}, {}, pages, None, overrides)

    # no probabilities -- fallback evicts the higher page_content_id (20, idx 1)
    assert list(result["labels"]) == [0, -1]


def test_never_cocluster_tied_probabilities_evicts_higher_content_id():
    labels = np.array([0, 0])
    pages = _pages([10, 20])
    probabilities = np.array([0.5, 0.5])
    overrides = [
        _override(
            1, "never_cocluster", {"page_content_id_a": 10, "page_content_id_b": 20}
        )
    ]

    result = apply_dq_overrides(labels, {0: "A"}, {}, pages, probabilities, overrides)

    # tie -- fallback evicts the higher page_content_id (20, idx 1)
    assert list(result["labels"]) == [0, -1]


def test_never_cocluster_dormant_when_not_currently_coclustered():
    labels = np.array([0, 1])  # different clusters already
    pages = _pages([10, 20])
    overrides = [
        _override(
            1, "never_cocluster", {"page_content_id_a": 10, "page_content_id_b": 20}
        )
    ]

    result = apply_dq_overrides(labels, {0: "A", 1: "B"}, {}, pages, None, overrides)

    assert result["applied_override_ids"] == []
    assert list(result["labels"]) == [0, 1]
    assert result["stats"]["never_cocluster"]["dormant"] == 1


def test_never_cocluster_dormant_when_both_noise():
    labels = np.array([-1, -1])
    pages = _pages([10, 20])
    overrides = [
        _override(
            1, "never_cocluster", {"page_content_id_a": 10, "page_content_id_b": 20}
        )
    ]

    result = apply_dq_overrides(labels, {}, {}, pages, None, overrides)

    assert result["applied_override_ids"] == []
    assert result["stats"]["never_cocluster"]["dormant"] == 1


def test_never_cocluster_dormant_when_content_id_missing():
    labels = np.array([0, 0])
    pages = _pages([10, 20])  # content id 99 doesn't exist
    overrides = [
        _override(
            1, "never_cocluster", {"page_content_id_a": 10, "page_content_id_b": 99}
        )
    ]

    result = apply_dq_overrides(labels, {0: "A"}, {}, pages, None, overrides)

    assert result["applied_override_ids"] == []
    assert result["stats"]["never_cocluster"]["dormant"] == 1


# ── merge_clusters ────────────────────────────────────────────────────────


def test_merge_clusters_happy_survivor_is_highest_jaccard():
    # cluster 0 (jaccard 0.9) and cluster 1 (jaccard 0.5) merge -- 0 survives
    labels = np.array([0, 0, 1, 1])
    pages = _pages([1, 2, 3, 4])
    cluster_names = {0: "A", 1: "B"}
    identity_matches = {
        0: {"stable_id": "s0", "name": "A", "jaccard": 0.9},
        1: {"stable_id": "s1", "name": "B", "jaccard": 0.5},
    }
    overrides = [_override(1, "merge_clusters", {"stable_ids": ["s1", "s0"]})]

    result = apply_dq_overrides(labels, cluster_names, identity_matches, pages, None, overrides)

    assert result["applied_override_ids"] == [1]
    assert list(result["labels"]) == [0, 0, 0, 0]
    assert result["cluster_names"] == {0: "A"}  # absorbed cid 1 dropped
    assert result["stats"]["merge_clusters"] == {"applied": 1, "dormant": 0}


def test_merge_clusters_dormant_when_fewer_than_two_matched():
    labels = np.array([0, 0, 1, 1])
    pages = _pages([1, 2, 3, 4])
    cluster_names = {0: "A", 1: "B"}
    identity_matches = {0: {"stable_id": "s0", "name": "A", "jaccard": 0.9}}
    overrides = [_override(1, "merge_clusters", {"stable_ids": ["s1", "s0"]})]  # s1 unmatched

    result = apply_dq_overrides(labels, cluster_names, identity_matches, pages, None, overrides)

    assert result["applied_override_ids"] == []
    assert list(result["labels"]) == [0, 0, 1, 1]
    assert result["cluster_names"] == {0: "A", 1: "B"}
    assert result["stats"]["merge_clusters"]["dormant"] == 1


# ── merge_clusters: content fallback (durability rider, Task 5) ─────────
#
# Merging destroys the stable_ids a merge override is keyed on (the
# absorbed cid's identity doesn't carry forward), so a re-approved merge
# override would go dormant forever after one application. When stable_id
# matching yields <2 clusters, subject.member_content_ids (union of the
# subject clusters' member page_content_ids, captured at approve time --
# see dq_apply._apply_merge_clusters) lets a cluster whose *current*
# membership overlaps >=50% with that content set count as matched too.


def test_merge_clusters_content_fallback_merges_when_stable_ids_all_miss():
    # cluster 0: content 1,2,3 (size 3) -- fully covered by the subject's
    # content set -> overlap 3/3.
    # cluster 1: content 4,5 (size 2) -- fully covered -> overlap 2/2.
    # cluster 2: content 6,7,8 (size 3) -- only content 6 covered -> 1/3,
    # below the 50% threshold, must stay untouched.
    labels = np.array([0, 0, 0, 1, 1, 2, 2, 2])
    pages = _pages([1, 2, 3, 4, 5, 6, 7, 8])
    cluster_names = {0: "A", 1: "B", 2: "C"}
    identity_matches = {}  # neither stable_id resolves this run
    overrides = [
        _override(
            1,
            "merge_clusters",
            {
                "stable_ids": ["s-gone-a", "s-gone-b"],
                "member_content_ids": [1, 2, 3, 4, 5, 6],
            },
        )
    ]

    result = apply_dq_overrides(
        labels, cluster_names, identity_matches, pages, None, overrides
    )

    assert result["applied_override_ids"] == [1]
    # survivor = larger overlap count (cluster 0's overlap of 3 beats
    # cluster 1's overlap of 2); cluster 2 (below threshold) is untouched.
    assert list(result["labels"]) == [0, 0, 0, 0, 0, 2, 2, 2]
    assert result["cluster_names"] == {0: "A", 2: "C"}  # absorbed cid 1 dropped
    assert result["stats"]["merge_clusters"] == {"applied": 1, "dormant": 0}


def test_merge_clusters_content_fallback_survivor_is_larger_overlap_count():
    # Both candidate clusters clear the 50% bar, but cluster 1's overlap
    # count (3) is larger than cluster 0's (2) -- cluster 1 must survive
    # even though it has the lower cid.
    labels = np.array([0, 0, 1, 1, 1])
    pages = _pages([1, 2, 3, 4, 5])
    cluster_names = {0: "A", 1: "B"}
    identity_matches = {}
    overrides = [
        _override(
            1,
            "merge_clusters",
            {"stable_ids": ["s-gone"], "member_content_ids": [1, 2, 3, 4, 5]},
        )
    ]

    result = apply_dq_overrides(
        labels, cluster_names, identity_matches, pages, None, overrides
    )

    assert result["applied_override_ids"] == [1]
    assert list(result["labels"]) == [1, 1, 1, 1, 1]
    assert result["cluster_names"] == {1: "B"}  # absorbed cid 0 dropped
    assert result["stats"]["merge_clusters"] == {"applied": 1, "dormant": 0}


def test_merge_clusters_content_fallback_ties_survivor_is_lowest_cid():
    # Equal overlap counts (2 vs 2) -- tie broken by lowest cid (0).
    labels = np.array([0, 0, 1, 1])
    pages = _pages([1, 2, 3, 4])
    cluster_names = {0: "A", 1: "B"}
    identity_matches = {}
    overrides = [
        _override(
            1,
            "merge_clusters",
            {"stable_ids": ["s-gone"], "member_content_ids": [1, 2, 3, 4]},
        )
    ]

    result = apply_dq_overrides(
        labels, cluster_names, identity_matches, pages, None, overrides
    )

    assert result["applied_override_ids"] == [1]
    assert list(result["labels"]) == [0, 0, 0, 0]
    assert result["cluster_names"] == {0: "A"}  # absorbed cid 1 (higher cid) dropped
    assert result["stats"]["merge_clusters"] == {"applied": 1, "dormant": 0}


def test_merge_clusters_content_fallback_dormant_when_overlap_below_threshold_everywhere():
    # cluster 0: content 1,2,3,4 (size 4), only content 1 covered -> 1/4 = 25%
    # cluster 1: content 5,6,7 (size 3), only content 5 covered -> 1/3 = 33%
    # Neither clears 50% -- content fallback yields <2 matches -> dormant,
    # same as the pre-fallback "unmatched stable_id" outcome.
    labels = np.array([0, 0, 0, 0, 1, 1, 1])
    pages = _pages([1, 2, 3, 4, 5, 6, 7])
    cluster_names = {0: "A", 1: "B"}
    identity_matches = {}
    overrides = [
        _override(
            1,
            "merge_clusters",
            {"stable_ids": ["s-gone-a", "s-gone-b"], "member_content_ids": [1, 5]},
        )
    ]

    result = apply_dq_overrides(
        labels, cluster_names, identity_matches, pages, None, overrides
    )

    assert result["applied_override_ids"] == []
    assert list(result["labels"]) == [0, 0, 0, 0, 1, 1, 1]
    assert result["cluster_names"] == {0: "A", 1: "B"}
    assert result["stats"]["merge_clusters"] == {"applied": 0, "dormant": 1}
    assert result["stats"]["dormant"] == 1


def test_merge_clusters_old_format_subject_without_member_content_ids_unchanged():
    """Old-format subject (no member_content_ids key at all) with <2 stable
    matches must behave byte-identically to pre-Task-5 behavior: dormant,
    no content fallback attempted (there's nothing to fall back on)."""
    labels = np.array([0, 0, 1, 1])
    pages = _pages([1, 2, 3, 4])
    cluster_names = {0: "A", 1: "B"}
    identity_matches = {0: {"stable_id": "s0", "name": "A", "jaccard": 0.9}}
    overrides = [_override(1, "merge_clusters", {"stable_ids": ["s1", "s0"]})]  # s1 unmatched

    result = apply_dq_overrides(
        labels, cluster_names, identity_matches, pages, None, overrides
    )

    assert result["applied_override_ids"] == []
    assert list(result["labels"]) == [0, 0, 1, 1]
    assert result["cluster_names"] == {0: "A", 1: "B"}
    assert result["stats"]["merge_clusters"] == {"applied": 0, "dormant": 1}
    assert result["stats"]["dormant"] == 1


def test_merge_naming_survival_with_pin_interaction():
    """A pin_label targeting the merge survivor's stable_id wins, regardless
    of override list order -- pin_label writes cluster_names by cid via
    identity_matches (untouched by the merge), and merge only drops the
    ABSORBED cid's cluster_names entry."""
    labels = np.array([0, 0, 1, 1])
    pages = _pages([1, 2, 3, 4])
    cluster_names = {0: "A", 1: "B"}
    identity_matches = {
        0: {"stable_id": "s0", "name": "A", "jaccard": 0.9},
        1: {"stable_id": "s1", "name": "B", "jaccard": 0.5},
    }
    overrides = [
        _override(1, "merge_clusters", {"stable_ids": ["s1", "s0"]}),
        _override(2, "pin_label", {"stable_id": "s0"}, {"label": "Merged & Pinned"}),
    ]

    result = apply_dq_overrides(labels, cluster_names, identity_matches, pages, None, overrides)

    assert result["cluster_names"] == {0: "Merged & Pinned"}
    assert list(result["labels"]) == [0, 0, 0, 0]
    assert set(result["applied_override_ids"]) == {1, 2}

    # order reversed -- same outcome
    labels2 = np.array([0, 0, 1, 1])
    cluster_names2 = {0: "A", 1: "B"}
    result2 = apply_dq_overrides(
        labels2,
        cluster_names2,
        identity_matches,
        pages,
        None,
        list(reversed(overrides)),
    )
    assert result2["cluster_names"] == {0: "Merged & Pinned"}
    assert list(result2["labels"]) == [0, 0, 0, 0]


# ── unknown type / stats+applied-ids correctness ────────────────────────


def test_unknown_override_type_ignored_without_crash():
    labels = np.array([0])
    overrides = [_override(1, "some_future_type", {})]

    result = apply_dq_overrides(labels, {0: "A"}, {}, _pages([1]), None, overrides)

    assert result["applied_override_ids"] == []
    assert result["stats"]["dormant"] == 0  # never bumped -- not a recognized type


def test_mixed_batch_stats_and_applied_ids_correctness():
    labels = np.array([0, 0, 0, 1, 1])
    pages = _pages([1, 2, 3, 4, 5])
    cluster_names = {0: "A", 1: "B"}
    identity_matches = {
        0: {"stable_id": "s0", "name": "A", "jaccard": 0.9},
        1: {"stable_id": "s1", "name": "B", "jaccard": 0.5},
    }
    overrides = [
        _override(10, "pin_label", {"stable_id": "s0"}, {"label": "A Pinned"}),
        _override(11, "pin_label", {"stable_id": "s-gone"}, {"label": "Never"}),
        _override(12, "exclude_from_cluster", {"stable_id": "s0"}, {"page_content_ids": [2]}),
        _override(
            13,
            "never_cocluster",
            {"page_content_id_a": 4, "page_content_id_b": 5},
        ),
        _override(14, "merge_clusters", {"stable_ids": ["s0"]}),  # only 1 matched -> dormant
    ]

    result = apply_dq_overrides(
        labels, cluster_names, identity_matches, pages, None, overrides
    )

    assert result["applied_override_ids"] == [10, 12, 13]
    assert result["stats"] == {
        "pin_label": {"applied": 1, "dormant": 1},
        "exclude_from_cluster": {"applied": 1, "dormant": 0},
        "never_cocluster": {"applied": 1, "dormant": 0},
        "merge_clusters": {"applied": 0, "dormant": 1},
        "dormant": 2,
    }
    assert result["cluster_names"][0] == "A Pinned"
    assert list(result["labels"]) == [0, -1, 0, 1, -1]
