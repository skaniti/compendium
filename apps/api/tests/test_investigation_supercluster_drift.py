"""Integration tests for the S4 supercluster-drift investigator.

Requires Docker PostgreSQL running:
  docker compose up -d
  python -m backend.db.migrate
  pytest tests/test_investigation_supercluster_drift.py -v

SBERT is mocked for determinism (real embeddings drift across model
versions and would couple this test to the actual MiniLM weights).

Tier 2 (2026-07-19): the per-candidate ``rival_hypothesis_guard`` retired.
S4 now emits every threshold candidate unconditionally and performs NO LLM
calls of any kind. Findings also carry a top-level ``children`` list (the
batched upstream adjudicator's evidence).
"""

import math
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(),
    reason="Test PostgreSQL not reachable -- run `docker compose up -d` and migrate",
)

from backend.db import (
    cluster_repo,
    recluster_repo,
    user_repo,
)
from backend.db.connection import get_conn
from backend.services.dq_investigations import supercluster_drift


# -- Fixtures --------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_tables():
    """Truncate relevant tables before each test for isolation.

    S4 only touches clusters + recluster_runs + users. CASCADE handles
    page_clusters / cluster_edges if anything dangling exists.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            TRUNCATE annotations, page_embeddings, page_clusters, clusters,
                     recluster_runs, pages, page_content, captures, users
            CASCADE
            """
        )
    yield


def _make_user(email="s4_test@example.com"):
    return user_repo.create_user(email=email, name="S4 Test User")


def _make_completed_run(user_id):
    """Start + complete a recluster_run; return run id."""
    run_id = recluster_repo.start_run(user_id)
    recluster_repo.complete_run(
        run_id,
        cluster_count=0,
        noise_count=0,
        naming_cost=0.0,
        elapsed_seconds=0.1,
    )
    return run_id


def _vec(idx_to_value: dict[int, float]) -> np.ndarray:
    """Build a 384-dim numpy vector from sparse {index: value} pairs.

    Cosine similarity between two such vectors is fully determined by the
    chosen indices and values, so tests can target an exact similarity
    without depending on a real SBERT model.
    """
    v = np.zeros(384, dtype=float)
    for i, val in idx_to_value.items():
        v[i] = val
    return v


def _make_mock_sbert(label_to_vec: dict[str, np.ndarray]):
    """Mock SBERT model that encodes inputs by lookup.

    Handles both single-string and list-of-strings inputs because the
    investigator may call either form (single string for the supercluster
    keyword, list for batch-encoding child names).
    """
    mock = MagicMock()

    def encode_fn(input_, **kwargs):
        if isinstance(input_, str):
            return label_to_vec[input_]
        return np.array([label_to_vec[s] for s in input_])

    mock.encode = MagicMock(side_effect=encode_fn)
    return mock


def _seed_supercluster(
    user_id: int,
    run_id: int,
    super_label: str,
    child_names: list[str],
) -> tuple[str, list[int]]:
    """Insert child clusters and assign them to the named supercluster.

    Returns (super_label, [child_cluster_ids]) for convenience.
    """
    cluster_specs = [
        {"cluster_slug": f"{super_label.lower().replace(' ', '_')}_child_{i}",
         "cluster_name": name}
        for i, name in enumerate(child_names)
    ]
    slug_map = cluster_repo.save_clusters(user_id, run_id, cluster_specs)
    child_ids = [slug_map[spec["cluster_slug"]] for spec in cluster_specs]
    cluster_repo.update_super_clusters(
        user_id,
        {cid: super_label for cid in child_ids},
    )
    return super_label, child_ids


def _drifting_supercluster_label_map(super_label: str, child_names: list[str]) -> dict:
    """Supercluster on index 0, each child on a unique non-overlapping
    index -- centroid is fully orthogonal to the supercluster label, so
    cos sim = 0 and distance = 1.0 (well above the 0.55 threshold)."""
    label_to_vec = {super_label: _vec({0: 1.0})}
    for i, name in enumerate(child_names):
        label_to_vec[name] = _vec({100 + i: 1.0})
    return label_to_vec


# -- Tests -----------------------------------------------------------------


@patch("backend.services.dq_investigations.supercluster_drift.get_sbert_model")
def test_coherent_supercluster_emits_no_finding(mock_get_sbert):
    """Supercluster whose child labels cluster near its own embedding has
    distance < threshold => no candidate, no finding."""
    super_label = "Quantum Computing"
    child_names = ["Quantum Algorithms", "Qubits", "Quantum Cryptography", "Quantum Hardware"]
    # All vectors aligned on index 0 => centroid is also on index 0 =>
    # cosine distance = 0.0 < 0.4.
    label_to_vec = {super_label: _vec({0: 1.0})}
    for name in child_names:
        label_to_vec[name] = _vec({0: 1.0})
    mock_get_sbert.return_value = _make_mock_sbert(label_to_vec)

    user = _make_user()
    uid = user["id"]
    run_id = _make_completed_run(uid)
    _seed_supercluster(uid, run_id, super_label, child_names)

    findings = supercluster_drift.run(uid)

    assert findings == []


@patch("backend.services.dq_investigations.supercluster_drift.get_sbert_model")
def test_drifting_supercluster_emits_finding(mock_get_sbert):
    """Supercluster label orthogonal to all child embeddings => distance = 1.0
    > 0.55 threshold; no guard to suppress it => one finding (Tier 2 removed
    the per-candidate rival-hypothesis check)."""
    super_label = "Quantum Computing"
    child_names = ["Italian Recipes", "Tax Forms", "Knitting Patterns", "Garden Tips"]
    mock_get_sbert.return_value = _make_mock_sbert(
        _drifting_supercluster_label_map(super_label, child_names)
    )

    user = _make_user()
    uid = user["id"]
    run_id = _make_completed_run(uid)
    _, child_ids = _seed_supercluster(uid, run_id, super_label, child_names)

    findings = supercluster_drift.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["tag"] == "core"
    assert f["scope_citation"] == "S4"
    assert f["issue_type"] == "supercluster_drift"
    assert f["entity_type"] == "supercluster"
    assert f["entity_id"] == super_label
    assert f["severity"] == "warning"
    assert f["rank"] == 1
    rec = f["recommendation"]
    assert rec["action_type"] == "flag_for_review"
    assert rec["self_classification"] == "judgment"
    # affected_entity_ids = [supercluster_keyword] + drifting child ids
    assert rec["affected_entity_ids"][0] == super_label
    # Top divergent children should be reported (4 children, capped at 5).
    for cid in child_ids:
        assert cid in rec["affected_entity_ids"]
    # Headline names the supercluster + distance cue.
    assert super_label in rec["headline"]
    # Rationale lists divergent child names; no rival-hypothesis guard
    # reasoning tail exists anymore.
    rationale = rec["rationale"]
    for name in child_names:
        assert name in rationale
    assert "guard" not in rationale.lower()


@patch("backend.services.dq_investigations.supercluster_drift.get_sbert_model")
def test_previously_guard_suppressed_pattern_now_emits_finding(mock_get_sbert):
    """Tier 2 behavior change: a 'Curiosities Mix'-labeled drifting
    supercluster -- the exact shape the old rival_hypothesis_guard used to
    suppress as 'heterogeneity is intentional' -- now emits a finding
    unconditionally. That judgment call moved upstream to the batched
    adjudicator (backend/services/dq_adjudicator.py)."""
    super_label = "Curiosities Mix"
    child_names = ["Italian Recipes", "Tax Forms", "Knitting Patterns", "Garden Tips"]
    mock_get_sbert.return_value = _make_mock_sbert(
        _drifting_supercluster_label_map(super_label, child_names)
    )

    user = _make_user()
    uid = user["id"]
    run_id = _make_completed_run(uid)
    _seed_supercluster(uid, run_id, super_label, child_names)

    findings = supercluster_drift.run(uid)

    assert len(findings) == 1
    assert findings[0]["entity_id"] == super_label


@patch("backend.services.dq_investigations.supercluster_drift.get_sbert_model")
def test_distance_between_old_and_new_threshold_does_not_flag(mock_get_sbert):
    """Regression pin for the 2026-07-17 calibration (0.4 -> 0.55, recs
    82/160 'zoology' false positives). A supercluster at cosine distance
    0.45 -- which would have flagged under the old 0.4 threshold -- must
    NOT flag under the current 0.55 threshold."""
    assert supercluster_drift.DRIFT_DISTANCE_THRESHOLD == 0.55

    super_label = "Zoology"
    child_names = ["Ornithology", "Marine Biology", "Entomology"]

    # cosine similarity between label and each (identical) child = 0.55,
    # so distance = 1 - 0.55 = 0.45.
    sim = 0.55
    orth = math.sqrt(1 - sim * sim)
    label_to_vec = {super_label: _vec({0: 1.0})}
    child_vec = _vec({0: sim, 1: orth})
    for name in child_names:
        label_to_vec[name] = child_vec
    mock_get_sbert.return_value = _make_mock_sbert(label_to_vec)

    user = _make_user()
    uid = user["id"]
    run_id = _make_completed_run(uid)
    _seed_supercluster(uid, run_id, super_label, child_names)

    findings = supercluster_drift.run(uid)

    assert findings == []


@patch("backend.services.dq_investigations.supercluster_drift.get_sbert_model")
def test_supercluster_below_min_children_skipped(mock_get_sbert):
    """Supercluster with only 2 children (< MIN_CHILD_CLUSTERS=3) is skipped
    BEFORE SBERT is loaded."""
    super_label = "Sparse Topic"
    child_names = ["Child A", "Child B"]  # only 2 children
    label_to_vec = {super_label: _vec({0: 1.0})}
    for i, name in enumerate(child_names):
        label_to_vec[name] = _vec({100 + i: 1.0})
    mock_get_sbert.return_value = _make_mock_sbert(label_to_vec)

    user = _make_user()
    uid = user["id"]
    run_id = _make_completed_run(uid)
    _seed_supercluster(uid, run_id, super_label, child_names)

    findings = supercluster_drift.run(uid)

    assert findings == []
    # SBERT was never loaded for this supercluster (no other supercluster
    # in this test).
    mock_get_sbert.assert_not_called()


@patch("backend.services.dq_investigations.supercluster_drift.get_sbert_model")
def test_empty_user_returns_empty_list(mock_get_sbert):
    """User with no recluster_run yields []; SBERT is never even loaded."""
    user = _make_user(email="empty_s4@example.com")
    findings = supercluster_drift.run(user["id"])
    assert findings == []
    mock_get_sbert.assert_not_called()


@patch("backend.services.dq_investigations.supercluster_drift.get_sbert_model")
def test_clusters_without_super_cluster_ignored(mock_get_sbert):
    """Clusters with super_cluster IS NULL are ignored entirely (not part
    of any supercluster) -- verified by seeding a NULL-supercluster cluster
    alongside a coherent supercluster and confirming no finding emerges."""
    super_label = "Earth Science"
    child_names = ["Geology", "Meteorology", "Oceanography", "Volcanology"]
    label_to_vec = {super_label: _vec({0: 1.0})}
    for name in child_names:
        label_to_vec[name] = _vec({0: 1.0})  # all coherent
    mock_get_sbert.return_value = _make_mock_sbert(label_to_vec)

    user = _make_user()
    uid = user["id"]
    run_id = _make_completed_run(uid)
    _seed_supercluster(uid, run_id, super_label, child_names)

    # Add a few NULL-supercluster clusters that would have been "drift"
    # if they had been grouped under the wrong supercluster. They must
    # NOT influence the supercluster-level analysis.
    cluster_repo.save_clusters(
        uid,
        run_id,
        [
            {"cluster_slug": "ungrouped_a", "cluster_name": "Ungrouped A"},
            {"cluster_slug": "ungrouped_b", "cluster_name": "Ungrouped B"},
        ],
    )
    # Note: we deliberately don't call update_super_clusters on these,
    # so super_cluster stays NULL.

    findings = supercluster_drift.run(uid)

    assert findings == []


# -- Tier 2: zero-LLM + children evidence + generation snapshot ------------


@patch("backend.services.llm_service.LLMService.__init__")
@patch("backend.services.dq_investigations.supercluster_drift.get_sbert_model")
def test_no_llm_calls_anywhere_in_s4(mock_get_sbert, mock_llm_init):
    """S4 is zero-LLM post-Tier-2: even with LLMService.__init__ poisoned to
    raise, running S4 over a drifting supercluster must not raise and must
    still emit its finding -- nothing in this module's code path
    constructs an LLMService (the old rival_hypothesis_guard did)."""
    mock_llm_init.side_effect = RuntimeError("LLMService must not be constructed by S4")
    super_label = "Quantum Computing"
    child_names = ["Italian Recipes", "Tax Forms", "Knitting Patterns", "Garden Tips"]
    mock_get_sbert.return_value = _make_mock_sbert(
        _drifting_supercluster_label_map(super_label, child_names)
    )

    user = _make_user(email="no_llm_s4@example.com")
    uid = user["id"]
    run_id = _make_completed_run(uid)
    _seed_supercluster(uid, run_id, super_label, child_names)

    findings = supercluster_drift.run(uid)  # must not raise

    assert len(findings) == 1
    mock_llm_init.assert_not_called()


@patch("backend.services.dq_investigations.supercluster_drift.get_sbert_model")
def test_drifting_supercluster_carries_children_evidence(mock_get_sbert):
    """Finding carries a top-level `children` list -- every child cluster's
    label -- the batched upstream adjudicator's evidence (Tier 2, replaces
    the old guard's label + 5-outlier-prose input)."""
    super_label = "Quantum Computing"
    child_names = ["Italian Recipes", "Tax Forms", "Knitting Patterns", "Garden Tips"]
    mock_get_sbert.return_value = _make_mock_sbert(
        _drifting_supercluster_label_map(super_label, child_names)
    )

    user = _make_user(email="children_s4@example.com")
    uid = user["id"]
    run_id = _make_completed_run(uid)
    _seed_supercluster(uid, run_id, super_label, child_names)

    findings = supercluster_drift.run(uid)

    assert len(findings) == 1
    assert set(findings[0]["children"]) == set(child_names)


@patch("backend.services.dq_investigations.supercluster_drift.get_sbert_model")
def test_explicit_recluster_run_id_overrides_latest(mock_get_sbert):
    """An explicit recluster_run_id is used verbatim -- even when a newer
    (but here, supercluster-empty) generation exists -- and `None` resolves
    to the latest completed run (Task 8's generation-snapshot fix)."""
    super_label = "Quantum Computing"
    child_names = ["Italian Recipes", "Tax Forms", "Knitting Patterns", "Garden Tips"]
    mock_get_sbert.return_value = _make_mock_sbert(
        _drifting_supercluster_label_map(super_label, child_names)
    )

    user = _make_user(email="gen_snapshot_s4@example.com")
    uid = user["id"]

    # Older generation: seed the drifting supercluster here.
    older_run_id = _make_completed_run(uid)
    _seed_supercluster(uid, older_run_id, super_label, child_names)

    # Newer generation: completes later, no clusters at all.
    newer_run_id = _make_completed_run(uid)
    assert newer_run_id != older_run_id

    # Default (None) resolves to the latest completed run -- which has no
    # clusters, so no findings.
    findings_default = supercluster_drift.run(uid)
    assert findings_default == []

    # Explicit older run id is honored verbatim, ignoring that a newer
    # generation exists.
    findings_explicit = supercluster_drift.run(uid, recluster_run_id=older_run_id)
    assert len(findings_explicit) == 1
    assert findings_explicit[0]["entity_id"] == super_label
