"""Unit tests for the upstream rival-hypothesis adjudicator (rec 260).

Mocks the module's internal `_llm_call` helper (and, for one test, the
underlying `LLMService.complete` directly) so tests are fast, free, and
never make a live OpenAI call.
"""

from __future__ import annotations

import json
import re
from unittest.mock import MagicMock

import pytest

from backend.services import dq_adjudicator
from backend.services.llm_service import LLMService


# ---------------------------------------------------------------------------
# Candidate fixtures -- shapes match DQAgent.persist_findings' finding dict
# (see backend/services/dq_agent.py + dq_agent_scope.md).
# ---------------------------------------------------------------------------

def _make_s1_candidate() -> dict:
    return {
        "tag": "core",
        "scope_citation": "S1",
        "issue_type": "skip_gate_overfit",
        "entity_type": "global",
        "entity_id": "skip_gate_prompt",
        "observation": "3 pages share reasoning pattern X, 2 labelled incorrect.",
        "severity": "warning",
        "evidence": {"items": []},
        "recommendation": {
            "headline": "Tighten skip-gate prompt for pattern X",
            "rationale": "3 pages, 2 incorrect",
            "self_classification": "judgment",
            "action_type": "edit_prompt",
            "affected_entity_ids": ["skip_gate_prompt"],
            "action_payload": None,
        },
    }


def _make_s3_candidate() -> dict:
    return {
        "tag": "core",
        "scope_citation": "S3",
        "issue_type": "domain_silo",
        "entity_type": "global",
        "entity_id": "domain_silo:wikipedia.org",
        "observation": "wikipedia.org dominates 6 clusters.",
        "severity": "info",
        "evidence": {"items": []},
        "recommendation": None,
    }


def _make_s5_candidate() -> dict:
    return {
        "tag": "core",
        "scope_citation": "S5",
        "issue_type": "dedup_escapee",
        "entity_type": "page",
        "entity_id": "42",
        "observation": "Pages 42/43 have 0.97 summary similarity.",
        "severity": "info",
        "evidence": {"items": []},
        "recommendation": None,
    }


def _make_s6_candidate() -> dict:
    return {
        "tag": "core",
        "scope_citation": "S6",
        "issue_type": "unspecified_s6",
        "entity_type": "global",
        "entity_id": "s6-thing",
        "observation": "some S6 observation",
        "severity": "info",
        "evidence": {"items": []},
        "recommendation": None,
    }


def _make_s2_candidate(
    cluster_id: int = 7,
    stable_id: str = "uuid-cluster-7",
    label: str = "Quantum Computing",
    n_members: int = 3,
) -> dict:
    members = [
        {"title": f"Page {i}", "domain": "arxiv.org", "page_content_id": 100 + i}
        for i in range(n_members)
    ]
    return {
        "tag": "core",
        "scope_citation": "S2",
        "issue_type": "cluster_coherence_drift",
        "entity_type": "cluster",
        "entity_id": stable_id,
        "observation": (
            f"Cluster {cluster_id} ('{label}') has coherence ratio 0.42 "
            f"(threshold 0.60); 2/{n_members} member summaries diverge."
        ),
        "severity": "warning",
        "evidence": {
            "items": [
                {"type": "cluster", "id": cluster_id, "stable_id": stable_id, "label": label}
            ]
        },
        "members": members,
        "recommendation": {
            "headline": f"Cluster {cluster_id} ('{label}') diverges from label",
            "rationale": "coherence ratio below threshold",
            "self_classification": "judgment",
            "action_type": "flag_for_review",
            "affected_entity_ids": [stable_id],
            "action_payload": {"stable_id": stable_id},
        },
    }


def _make_s4_candidate(
    super_label: str = "zoology",
    children: list[str] | None = None,
) -> dict:
    children = children if children is not None else ["Ornithology", "Marine Biology", "Entomology"]
    return {
        "tag": "core",
        "scope_citation": "S4",
        "issue_type": "supercluster_drift",
        "entity_type": "supercluster",
        "entity_id": super_label,
        "observation": (
            f"Supercluster '{super_label}' has cosine distance 0.61 from the "
            f"centroid of its {len(children)} child cluster labels."
        ),
        "severity": "warning",
        "children": children,
        "recommendation": {
            "headline": f"Supercluster '{super_label}' may not fit its children",
            "rationale": "distance above threshold",
            "self_classification": "judgment",
            "action_type": "flag_for_review",
            "affected_entity_ids": [super_label],
        },
    }


def _confirm_entry(index: int, **overrides) -> dict:
    entry = {
        "index": index,
        "verdict": "confirm",
        "confidence": 0.9,
        "reason": "membership matches predicted scope",
        "refined_action": None,
        "proposed_label": None,
        "evict_page_content_ids": None,
    }
    entry.update(overrides)
    return entry


def _suppress_entry(index: int, **overrides) -> dict:
    entry = {
        "index": index,
        "verdict": "suppress",
        "confidence": 0.8,
        "reason": "heterogeneity is intentional for this label",
        "refined_action": None,
        "proposed_label": None,
        "evict_page_content_ids": None,
    }
    entry.update(overrides)
    return entry


def _batch_size_from_prompt(prompt: str) -> int:
    """Count rendered candidate blocks in a prompt (used by fake LLM calls
    that need to answer with the right number of verdicts for whatever
    batch size the adjudicator actually sent)."""
    return len(re.findall(r"^\[\d+\] scope=", prompt, flags=re.MULTILINE))


# ---------------------------------------------------------------------------
# Pass-through: S1/S3/S5/S6 never reach the LLM
# ---------------------------------------------------------------------------

def test_non_adjudicated_scopes_pass_through_untouched(monkeypatch):
    def _boom(prompt):
        raise AssertionError("LLM should not be called for non-S2/S4 candidates")

    monkeypatch.setattr(dq_adjudicator, "_llm_call", _boom)

    candidates = [
        _make_s1_candidate(),
        _make_s3_candidate(),
        _make_s5_candidate(),
        _make_s6_candidate(),
    ]
    result = dq_adjudicator.adjudicate(candidates, user_id=1)

    assert result["survivors"] == candidates
    assert result["suppressed"] == []
    assert result["stats"] == {
        "judged": 0,
        "passed_through": 4,
        "suppressed": 0,
        "skipped_batches": 0,
    }
    # untouched -- no adjudication key was added
    for candidate in result["survivors"]:
        assert "adjudication" not in candidate


# ---------------------------------------------------------------------------
# Batching at BATCH_SIZE=15
# ---------------------------------------------------------------------------

def test_s2_candidates_batched_at_15(monkeypatch):
    candidates = [
        _make_s2_candidate(cluster_id=i, stable_id=f"uuid-{i}", label=f"Cluster {i}")
        for i in range(16)
    ]

    def fake_llm_call(prompt):
        n = _batch_size_from_prompt(prompt)
        return json.dumps({"verdicts": [_confirm_entry(i) for i in range(n)]})

    mock_call = MagicMock(side_effect=fake_llm_call)
    monkeypatch.setattr(dq_adjudicator, "_llm_call", mock_call)

    result = dq_adjudicator.adjudicate(candidates, user_id=1)

    assert mock_call.call_count == 2
    first_prompt = mock_call.call_args_list[0].args[0]
    second_prompt = mock_call.call_args_list[1].args[0]
    assert _batch_size_from_prompt(first_prompt) == dq_adjudicator.BATCH_SIZE
    assert _batch_size_from_prompt(second_prompt) == 16 - dq_adjudicator.BATCH_SIZE

    assert len(result["survivors"]) == 16
    assert result["suppressed"] == []
    assert result["stats"] == {
        "judged": 16,
        "passed_through": 0,
        "suppressed": 0,
        "skipped_batches": 0,
    }


def test_s4_candidates_also_routed_to_adjudication(monkeypatch):
    """S4 shares the S2 batching path (only S1/S3/S5/S6 skip it)."""
    candidates = [_make_s4_candidate(super_label="zoology")]

    def fake_llm_call(prompt):
        assert "children: Ornithology, Marine Biology, Entomology" in prompt
        return json.dumps({"verdicts": [_confirm_entry(0)]})

    monkeypatch.setattr(dq_adjudicator, "_llm_call", MagicMock(side_effect=fake_llm_call))

    result = dq_adjudicator.adjudicate(candidates, user_id=1)

    assert len(result["survivors"]) == 1
    assert result["stats"]["judged"] == 1


# ---------------------------------------------------------------------------
# Suppress verdict
# ---------------------------------------------------------------------------

def test_suppress_verdict_lands_in_suppressed_with_reason(monkeypatch):
    candidate = _make_s2_candidate()

    monkeypatch.setattr(
        dq_adjudicator,
        "_llm_call",
        MagicMock(return_value=json.dumps({
            "verdicts": [_suppress_entry(0, reason="label predicts this exact mix", confidence=0.77)]
        })),
    )

    result = dq_adjudicator.adjudicate([candidate], user_id=1)

    assert result["survivors"] == []
    assert len(result["suppressed"]) == 1
    entry = result["suppressed"][0]
    assert entry["reason"] == "label predicts this exact mix"
    assert entry["confidence"] == 0.77
    assert entry["candidate"]["entity_id"] == candidate["entity_id"]
    assert result["stats"] == {
        "judged": 1,
        "passed_through": 0,
        "suppressed": 1,
        "skipped_batches": 0,
    }


# ---------------------------------------------------------------------------
# Confirm + refined_action rewrites
# ---------------------------------------------------------------------------

def test_confirm_relabel_cluster_rewrites_action_type_and_merges_label(monkeypatch):
    candidate = _make_s2_candidate(stable_id="uuid-7")

    monkeypatch.setattr(
        dq_adjudicator,
        "_llm_call",
        MagicMock(return_value=json.dumps({
            "verdicts": [_confirm_entry(
                0,
                refined_action="relabel_cluster",
                proposed_label="Physics Preprints",
            )]
        })),
    )

    result = dq_adjudicator.adjudicate([candidate], user_id=1)

    assert len(result["survivors"]) == 1
    survivor = result["survivors"][0]
    rec = survivor["recommendation"]
    assert rec["action_type"] == "relabel_cluster"
    # merged into the existing payload -- stable_id preserved, label added
    assert rec["action_payload"] == {
        "stable_id": "uuid-7",
        "proposed_label": "Physics Preprints",
    }
    # original candidate dict is untouched (adjudicator worked on a copy)
    assert candidate["recommendation"]["action_type"] == "flag_for_review"
    assert "proposed_label" not in candidate["recommendation"]["action_payload"]


def test_confirm_split_cluster_merges_evict_ids_as_remove_page_content_ids(monkeypatch):
    candidate = _make_s2_candidate(stable_id="uuid-9")

    monkeypatch.setattr(
        dq_adjudicator,
        "_llm_call",
        MagicMock(return_value=json.dumps({
            "verdicts": [_confirm_entry(
                0,
                refined_action="split_cluster",
                evict_page_content_ids=[101, 102],
            )]
        })),
    )

    result = dq_adjudicator.adjudicate([candidate], user_id=1)

    survivor = result["survivors"][0]
    rec = survivor["recommendation"]
    assert rec["action_type"] == "split_cluster"
    assert rec["action_payload"] == {
        "stable_id": "uuid-9",
        "remove_page_content_ids": [101, 102],
    }


def test_confirm_flag_for_review_sets_action_type_only(monkeypatch):
    candidate = _make_s2_candidate(stable_id="uuid-3")

    monkeypatch.setattr(
        dq_adjudicator,
        "_llm_call",
        MagicMock(return_value=json.dumps({
            "verdicts": [_confirm_entry(0, refined_action="flag_for_review")]
        })),
    )

    result = dq_adjudicator.adjudicate([candidate], user_id=1)

    rec = result["survivors"][0]["recommendation"]
    assert rec["action_type"] == "flag_for_review"


def test_confirm_null_refined_action_leaves_recommendation_alone(monkeypatch):
    candidate = _make_s2_candidate(stable_id="uuid-4")
    original_action_payload = dict(candidate["recommendation"]["action_payload"])

    monkeypatch.setattr(
        dq_adjudicator,
        "_llm_call",
        MagicMock(return_value=json.dumps({"verdicts": [_confirm_entry(0)]})),
    )

    result = dq_adjudicator.adjudicate([candidate], user_id=1)

    rec = result["survivors"][0]["recommendation"]
    assert rec["action_type"] == "flag_for_review"
    assert rec["action_payload"] == original_action_payload


def test_confirmed_candidate_gets_adjudication_receipt(monkeypatch):
    candidate = _make_s2_candidate()

    monkeypatch.setattr(
        dq_adjudicator,
        "_llm_call",
        MagicMock(return_value=json.dumps({
            "verdicts": [_confirm_entry(0, confidence=0.65, reason="predicted mix matches")]
        })),
    )

    result = dq_adjudicator.adjudicate([candidate], user_id=1)

    survivor = result["survivors"][0]
    assert survivor["adjudication"] == {
        "verdict": "confirm",
        "confidence": 0.65,
        "reason": "predicted mix matches",
    }


# ---------------------------------------------------------------------------
# Malformed JSON -> retry once -> skip batch
# ---------------------------------------------------------------------------

def test_malformed_json_retries_once_then_skips_batch(monkeypatch):
    candidate = _make_s2_candidate()

    mock_call = MagicMock(side_effect=["not valid json", "still not valid json"])
    monkeypatch.setattr(dq_adjudicator, "_llm_call", mock_call)

    result = dq_adjudicator.adjudicate([candidate], user_id=1)

    assert mock_call.call_count == 2
    assert result["survivors"] == [
        {**candidate, "adjudication": "skipped"}
    ]
    assert result["suppressed"] == []
    assert result["stats"] == {
        "judged": 0,
        "passed_through": 1,
        "suppressed": 0,
        "skipped_batches": 1,
    }


def test_index_coverage_mismatch_counts_as_validation_failure(monkeypatch):
    """Missing an index entirely is a parse/validation failure, same as bad JSON."""
    candidates = [_make_s2_candidate(cluster_id=1), _make_s2_candidate(cluster_id=2)]

    # Only covers index 0 for a batch of 2 -- both attempts fail the same way.
    bad_response = json.dumps({"verdicts": [_confirm_entry(0)]})
    mock_call = MagicMock(side_effect=[bad_response, bad_response])
    monkeypatch.setattr(dq_adjudicator, "_llm_call", mock_call)

    result = dq_adjudicator.adjudicate(candidates, user_id=1)

    assert mock_call.call_count == 2
    assert result["stats"]["skipped_batches"] == 1
    assert result["stats"]["passed_through"] == 2
    assert all(c["adjudication"] == "skipped" for c in result["survivors"])


def test_retry_recovers_on_second_attempt(monkeypatch):
    candidate = _make_s2_candidate()
    good_response = json.dumps({"verdicts": [_confirm_entry(0)]})

    mock_call = MagicMock(side_effect=["garbage", good_response])
    monkeypatch.setattr(dq_adjudicator, "_llm_call", mock_call)

    result = dq_adjudicator.adjudicate([candidate], user_id=1)

    assert mock_call.call_count == 2
    assert result["stats"]["skipped_batches"] == 0
    assert result["stats"]["judged"] == 1
    assert len(result["survivors"]) == 1
    assert result["survivors"][0]["adjudication"]["verdict"] == "confirm"


# ---------------------------------------------------------------------------
# DQ_ADJUDICATION_DISABLED=1
# ---------------------------------------------------------------------------

def test_disabled_env_flag_passes_everything_through_skipped(monkeypatch):
    def _boom(prompt):
        raise AssertionError("LLM should not be called when adjudication is disabled")

    monkeypatch.setattr(dq_adjudicator, "_llm_call", _boom)
    monkeypatch.setenv("DQ_ADJUDICATION_DISABLED", "1")

    candidates = [_make_s1_candidate(), _make_s2_candidate(), _make_s4_candidate()]
    result = dq_adjudicator.adjudicate(candidates, user_id=1)

    assert len(result["survivors"]) == 3
    assert result["suppressed"] == []
    for survivor in result["survivors"]:
        assert survivor["adjudication"] == "skipped"
    assert result["stats"] == {
        "judged": 0,
        "passed_through": 3,
        "suppressed": 0,
        "skipped_batches": 0,
    }


def test_disabled_flag_is_read_at_call_time_not_import_time(monkeypatch):
    """Env flag must be re-read on every call, not cached at import."""
    candidate = _make_s2_candidate()

    monkeypatch.setattr(
        dq_adjudicator,
        "_llm_call",
        MagicMock(return_value=json.dumps({"verdicts": [_confirm_entry(0)]})),
    )

    monkeypatch.delenv("DQ_ADJUDICATION_DISABLED", raising=False)
    enabled_result = dq_adjudicator.adjudicate([candidate], user_id=1)
    assert enabled_result["stats"]["judged"] == 1

    monkeypatch.setenv("DQ_ADJUDICATION_DISABLED", "1")
    disabled_result = dq_adjudicator.adjudicate([candidate], user_id=1)
    assert disabled_result["stats"]["passed_through"] == 1
    assert disabled_result["survivors"][0]["adjudication"] == "skipped"


# ---------------------------------------------------------------------------
# Mixed batch stats + exact LLMService.complete call kwargs (no live call)
# ---------------------------------------------------------------------------

def test_mixed_batch_stats_add_up(monkeypatch):
    candidates = [
        _make_s2_candidate(cluster_id=1, stable_id="uuid-1"),
        _make_s2_candidate(cluster_id=2, stable_id="uuid-2"),
        _make_s2_candidate(cluster_id=3, stable_id="uuid-3"),
    ]

    monkeypatch.setattr(
        dq_adjudicator,
        "_llm_call",
        MagicMock(return_value=json.dumps({
            "verdicts": [
                _confirm_entry(0),
                _suppress_entry(1),
                _confirm_entry(2),
            ]
        })),
    )

    result = dq_adjudicator.adjudicate(candidates, user_id=1)

    assert result["stats"] == {
        "judged": 3,
        "passed_through": 0,
        "suppressed": 1,
        "skipped_batches": 0,
    }
    assert len(result["survivors"]) == 2
    assert len(result["suppressed"]) == 1


def test_llm_service_complete_called_with_exact_kwargs(monkeypatch):
    """Verifies the wiring through LLMService.complete matches the brief's
    exact call spec -- mocks LLMService.complete itself (not _llm_call), so
    this also proves no live OpenAI call is reachable from this path."""
    captured = {}

    async def fake_complete(self, prompt, **kwargs):
        captured["prompt"] = prompt
        captured["kwargs"] = kwargs
        return type("FakeResponse", (), {
            "content": json.dumps({"verdicts": [_confirm_entry(0)]})
        })()

    monkeypatch.setattr(LLMService, "complete", fake_complete)

    candidate = _make_s2_candidate()
    result = dq_adjudicator.adjudicate([candidate], user_id=1)

    assert captured["kwargs"] == {
        "model": dq_adjudicator.ADJUDICATION_MODEL,
        "temperature": 0.0,
        "seed": 42,
        "max_tokens": 4000,
        "response_format": "json_object",
    }
    assert dq_adjudicator.ADJUDICATION_MODEL == "gpt-4o-mini"
    assert "Candidates:" in captured["prompt"]
    assert result["stats"]["judged"] == 1


def test_module_constants():
    assert dq_adjudicator.ADJUDICATION_MODEL == "gpt-4o-mini"
    assert dq_adjudicator.BATCH_SIZE == 15


# ---------------------------------------------------------------------------
# Fail-open covers TRANSPORT errors, not just parse failures (final-review F1)
# ---------------------------------------------------------------------------

def test_llm_transport_error_retries_then_fails_open(monkeypatch):
    """An API/timeout exception from the LLM call itself must hit the same
    retry + skip-batch path as a parse failure -- never propagate (it would
    crash the whole weekly full run)."""
    calls = []

    def _transport_boom(prompt):
        calls.append(prompt)
        raise RuntimeError("simulated OpenAI 500")

    monkeypatch.setattr(dq_adjudicator, "_llm_call", _transport_boom)

    candidates = [_make_s2_candidate()]
    result = dq_adjudicator.adjudicate(candidates, user_id=1)

    assert len(calls) == 2  # one retry happened
    assert result["stats"]["skipped_batches"] == 1
    assert len(result["survivors"]) == 1
    assert result["survivors"][0]["adjudication"] == "skipped"
    assert result["suppressed"] == []


# ---------------------------------------------------------------------------
# Refinement is S2-only (final-review F3)
# ---------------------------------------------------------------------------

def test_refined_action_on_s4_candidate_is_ignored(monkeypatch):
    """S4 supercluster recs are record-only; a stray refined_action from the
    model must not rewrite one into a cluster action."""
    def fake_llm_call(prompt):
        return (
            '{"verdicts": [{"index": 0, "verdict": "confirm", "confidence": 0.8,'
            ' "reason": "drift real", "refined_action": "split_cluster",'
            ' "proposed_label": null, "evict_page_content_ids": [1, 2]}]}'
        )

    monkeypatch.setattr(dq_adjudicator, "_llm_call", fake_llm_call)

    candidate = _make_s4_candidate()
    original_action = candidate["recommendation"]["action_type"]
    result = dq_adjudicator.adjudicate([candidate], user_id=1)

    survivor = result["survivors"][0]
    assert survivor["adjudication"]["verdict"] == "confirm"
    assert survivor["recommendation"]["action_type"] == original_action
    assert "remove_page_content_ids" not in (
        survivor["recommendation"].get("action_payload") or {}
    )
