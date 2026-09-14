"""Unit tests for increment 3 of the clustering rethink: hybrid group discovery,
topic mapping, and interest tiers (backend/services/supercluster_discovery.py).
See the 2026-07-08 clustering-supercluster-rethink plan (private),
plan-increment-3.md.
"""

from datetime import datetime, timedelta

import numpy as np

from backend.services import supercluster_discovery as sd


def _unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def _three_family_centroids():
    """Nine centroids in three tight directional families (unit vectors)."""
    rng = np.random.default_rng(11)
    families = np.eye(3, 32) * 10
    rows = []
    for f in families:
        for _ in range(3):
            rows.append(_unit(f + rng.normal(0, 0.2, 32)))
    return np.vstack(rows)


# ── discover_groups ─────────────────────────────────────────────────────


def test_discover_groups_finds_families_and_is_deterministic():
    cents = _three_family_centroids()
    labels = sd.discover_groups(cents, distance_threshold=0.5)
    # three families of three, grouped exactly
    assert len(set(labels)) == 3
    for start in (0, 3, 6):
        assert len(set(labels[start : start + 3])) == 1
    # deterministic + first-appearance ordering
    again = sd.discover_groups(cents, distance_threshold=0.5)
    assert (labels == again).all()
    assert labels[0] == 0


def test_discover_groups_singletons_and_edges():
    # far-apart centroids under a tiny threshold: every cluster its own group
    cents = np.eye(4, 16)
    labels = sd.discover_groups(cents, distance_threshold=0.05)
    assert len(set(labels)) == 4
    # edge cases
    assert len(sd.discover_groups(np.empty((0, 8)), 0.5)) == 0
    assert list(sd.discover_groups(np.ones((1, 8)), 0.5)) == [0]


def test_subdivide_groups_splits_only_selected():
    group_labels = np.array([0, 0, 0, 1, 1])
    fine_labels = np.array([5, 5, 6, 7, 8])  # group 0 spans 2 fine; group 1 spans 2
    out = sd.subdivide_groups(group_labels, fine_labels, {0})
    # group 0 split into two, group 1 untouched (still one group)
    assert len(set(out)) == 3
    assert out[0] == out[1] != out[2]
    assert out[3] == out[4]
    # selected group whose members share one fine label stays whole
    same = sd.subdivide_groups(np.array([0, 0]), np.array([3, 3]), {0})
    assert len(set(same)) == 1


def test_group_centroids_are_unit_norm():
    cents = _three_family_centroids()
    labels = sd.discover_groups(cents, distance_threshold=0.5)
    gc = sd.compute_group_centroids(cents, labels)
    assert gc.shape == (3, 32)
    np.testing.assert_allclose(np.linalg.norm(gc, axis=1), 1.0, atol=1e-9)


# ── map_topics_to_groups ────────────────────────────────────────────────


def test_topic_mapping_threshold_and_umbrella():
    # two orthogonal groups; keyword A aligned with group 0, keyword B with
    # nothing (below threshold) — group 1 stays unlabeled (suggested topic)
    group_cents = np.eye(2, 8)
    kw_vecs = np.vstack([_unit([1, 0.2, 0, 0, 0, 0, 0, 0]), _unit(np.ones(8))])
    mapping = sd.map_topics_to_groups(
        group_cents, ["volcanoes", "misc"], kw_vecs, match_threshold=0.9
    )
    assert mapping[0]["topic"] == "volcanoes"
    assert mapping[1]["topic"] is None
    assert mapping[1]["runner_up"] is not None  # near-misses recorded

    # umbrella: one keyword may label multiple groups
    near = np.vstack([_unit([1, 0.1, 0, 0]), _unit([1, -0.1, 0, 0])])
    kw = _unit([1, 0, 0, 0]).reshape(1, -1)
    both = sd.map_topics_to_groups(near, ["science"], kw, match_threshold=0.5)
    assert both[0]["topic"] == "science" and both[1]["topic"] == "science"


def test_topic_mapping_no_keywords():
    mapping = sd.map_topics_to_groups(np.eye(2, 4), [], np.empty((0, 0)), 0.3)
    assert mapping[0]["topic"] is None and mapping[1]["topic"] is None


# ── aggregate_visit_evidence ────────────────────────────────────────────


def _visit(vid, cid, ts, dwell=30):
    return {"visit_id": vid, "page_content_id": cid, "visited_at": ts,
            "dwell_seconds": dwell}


def test_evidence_recurrence_and_revisits():
    t0 = datetime(2026, 3, 2, 12, 0)
    rows = [
        _visit(1, 10, t0),
        _visit(2, 10, t0 + timedelta(days=21)),   # same URL revisited, week 3
        _visit(3, 11, t0 + timedelta(days=42)),   # week 7
        _visit(3, 11, t0 + timedelta(days=42)),   # duplicate row (shared content id)
    ]
    ev = sd.aggregate_visit_evidence(rows)
    assert ev["n_visits"] == 3            # visit_id-deduped
    assert ev["n_days"] == 3 and ev["n_weeks"] == 3
    assert ev["span_days"] == 42
    assert ev["re_url_count"] == 1        # content 10 visited twice


def test_evidence_dwell_winsorized_and_empty():
    t0 = datetime(2026, 3, 2, 12, 0)
    ev = sd.aggregate_visit_evidence(
        [_visit(1, 10, t0, dwell=4), _visit(2, 11, t0, dwell=99999)]
    )
    assert ev["dwell_p90"] <= sd.DWELL_CAP_SECONDS
    empty = sd.aggregate_visit_evidence([])
    assert empty["n_visits"] == 0 and empty["span_days"] == 0


# ── interest_tier ───────────────────────────────────────────────────────


def test_tiers_declared_dominates():
    binge_shape = {"n_weeks": 1, "n_days": 1, "span_days": 0}
    assert sd.interest_tier(binge_shape, n_pages=30, declared=True) == "declared"


def test_tiers_recurrent_binge_casual():
    assert sd.interest_tier(
        {"n_weeks": 4, "n_days": 6, "span_days": 90}, 5, False) == "recurrent"
    # 2 weeks over a long span also counts (volcanology shape)
    assert sd.interest_tier(
        {"n_weeks": 2, "n_days": 2, "span_days": 65}, 9, False) == "recurrent"
    # recurrence without substance is casual (pass feedback 2026-07-10:
    # WWII 4p / Washington-cities 3p shapes)
    assert sd.interest_tier(
        {"n_weeks": 3, "n_days": 3, "span_days": 102}, 4, False) == "casual"
    assert sd.interest_tier(
        {"n_weeks": 2, "n_days": 2, "span_days": 76}, 3, False) == "casual"
    # many pages, one sitting (sveltekit shape)
    assert sd.interest_tier(
        {"n_weeks": 1, "n_days": 1, "span_days": 0}, 31, False) == "binge"
    # few pages, one sitting: casual, not binge
    assert sd.interest_tier(
        {"n_weeks": 1, "n_days": 1, "span_days": 0}, 3, False) == "casual"
    # 2 weeks but short span: casual
    assert sd.interest_tier(
        {"n_weeks": 2, "n_days": 2, "span_days": 8}, 5, False) == "casual"


# ── embed_keywords routing ──────────────────────────────────────────────


def test_embed_keywords_sbert_route(monkeypatch):
    """Default (non text-embedding-*) model routes to local SBERT, unit-norm."""
    from backend.config.settings import settings

    class FakeModel:
        def encode(self, texts):
            return np.arange(1, len(texts) * 4 + 1, dtype=float).reshape(len(texts), 4)

    monkeypatch.setattr(settings, "clustering_embedding_model", "all-MiniLM-L6-v2")
    monkeypatch.setattr(
        "backend.services.sbert_loader.get_sbert_model", lambda: FakeModel()
    )
    vecs = sd.embed_keywords(["a", "b"])
    assert vecs.shape == (2, 4)
    np.testing.assert_allclose(np.linalg.norm(vecs, axis=1), 1.0, atol=1e-9)
    assert sd.embed_keywords([]).size == 0


# ── refine_by_cluster (cluster-level carve-outs, 2026-07-14 spec) ────────


def test_refine_claims_strong_cluster_from_suggested_group():
    # cluster 0 in suggested group (topic None), sim 0.48 to "ml" -> claim
    sims = np.array([[0.48, 0.10]])
    claims = sd.refine_by_cluster(
        np.array([0]), {0: None}, ["ml", "art"], sims,
        match_threshold=0.30, margin=0.05,
    )
    assert claims == {0: {"keyword": "ml", "similarity": 0.48}}


def test_refine_ignores_below_threshold_and_own_keyword():
    sims = np.array([
        [0.29, 0.10],   # cluster 0: best sim under threshold -> no claim
        [0.55, 0.20],   # cluster 1: argmax IS its group's topic -> no claim
    ])
    claims = sd.refine_by_cluster(
        np.array([0, 1]), {0: None, 1: "ml"}, ["ml", "art"], sims,
        match_threshold=0.30, margin=0.05,
    )
    assert claims == {}


def test_refine_margin_gates_claims_from_keyword_groups():
    # both clusters in a group owned by "volcanoes"; "astronomy" claims only
    # when it beats the cluster's own-topic sim by >= margin
    sims = np.array([
        [0.41, 0.20],   # astronomy 0.41 vs volcanoes 0.20 -> claim
        [0.33, 0.30],   # astronomy 0.33 vs volcanoes 0.30 + 0.05 -> no claim
    ])
    claims = sd.refine_by_cluster(
        np.array([0, 0]), {0: "volcanoes"}, ["astronomy", "volcanoes"], sims,
        match_threshold=0.30, margin=0.05,
    )
    assert claims == {0: {"keyword": "astronomy", "similarity": 0.41}}


def test_refine_empty_inputs():
    assert sd.refine_by_cluster(
        np.empty(0, dtype=int), {}, [], np.empty((0, 0)), 0.30, 0.05
    ) == {}
    assert sd.refine_by_cluster(
        np.array([0]), {0: None}, [], np.empty((1, 0)), 0.30, 0.05
    ) == {}


# ── keyword_sim_matrix (depth-1 expansion scoring) ───────────────────────


def test_keyword_sim_matrix_reduces_to_legacy_without_terms():
    targets = np.vstack([_unit([1, 0, 0]), _unit([0, 1, 0])])
    kw_vecs = np.vstack([_unit([1, 1, 0]), _unit([0, 0, 1])])
    term_vectors = [kw_vecs[0:1], kw_vecs[1:2]]
    out = sd.keyword_sim_matrix(targets, term_vectors)
    assert np.allclose(out, targets @ kw_vecs.T)


def test_keyword_sim_matrix_takes_max_over_terms():
    targets = _unit([1, 0, 0]).reshape(1, -1)
    # keyword itself orthogonal to target; expansion term aligned
    term_vectors = [np.vstack([_unit([0, 1, 0]), _unit([1, 0.1, 0])])]
    out = sd.keyword_sim_matrix(targets, term_vectors)
    assert out.shape == (1, 1) and out[0, 0] > 0.95


def test_keyword_sim_matrix_empty():
    assert sd.keyword_sim_matrix(np.empty((0, 3)), []).shape == (0, 0)
