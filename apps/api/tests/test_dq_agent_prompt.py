"""Tests for the dqBot Tier-2 synthesis-mode prompt rebuild (Task 7,
the 2026-07-19 dqbot-tier2-role-split plan (private), plan.md).

Covers `DQAgent._build_prompt(..., synthesis=True)` (the new Opus
synthesis-only prompt: ADJUDICATED SURVIVORS + ADJUDICATION SUMMARY + YOUR
ROLE: SYNTHESIS ONLY, with the rendered verdict-history block embedded
verbatim) and `DQAgent.investigate(...)`'s dispatch between the new
synthesis mode (candidates passed explicitly) and the legacy monolithic
mode (`investigations=[...]`, byte-compat guarded). The legacy path and
`tests/test_dq_agent.py` are covered elsewhere; this file is additive.
"""

import io
import json


# ---------------------------------------------------------------------------
# Shared fixtures / helpers
# ---------------------------------------------------------------------------

_SAMPLE_SURVIVORS = [
    {
        "tag": "core",
        "scope_citation": "S2",
        "issue_type": "cluster_coherence_drift",
        "entity_type": "cluster",
        "entity_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "observation": "Cluster label diverges from member content.",
        "severity": "warning",
        "rank": 1,
        "adjudication": {
            "verdict": "confirm",
            "confidence": 0.87,
            "reason": "Membership inconsistent with label's natural scope.",
        },
    },
    {
        "tag": "core",
        "scope_citation": "S6",
        "issue_type": "impure_leaf",
        "entity_type": "cluster",
        "entity_id": "9",
        "observation": "Cluster 9 has minimum pairwise similarity 0.12.",
        "severity": "info",
        "rank": 2,
        # S1/S3/S5/S6 candidates pass through adjudication untouched --
        # they may carry no "adjudication" key at all (dq_adjudicator.py's
        # passthrough branch never adds one). The renderer must not choke
        # on that.
    },
]

_SAMPLE_ADJUDICATION_SUMMARY = {
    "judged": 12,
    "passed_through": 5,
    "suppressed": 8,
    "skipped_batches": 0,
    "suppressed_samples": [
        "membership consistent with label's natural scope",
        "heterogeneity is intentional for this label",
    ],
}

_SAMPLE_VERDICT_HISTORY = (
    "## VERDICT HISTORY (how this user has judged your past findings)\n\n"
    "### Calibration by action type\n"
    "- split_cluster: 3/5 approved (60%)\n\n"
    "### Rejected recommendations (your notes -- never trimmed)\n"
    "- [rec 42] merge_clusters: \"these are genuinely different topics\"\n"
)


def _make_agent(user_id: int = 1):
    from backend.services.dq_agent import DQAgent

    return DQAgent(user_id=user_id)


def _mock_stream_events(events: list[dict]) -> str:
    return "\n".join(json.dumps(e) for e in events) + "\n"


def _make_mock_popen(events: list[dict], returncode: int = 0, stderr: str = ""):
    from unittest.mock import MagicMock

    mock_proc = MagicMock()
    mock_proc.stdout = io.StringIO(_mock_stream_events(events))
    mock_proc.stderr = io.StringIO(stderr)
    mock_proc.returncode = returncode
    mock_proc.wait = MagicMock(return_value=returncode)
    return mock_proc


# ---------------------------------------------------------------------------
# Default model constant (Tier-2 spec decision 5)
# ---------------------------------------------------------------------------

def test_default_model_constant_is_opus_1m():
    """DQ_CLAUDE_MODEL defaults to 'opus[1m]' (CC's newest-Opus alias +
    the 1M-context selector) when DQ_CLAUDE_MODEL is unset in the
    environment -- Tier-2 spec decision 5."""
    import importlib
    import os

    original = os.environ.pop("DQ_CLAUDE_MODEL", None)
    try:
        import backend.services.dq_agent as dq_agent_module
        importlib.reload(dq_agent_module)
        assert dq_agent_module.DQ_CLAUDE_MODEL == "opus[1m]"
    finally:
        if original is not None:
            os.environ["DQ_CLAUDE_MODEL"] = original
        import backend.services.dq_agent as dq_agent_module
        importlib.reload(dq_agent_module)


# ---------------------------------------------------------------------------
# _build_prompt(synthesis=True) -- content assertions
# ---------------------------------------------------------------------------

def test_synthesis_prompt_uses_adjudicated_survivors_heading_not_pre_detected():
    agent = _make_agent()
    prompt = agent._build_prompt(
        trigger="manual",
        candidates=_SAMPLE_SURVIVORS,
        verdict_history=_SAMPLE_VERDICT_HISTORY,
        adjudication_summary=_SAMPLE_ADJUDICATION_SUMMARY,
        synthesis=True,
    )

    assert "## ADJUDICATED SURVIVORS" in prompt
    assert "PRE-DETECTED CANDIDATES" not in prompt


def test_synthesis_prompt_embeds_survivor_json_including_adjudication_verdict():
    agent = _make_agent()
    prompt = agent._build_prompt(
        trigger="manual",
        candidates=_SAMPLE_SURVIVORS,
        verdict_history=_SAMPLE_VERDICT_HISTORY,
        adjudication_summary=_SAMPLE_ADJUDICATION_SUMMARY,
        synthesis=True,
    )

    # Compact JSON (separators=(",", ":")) -- same convention as the legacy
    # PRE-DETECTED CANDIDATES block.
    assert '"scope_citation":"S2"' in prompt
    assert '"verdict":"confirm"' in prompt
    assert '"confidence":0.87' in prompt
    # The S6 survivor with no "adjudication" key must not crash rendering
    # and must still appear in the JSON block.
    assert '"scope_citation":"S6"' in prompt


def test_synthesis_prompt_contains_veto_contract_text():
    agent = _make_agent()
    prompt = agent._build_prompt(
        trigger="manual",
        candidates=_SAMPLE_SURVIVORS,
        verdict_history=_SAMPLE_VERDICT_HISTORY,
        adjudication_summary=_SAMPLE_ADJUDICATION_SUMMARY,
        synthesis=True,
    )

    assert "VETO it" in prompt
    assert '"vetoed": [{"entity_id", "reason"}]' in prompt
    assert "You may NOT add back" in prompt
    assert "adjudicator suppressed" in prompt


def test_synthesis_prompt_renders_adjudication_summary_readably_not_raw_repr():
    agent = _make_agent()
    prompt = agent._build_prompt(
        trigger="manual",
        candidates=_SAMPLE_SURVIVORS,
        verdict_history=_SAMPLE_VERDICT_HISTORY,
        adjudication_summary=_SAMPLE_ADJUDICATION_SUMMARY,
        synthesis=True,
    )

    assert "## ADJUDICATION SUMMARY" in prompt
    assert "judged: 12" in prompt
    assert "passed_through: 5" in prompt
    assert "suppressed: 8" in prompt
    assert "skipped_batches: 0" in prompt
    assert "membership consistent with label's natural scope" in prompt
    assert "heterogeneity is intentional for this label" in prompt
    # Not a raw Python dict repr of the summary.
    assert "{'judged': 12" not in prompt
    assert '{"judged": 12' not in prompt


def test_synthesis_prompt_embeds_verdict_history_block_verbatim():
    agent = _make_agent()
    prompt = agent._build_prompt(
        trigger="manual",
        candidates=_SAMPLE_SURVIVORS,
        verdict_history=_SAMPLE_VERDICT_HISTORY,
        adjudication_summary=_SAMPLE_ADJUDICATION_SUMMARY,
        synthesis=True,
    )

    assert _SAMPLE_VERDICT_HISTORY in prompt


def test_synthesis_prompt_contains_global_ranking_instruction():
    agent = _make_agent()
    prompt = agent._build_prompt(
        trigger="manual",
        candidates=_SAMPLE_SURVIVORS,
        verdict_history=_SAMPLE_VERDICT_HISTORY,
        adjudication_summary=_SAMPLE_ADJUDICATION_SUMMARY,
        synthesis=True,
    )

    assert "## YOUR ROLE: SYNTHESIS ONLY" in prompt
    assert "(c) Global ranking" in prompt
    assert "one ranked list across survivors + your own findings" in prompt


def test_synthesis_prompt_omits_rival_hypothesis_section():
    agent = _make_agent()
    prompt = agent._build_prompt(
        trigger="manual",
        candidates=_SAMPLE_SURVIVORS,
        verdict_history=_SAMPLE_VERDICT_HISTORY,
        adjudication_summary=_SAMPLE_ADJUDICATION_SUMMARY,
        synthesis=True,
    )

    assert "RIVAL-HYPOTHESIS CHECK" not in prompt


def test_synthesis_prompt_omits_ranking_soft_cap_and_per_cluster_enrichment():
    """The legacy ranking heading and the per-candidate 'enrich prose /
    filter false positives' framing are both replaced by the YOUR ROLE
    section -- neither should survive into the synthesis prompt."""
    agent = _make_agent()
    prompt = agent._build_prompt(
        trigger="manual",
        candidates=_SAMPLE_SURVIVORS,
        verdict_history=_SAMPLE_VERDICT_HISTORY,
        adjudication_summary=_SAMPLE_ADJUDICATION_SUMMARY,
        synthesis=True,
    )

    assert "## RANKING AND THE SOFT CAP" not in prompt
    assert "enrich their prose (headline, rationale) where helpful" not in prompt
    assert "re-detect them" not in prompt


def test_synthesis_prompt_reuses_scope_adjacency_vocab_and_receipt_sections():
    """Everything NOT explicitly replaced stays verbatim: scope doc,
    adjacency contract, vocab block, structured receipt fields, entity
    references / action payloads, and the output/return-format contract."""
    agent = _make_agent()
    legacy_prompt = agent._build_prompt(trigger="manual")
    synthesis_prompt = agent._build_prompt(
        trigger="manual",
        candidates=_SAMPLE_SURVIVORS,
        verdict_history=_SAMPLE_VERDICT_HISTORY,
        adjudication_summary=_SAMPLE_ADJUDICATION_SUMMARY,
        synthesis=True,
    )

    for marker in (
        "## S1",  # scope document inlined
        "## A1",  # adjacency contract inlined
        "## OUTPUT CONTRACT",
        "## STRUCTURED RECEIPT FIELDS",
        "## ENTITY REFERENCES AND ACTION PAYLOADS",
        "## RETURN FORMAT",
        "`core`",
        "`adjacent`",
        "`off_topic`",
    ):
        assert marker in legacy_prompt, f"missing from legacy baseline: {marker!r}"
        assert marker in synthesis_prompt, f"missing from synthesis prompt: {marker!r}"


def test_synthesis_prompt_omitted_summary_and_history_degrade_gracefully():
    """When the caller doesn't supply verdict_history / adjudication_summary
    (e.g. a direct unit-test call), the renderer falls back to placeholder
    text instead of crashing or embedding 'None'."""
    agent = _make_agent()
    prompt = agent._build_prompt(
        trigger="manual",
        candidates=[],
        synthesis=True,
    )

    assert "## ADJUDICATED SURVIVORS" in prompt
    assert "## ADJUDICATION SUMMARY" in prompt
    assert "judged: 0" in prompt
    assert "\nNone\n" not in prompt


# ---------------------------------------------------------------------------
# Legacy byte-compat guard (candidates via investigations)
# ---------------------------------------------------------------------------

def test_legacy_prompt_still_contains_pre_detected_candidates_and_rival_hypothesis():
    agent = _make_agent()
    candidates = [
        {"tag": "core", "scope_citation": "S1", "observation": "stub candidate"}
    ]
    prompt = agent._build_prompt(trigger="manual", candidates=candidates)

    assert "## PRE-DETECTED CANDIDATES" in prompt
    assert "## RANKING AND THE SOFT CAP" in prompt
    assert "## RIVAL-HYPOTHESIS CHECK (structural investigations only -- S2, S4)" in prompt
    assert "ADJUDICATED SURVIVORS" not in prompt
    assert "YOUR ROLE: SYNTHESIS ONLY" not in prompt


def test_legacy_prompt_with_no_candidates_matches_pre_synthesis_baseline():
    """synthesis defaults to False; a bare _build_prompt(trigger=...) call
    (as every pre-Tier-2 caller and existing test makes) must render
    exactly as before -- ranking + rival-hypothesis sections present, no
    synthesis-only sections."""
    agent = _make_agent()
    prompt = agent._build_prompt(trigger="manual")

    assert "## RANKING AND THE SOFT CAP" in prompt
    assert "## RIVAL-HYPOTHESIS CHECK" in prompt
    assert "ADJUDICATED SURVIVORS" not in prompt
    assert "PRE-DETECTED CANDIDATES" not in prompt


# ---------------------------------------------------------------------------
# investigate() dispatch -- synthesis mode vs. legacy mode
# ---------------------------------------------------------------------------

def test_investigate_synthesis_mode_skips_deterministic_investigations(monkeypatch):
    """When `candidates` is passed explicitly, investigate() must NOT call
    _run_deterministic_investigations -- the executor already ran detection
    + adjudication upstream (Tier-2 spec, Full pass phases 1-2)."""
    from backend.services.dq_agent import DQAgent

    captured = {}

    def fake_build_prompt(self, trigger, candidates=None, verdict_history=None,
                           adjudication_summary=None, synthesis=False):
        captured["trigger"] = trigger
        captured["candidates"] = candidates
        captured["verdict_history"] = verdict_history
        captured["adjudication_summary"] = adjudication_summary
        captured["synthesis"] = synthesis
        return "SYNTHESIS PROMPT"

    def fake_single_pass(self, cmd, prompt, on_event, on_subprocess_start=None):
        captured["prompt_seen_by_subprocess"] = prompt
        return {
            "returncode": 0, "duration_s": 1.0, "findings": [], "vetoed": [],
            "total_cost_usd": 0.0, "saw_result": True, "error": None,
        }

    def boom_investigations(self, investigations, on_event=None):
        raise AssertionError(
            "_run_deterministic_investigations must not run when candidates "
            "is passed explicitly -- the executor already ran it"
        )

    monkeypatch.setattr(DQAgent, "_build_prompt", fake_build_prompt)
    monkeypatch.setattr(DQAgent, "_run_single_pass", fake_single_pass)
    monkeypatch.setattr(DQAgent, "_run_deterministic_investigations", boom_investigations)

    agent = DQAgent(user_id=1)
    result = agent.investigate(
        trigger="manual",
        investigations=["skip_gate_reversal_audit"],  # must be ignored
        candidates=_SAMPLE_SURVIVORS,
        verdict_history=_SAMPLE_VERDICT_HISTORY,
        adjudication_summary=_SAMPLE_ADJUDICATION_SUMMARY,
    )

    assert captured["synthesis"] is True
    assert captured["candidates"] == _SAMPLE_SURVIVORS
    assert captured["verdict_history"] == _SAMPLE_VERDICT_HISTORY
    assert captured["adjudication_summary"] == _SAMPLE_ADJUDICATION_SUMMARY
    assert captured["prompt_seen_by_subprocess"] == "SYNTHESIS PROMPT"
    assert result["trigger"] == "manual"


def test_investigate_synthesis_mode_passes_vetoed_through(monkeypatch):
    from backend.services.dq_agent import DQAgent

    def fake_build_prompt(self, trigger, candidates=None, verdict_history=None,
                           adjudication_summary=None, synthesis=False):
        return "P"

    def fake_single_pass(self, cmd, prompt, on_event, on_subprocess_start=None):
        return {
            "returncode": 0, "duration_s": 1.0,
            "findings": [{"tag": "core", "entity_id": "abc"}],
            "vetoed": [{"entity_id": "def", "reason": "membership actually coherent"}],
            "total_cost_usd": 0.02, "saw_result": True, "error": None,
        }

    monkeypatch.setattr(DQAgent, "_build_prompt", fake_build_prompt)
    monkeypatch.setattr(DQAgent, "_run_single_pass", fake_single_pass)

    agent = DQAgent(user_id=1)
    result = agent.investigate(trigger="manual", candidates=_SAMPLE_SURVIVORS)

    assert result["vetoed"] == [{"entity_id": "def", "reason": "membership actually coherent"}]
    assert result["findings"] == [{"tag": "core", "entity_id": "abc"}]


def test_investigate_legacy_mode_omits_vetoed_key(monkeypatch):
    """Legacy path (no candidates kwarg) never emits a 'vetoed' key -- there
    is nothing upstream for Opus to veto in that mode."""
    from backend.services.dq_agent import DQAgent

    def fake_build_prompt(self, trigger, candidates=None):
        return "P"

    def fake_single_pass(self, cmd, prompt, on_event, on_subprocess_start=None):
        return {
            "returncode": 0, "duration_s": 1.0, "findings": [], "vetoed": [],
            "total_cost_usd": 0.0, "saw_result": True, "error": None,
        }

    monkeypatch.setattr(DQAgent, "_build_prompt", fake_build_prompt)
    monkeypatch.setattr(DQAgent, "_run_single_pass", fake_single_pass)

    agent = DQAgent(user_id=1)
    result = agent.investigate(trigger="manual")

    assert "vetoed" not in result


def test_investigate_synthesis_end_to_end_parses_vetoed_from_result_payload():
    """Full subprocess-mocked round trip: the 'vetoed' top-level key in the
    CC result JSON payload survives through _run_single_pass -> _finalize
    -> investigate()'s return dict."""
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent

    events = [
        {"type": "system", "subtype": "init"},
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "total_cost_usd": 0.5,
            "result": json.dumps({
                "findings": [
                    {"tag": "core", "scope_citation": "S2", "entity_type": "cluster",
                     "entity_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6"},
                ],
                "vetoed": [
                    {"entity_id": "9", "reason": "min-sim borderline, not actually mixed"},
                ],
            }),
        },
    ]

    with patch("backend.services.dq_agent.subprocess.Popen", return_value=_make_mock_popen(events)):
        agent = _make_agent()
        result = agent.investigate(
            trigger="manual",
            candidates=_SAMPLE_SURVIVORS,
            verdict_history=_SAMPLE_VERDICT_HISTORY,
            adjudication_summary=_SAMPLE_ADJUDICATION_SUMMARY,
        )

    assert result["vetoed"] == [{"entity_id": "9", "reason": "min-sim borderline, not actually mixed"}]
    assert len(result["findings"]) == 1
    assert result["total_cost_usd"] == 0.5


def test_investigate_legacy_mode_still_runs_deterministic_investigations(monkeypatch):
    """Sanity: legacy call shape (investigations=[...], no candidates kwarg)
    is unaffected by the Task 7 changes -- unchanged from
    tests/test_dq_agent.py::test_investigate_runs_deterministic_investigations_first."""
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent

    events = [
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "total_cost_usd": 0.1,
            "result": '{"findings": []}',
        },
    ]

    with patch(
        "backend.services.dq_agent.subprocess.Popen",
        return_value=_make_mock_popen(events),
    ), patch(
        "backend.services.dq_investigations.skip_gate_reversal_audit.run"
    ) as mock_inv:
        mock_inv.return_value = [
            {"tag": "core", "scope_citation": "S1", "observation": "stub"}
        ]
        agent = DQAgent(user_id=1)
        result = agent.investigate(
            trigger="manual",
            investigations=["skip_gate_reversal_audit"],
        )

    mock_inv.assert_called_once_with(user_id=1)
    assert result["trigger"] == "manual"
    assert "vetoed" not in result
