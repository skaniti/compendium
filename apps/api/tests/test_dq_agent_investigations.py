"""Integration tests for DQAgent's deterministic-investigator fan-out (Task 8.6).

Verifies the agent correctly:
1. Dynamically imports + invokes each named investigation module's run().
2. Aggregates per-investigator findings into a single candidates list.
3. Inlines the candidates JSON into the CC prompt under
   `## PRE-DETECTED CANDIDATES`.
4. Wires the full five-investigator default through investigate() without
   touching the real subprocess or DB.

Mocking boundaries:
- Investigator `run()` functions are patched at module path -- no DB access.
- subprocess.Popen is patched in the integration test -- no real CC call.
"""

import io
import json
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Module names (mirror the router default in backend/api/routers/dq_bot.py)
# ---------------------------------------------------------------------------

ALL_FIVE = [
    "skip_gate_reversal_audit",     # S1
    "cluster_coherence_drift",      # S2
    "domain_silo_clusters",         # S3
    "supercluster_drift",           # S4
    "dedup_escapees",               # S5
]


# ---------------------------------------------------------------------------
# Helpers (mirror the pattern used in tests/test_dq_agent.py)
# ---------------------------------------------------------------------------

def _mock_stream_events(events: list[dict]) -> str:
    """Produce JSONL string of events for Popen.stdout mocking."""
    return "\n".join(json.dumps(e) for e in events) + "\n"


def _make_mock_popen(events: list[dict], returncode: int = 0, stderr: str = ""):
    """Return a MagicMock that behaves like a Popen with stream-json stdout."""
    mock_proc = MagicMock()
    mock_proc.stdout = io.StringIO(_mock_stream_events(events))
    mock_proc.stderr = io.StringIO(stderr)
    mock_proc.returncode = returncode
    mock_proc.wait = MagicMock(return_value=returncode)
    return mock_proc


def _success_result_event() -> dict:
    """Minimal CC result event signaling success with empty findings."""
    return {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "total_cost_usd": 0.05,
        "result": '{"findings": []}',
    }


# ---------------------------------------------------------------------------
# Test 1 -- fan-out: each module called exactly once with user_id, ordered
# ---------------------------------------------------------------------------

def test_run_deterministic_investigations_calls_each_module():
    """Each investigator's run() must be called once with user_id, and the
    aggregated findings list preserves the order modules were given.
    """
    from backend.services.dq_agent import DQAgent

    sentinels = {
        "skip_gate_reversal_audit": [
            {"tag": "core", "scope_citation": "S1", "_marker": "S1"}
        ],
        "cluster_coherence_drift": [
            {"tag": "core", "scope_citation": "S2", "_marker": "S2"}
        ],
        "domain_silo_clusters": [
            {"tag": "core", "scope_citation": "S3", "_marker": "S3"}
        ],
        "supercluster_drift": [
            {"tag": "core", "scope_citation": "S4", "_marker": "S4"}
        ],
        "dedup_escapees": [
            {"tag": "core", "scope_citation": "S5", "_marker": "S5"}
        ],
    }

    with patch(
        "backend.services.dq_investigations.skip_gate_reversal_audit.run"
    ) as m_s1, patch(
        "backend.services.dq_investigations.cluster_coherence_drift.run"
    ) as m_s2, patch(
        "backend.services.dq_investigations.domain_silo_clusters.run"
    ) as m_s3, patch(
        "backend.services.dq_investigations.supercluster_drift.run"
    ) as m_s4, patch(
        "backend.services.dq_investigations.dedup_escapees.run"
    ) as m_s5:
        m_s1.return_value = sentinels["skip_gate_reversal_audit"]
        m_s2.return_value = sentinels["cluster_coherence_drift"]
        m_s3.return_value = sentinels["domain_silo_clusters"]
        m_s4.return_value = sentinels["supercluster_drift"]
        m_s5.return_value = sentinels["dedup_escapees"]

        agent = DQAgent(user_id=42)
        result = agent._run_deterministic_investigations(ALL_FIVE)

    m_s1.assert_called_once_with(user_id=42)
    m_s2.assert_called_once_with(user_id=42)
    m_s3.assert_called_once_with(user_id=42)
    m_s4.assert_called_once_with(user_id=42)
    m_s5.assert_called_once_with(user_id=42)

    assert len(result) == 5
    assert {f["_marker"] for f in result} == {"S1", "S2", "S3", "S4", "S5"}
    # Order preservation: results should appear in the same order modules were named
    assert [f["_marker"] for f in result] == ["S1", "S2", "S3", "S4", "S5"]


# ---------------------------------------------------------------------------
# Test 1b -- synthetic phase events bracket each investigator's run()
# ---------------------------------------------------------------------------

def test_run_deterministic_investigations_emits_phase_events_per_investigator():
    """Streaming-from-zero fix: on_event, when provided, must receive an
    'investigator_start' phase event before each module's run() and an
    'investigator_done' phase event after, with 'candidates' equal to the
    POST-CAP count (not the raw module output count) -- this is the
    multi-minute-silent gap the manual-run Live pane needs bridged."""
    from backend.services.dq_agent import DQAgent, DQ_MAX_CANDIDATES_PER_INVESTIGATOR

    two_names = ["skip_gate_reversal_audit", "cluster_coherence_drift"]

    # skip_gate_reversal_audit returns more than the per-investigator cap so
    # the done event's count must reflect the capped (not raw) length.
    over_cap = [{"tag": "core", "scope_citation": "S1", "_i": i}
                for i in range(DQ_MAX_CANDIDATES_PER_INVESTIGATOR + 7)]
    under_cap = [{"tag": "core", "scope_citation": "S2", "_marker": "S2"}]

    events: list[dict] = []

    with patch(
        "backend.services.dq_investigations.skip_gate_reversal_audit.run",
        return_value=over_cap,
    ), patch(
        "backend.services.dq_investigations.cluster_coherence_drift.run",
        return_value=under_cap,
    ):
        agent = DQAgent(user_id=42)
        result = agent._run_deterministic_investigations(two_names, on_event=events.append)

    phase_events = [e for e in events if e.get("type") == "_phase"]
    assert [e["subtype"] for e in phase_events] == [
        "investigator_start", "investigator_done",
        "investigator_start", "investigator_done",
    ]
    assert [e["name"] for e in phase_events] == [
        "skip_gate_reversal_audit", "skip_gate_reversal_audit",
        "cluster_coherence_drift", "cluster_coherence_drift",
    ]

    done_events = [e for e in phase_events if e["subtype"] == "investigator_done"]
    assert done_events[0]["candidates"] == DQ_MAX_CANDIDATES_PER_INVESTIGATOR  # capped
    assert done_events[1]["candidates"] == 1  # under cap, unaffected

    # Aggregated candidates list itself is still capped correctly (unaffected
    # by the new on_event plumbing).
    assert len(result) == DQ_MAX_CANDIDATES_PER_INVESTIGATOR + 1


def test_run_deterministic_investigations_default_on_event_is_none():
    """Direct callers/tests that don't pass on_event (the pre-existing
    signature) must keep working unchanged -- on_event defaults to None and
    no phase events are synthesized."""
    from backend.services.dq_agent import DQAgent

    with patch(
        "backend.services.dq_investigations.dedup_escapees.run",
        return_value=[{"tag": "core", "scope_citation": "S5"}],
    ):
        agent = DQAgent(user_id=1)
        result = agent._run_deterministic_investigations(["dedup_escapees"])

    assert len(result) == 1


# ---------------------------------------------------------------------------
# Test 2 -- prompt assembly: PRE-DETECTED CANDIDATES present iff candidates
# ---------------------------------------------------------------------------

def test_build_prompt_includes_pre_detected_candidates_block():
    """When candidates is a non-empty list, the prompt MUST include the
    ## PRE-DETECTED CANDIDATES heading and the JSON-encoded payload. When
    candidates is None, the heading MUST NOT appear.
    """
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=7)

    candidates = [
        {
            "tag": "core",
            "scope_citation": "S1",
            "issue_type": "reversal_pattern",
            "entity_type": "global",
            "entity_id": "skip_gate_prompt",
            "observation": "stub-observation-text-marker-X",
        },
        {
            "tag": "core",
            "scope_citation": "S5",
            "issue_type": "duplicate_pair",
            "entity_type": "page",
            "entity_id": "999",
            "observation": "stub-dedup-marker-Y",
        },
    ]

    prompt_with = agent._build_prompt(trigger="manual", candidates=candidates)
    assert "## PRE-DETECTED CANDIDATES" in prompt_with
    # JSON payload must be inlined verbatim, compact format (no indent / no
    # spaces) per the verboseness-only constraint introduced 2026-04-26.
    expected_json = json.dumps(candidates, separators=(",", ":"))
    assert expected_json in prompt_with
    # Sanity: the marker strings from the candidates should appear in the prompt
    assert "stub-observation-text-marker-X" in prompt_with
    assert "stub-dedup-marker-Y" in prompt_with

    prompt_without = agent._build_prompt(trigger="manual", candidates=None)
    assert "## PRE-DETECTED CANDIDATES" not in prompt_without

    # Empty list -- treated the same as None (per existing build-prompt behavior)
    prompt_empty = agent._build_prompt(trigger="manual", candidates=[])
    assert "## PRE-DETECTED CANDIDATES" not in prompt_empty


# ---------------------------------------------------------------------------
# Test 3 -- end-to-end: investigate() wires fan-out + prompt + subprocess
# ---------------------------------------------------------------------------

def test_investigate_uses_default_investigations_when_invoked_via_router():
    """Trigger DQAgent.investigate() with the full five-investigator list.
    Mock subprocess.Popen and each investigator's run() to controlled values.
    Assert: all five run() functions fired, the subprocess was launched,
    and the candidates JSON appears in the prompt argv.
    """
    from backend.services.dq_agent import DQAgent

    sentinel_findings = {
        "skip_gate_reversal_audit": [
            {
                "tag": "core",
                "scope_citation": "S1",
                "issue_type": "reversal_pattern",
                "entity_type": "global",
                "entity_id": "skip_gate_prompt",
                "observation": "S1-marker-OBS",
            }
        ],
        "cluster_coherence_drift": [
            {
                "tag": "core",
                "scope_citation": "S2",
                "issue_type": "coherence_drift",
                "entity_type": "cluster",
                "entity_id": 11,
                "observation": "S2-marker-OBS",
            }
        ],
        "domain_silo_clusters": [
            {
                "tag": "core",
                "scope_citation": "S3",
                "issue_type": "domain_silo",
                "entity_type": "cluster",
                "entity_id": 12,
                "observation": "S3-marker-OBS",
            }
        ],
        "supercluster_drift": [
            {
                "tag": "core",
                "scope_citation": "S4",
                "issue_type": "supercluster_drift",
                "entity_type": "supercluster",
                "entity_id": 13,
                "observation": "S4-marker-OBS",
            }
        ],
        "dedup_escapees": [
            {
                "tag": "core",
                "scope_citation": "S5",
                "issue_type": "duplicate_pair",
                "entity_type": "page",
                "entity_id": 14,
                "observation": "S5-marker-OBS",
            }
        ],
    }

    mock_popen_obj = _make_mock_popen([_success_result_event()])

    with patch(
        "backend.services.dq_agent.subprocess.Popen",
        return_value=mock_popen_obj,
    ) as mock_popen, patch(
        "backend.services.dq_investigations.skip_gate_reversal_audit.run",
        return_value=sentinel_findings["skip_gate_reversal_audit"],
    ) as m_s1, patch(
        "backend.services.dq_investigations.cluster_coherence_drift.run",
        return_value=sentinel_findings["cluster_coherence_drift"],
    ) as m_s2, patch(
        "backend.services.dq_investigations.domain_silo_clusters.run",
        return_value=sentinel_findings["domain_silo_clusters"],
    ) as m_s3, patch(
        "backend.services.dq_investigations.supercluster_drift.run",
        return_value=sentinel_findings["supercluster_drift"],
    ) as m_s4, patch(
        "backend.services.dq_investigations.dedup_escapees.run",
        return_value=sentinel_findings["dedup_escapees"],
    ) as m_s5:
        agent = DQAgent(user_id=99)
        result = agent.investigate(
            trigger="manual",
            investigations=ALL_FIVE,
        )

    # Every investigator must have been called exactly once with user_id=99.
    m_s1.assert_called_once_with(user_id=99)
    m_s2.assert_called_once_with(user_id=99)
    m_s3.assert_called_once_with(user_id=99)
    m_s4.assert_called_once_with(user_id=99)
    m_s5.assert_called_once_with(user_id=99)

    # Subprocess was launched exactly once (no retry was needed -- success).
    assert mock_popen.called, "subprocess.Popen was never called"
    assert mock_popen.call_count == 1

    # The prompt is piped via stdin (not argv) because Linux MAX_ARG_STRLEN caps
    # any single argv string at PAGE_SIZE*32 = 128 KB and multi-investigator prompts
    # grew past that on 2026-04-23 (commit 187180a wired all 5 investigators by
    # default).  Inspect the stdin.write call instead of the final argv element.
    mock_proc = mock_popen.return_value
    mock_proc.stdin.write.assert_called_once()
    prompt_written = mock_proc.stdin.write.call_args[0][0]
    mock_proc.stdin.close.assert_called_once()

    # The prompt must contain the PRE-DETECTED CANDIDATES block AND the
    # marker strings from every investigator's output.
    assert "## PRE-DETECTED CANDIDATES" in prompt_written
    for marker in ("S1-marker-OBS", "S2-marker-OBS", "S3-marker-OBS",
                   "S4-marker-OBS", "S5-marker-OBS"):
        assert marker in prompt_written, f"Expected marker {marker!r} in prompt stdin"

    # The investigate() return shape is preserved.
    assert result["trigger"] == "manual"
    assert "findings" in result
    assert "total_cost_usd" in result
    assert result.get("error") is None


# ---------------------------------------------------------------------------
# Test 4 -- typo guard: unknown module name fails loudly
# ---------------------------------------------------------------------------

def test_unknown_investigation_module_raises_clear_error():
    """If a caller mistypes a module name, importlib.import_module raises
    ModuleNotFoundError -- the agent does NOT swallow this. The error message
    should reference the path under backend.services.dq_investigations so the
    caller can spot the typo.
    """
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=1)

    with pytest.raises(ModuleNotFoundError) as excinfo:
        agent._run_deterministic_investigations(["nonexistent_module_xyz"])

    msg = str(excinfo.value)
    assert (
        "backend.services.dq_investigations.nonexistent_module_xyz" in msg
        or "nonexistent_module_xyz" in msg
    )
