"""Vocab repo unit tests + cosine-gate routing tests for dq_agent.

Cosine-gate tests use the real SBERT singleton, so the first test in a fresh
session pays a ~1.5s model-load cost; subsequent tests are fast since the
singleton is shared in-process.
"""

import uuid

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(), reason="Test PostgreSQL not reachable"
)

from backend.db import dq_vocab_repo, user_repo
from backend.db.connection import get_conn
from backend.services.dq_agent import _resolve_issue_type
from backend.services.sbert_loader import get_sbert_model


def _fresh_user(label: str) -> int:
    email = f"{label}-{uuid.uuid4().hex[:8]}@test.local"
    return user_repo.create_user(email=email, name="vocab_test")["id"]


def _embed(text: str) -> list[float]:
    return get_sbert_model().encode(text).tolist()


# ---------------------------------------------------------------- repo CRUD


def test_insert_proposal_idempotent_bumps_counter():
    uid = _fresh_user("counter")
    dq_vocab_repo.insert_proposal(uid, "foo", "because", None)
    dq_vocab_repo.insert_proposal(uid, "foo", "still because", None)
    entry = dq_vocab_repo.lookup(uid, "foo")
    assert entry is not None
    assert entry.n_proposals == 2


def test_insert_proposal_resurfaces_rejected_when_not_aliased():
    """Re-proposing a rejected (non-aliased) entry flips it back to 'proposed'."""
    uid = _fresh_user("resurface")
    dq_vocab_repo.insert_proposal(uid, "foo", "r1", None)
    dq_vocab_repo.reject(uid, "foo")
    dq_vocab_repo.insert_proposal(uid, "foo", "r2", None)
    entry = dq_vocab_repo.lookup(uid, "foo")
    assert entry is not None
    assert entry.status == "proposed"
    assert entry.n_proposals == 2


def test_insert_proposal_does_not_resurface_aliased():
    """Aliased rejections stay rejected on re-proposal -- alias decision is sticky."""
    uid = _fresh_user("aliased")
    dq_vocab_repo.insert_proposal(uid, "target", "r", None)
    dq_vocab_repo.canonicalize(
        uid,
        "target",
        "Target description for aliasing test.",
        _embed("Target description for aliasing test."),
        canonicalized_by=uid,
    )
    dq_vocab_repo.insert_proposal(uid, "foo", "r", None)
    dq_vocab_repo.alias_to(uid, "foo", "target")
    dq_vocab_repo.insert_proposal(uid, "foo", "r2", None)  # re-proposed
    entry = dq_vocab_repo.lookup(uid, "foo")
    assert entry is not None
    assert entry.status == "rejected"
    assert entry.aliased_to == "target"


def test_pgvector_nearest_returns_match_above_threshold():
    uid = _fresh_user("nearest_above")
    dq_vocab_repo.insert_proposal(uid, "cluster_coherence_drift", None, None)
    dq_vocab_repo.canonicalize(
        uid,
        "cluster_coherence_drift",
        "When a cluster drifts away from its named topic over time.",
        _embed("When a cluster drifts away from its named topic over time."),
        canonicalized_by=uid,
    )
    test_embedding = _embed("cluster has been slowly shifting topic")
    match = dq_vocab_repo.pgvector_nearest(uid, test_embedding, threshold=0.5)
    assert match is not None
    entry, sim = match
    assert entry.issue_type == "cluster_coherence_drift"
    assert sim > 0.5


def test_pgvector_nearest_returns_none_below_threshold():
    uid = _fresh_user("nearest_below")
    dq_vocab_repo.insert_proposal(uid, "cluster_coherence_drift", None, None)
    dq_vocab_repo.canonicalize(
        uid,
        "cluster_coherence_drift",
        "When a cluster drifts away from its named topic over time.",
        _embed("When a cluster drifts away from its named topic over time."),
        canonicalized_by=uid,
    )
    test_embedding = _embed("completely unrelated -- cooking recipes for tomatoes")
    match = dq_vocab_repo.pgvector_nearest(uid, test_embedding, threshold=0.7)
    assert match is None


def test_list_canonical_filters_to_canonical_only():
    uid = _fresh_user("listcanon")
    dq_vocab_repo.insert_proposal(uid, "p1", None, None)
    dq_vocab_repo.insert_proposal(uid, "c1", None, None)
    dq_vocab_repo.canonicalize(uid, "c1", "Description for c1.", _embed("Description for c1."), uid)
    dq_vocab_repo.insert_proposal(uid, "r1", None, None)
    dq_vocab_repo.reject(uid, "r1")

    labels = {e.issue_type for e in dq_vocab_repo.list_canonical(uid)}
    assert labels == {"c1"}


# ------------------------------------------------------ cosine-gate routing


def test_resolve_cold_start_creates_proposal():
    """No canonical entries -> finding routes to proposal (label preserved)."""
    uid = _fresh_user("cold_start")
    finding = {
        "issue_type": "novel_thing",
        "observation": "Something weird happened",
        "entity_type": "cluster",
        "tag": "core",
    }
    label, proposed = _resolve_issue_type(finding, uid, run_id=None)
    assert label == "novel_thing"
    assert proposed == "novel_thing"
    entry = dq_vocab_repo.lookup(uid, "novel_thing")
    assert entry is not None
    assert entry.status == "proposed"


def test_resolve_above_threshold_routes_to_canonical():
    """Above-threshold cosine match overrides the agent's proposed label."""
    uid = _fresh_user("above")
    dq_vocab_repo.insert_proposal(uid, "cluster_coherence_drift", None, None)
    dq_vocab_repo.canonicalize(
        uid,
        "cluster_coherence_drift",
        "When a cluster drifts away from its named topic.",
        _embed("When a cluster drifts away from its named topic."),
        canonicalized_by=uid,
    )
    finding = {
        "issue_type": "any_label_dqbot_picks",
        "observation": "Cluster drifts away from its named topic over time.",
        "entity_type": "cluster",
        "tag": "core",
    }
    label, proposed = _resolve_issue_type(finding, uid, None)
    assert label == "cluster_coherence_drift"
    assert proposed is None  # canonical match; no proposal trail


def test_resolve_aliased_rewrites_silently():
    """Below-threshold + existing aliased entry -> rewrite to alias target,
    record original label as proposed_issue_type."""
    uid = _fresh_user("aliased_rewrite")
    dq_vocab_repo.insert_proposal(uid, "target", None, None)
    dq_vocab_repo.canonicalize(
        uid,
        "target",
        "Tomato recipes for cooking.",
        _embed("Tomato recipes for cooking."),
        canonicalized_by=uid,
    )
    dq_vocab_repo.insert_proposal(uid, "alt", None, None)
    dq_vocab_repo.alias_to(uid, "alt", "target")
    finding = {
        "issue_type": "alt",
        "observation": "Distinct text that the cosine gate misses for target",
        "entity_type": "cluster",
        "tag": "core",
    }
    label, proposed = _resolve_issue_type(finding, uid, None)
    assert label == "target"
    assert proposed == "alt"  # original label captured for the observation row


def test_resolve_below_threshold_new_label_creates_proposal():
    uid = _fresh_user("below_new")
    dq_vocab_repo.insert_proposal(uid, "existing_canonical", None, None)
    dq_vocab_repo.canonicalize(
        uid,
        "existing_canonical",
        "Some unrelated thing involving fish.",
        _embed("Some unrelated thing involving fish."),
        canonicalized_by=uid,
    )
    finding = {
        "issue_type": "a_truly_new_one",
        "observation": "Different domain entirely -- highway construction permits",
        "entity_type": "cluster",
        "tag": "core",
    }
    label, proposed = _resolve_issue_type(finding, uid, None)
    assert label == "a_truly_new_one"
    assert proposed == "a_truly_new_one"
    entry = dq_vocab_repo.lookup(uid, "a_truly_new_one")
    assert entry is not None
    assert entry.status == "proposed"
