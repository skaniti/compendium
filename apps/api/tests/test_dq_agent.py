"""Tests for the DQAgent class (CC subprocess runtime, read-only)."""

import io
import json


# ---------------------------------------------------------------------------
# Helper for mocking Popen with stream-json events
# ---------------------------------------------------------------------------

def _mock_stream_events(events: list[dict]) -> str:
    """Produce JSONL string of events for Popen.stdout mocking."""
    return "\n".join(json.dumps(e) for e in events) + "\n"


def _make_mock_popen(events: list[dict], returncode: int = 0, stderr: str = ""):
    """Return a MagicMock that behaves like a Popen with stream-json stdout."""
    from unittest.mock import MagicMock

    mock_proc = MagicMock()
    mock_proc.stdout = io.StringIO(_mock_stream_events(events))
    mock_proc.stderr = io.StringIO(stderr)
    mock_proc.returncode = returncode
    mock_proc.wait = MagicMock(return_value=returncode)
    return mock_proc


# ---------------------------------------------------------------------------
# Construction + document-loading tests (no subprocess)
# ---------------------------------------------------------------------------

def test_dq_agent_constructible_with_user_id():
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=1)
    assert agent.user_id == 1


def test_dq_agent_loads_scope_document():
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=1)
    assert "S1" in agent.scope_document  # Skip-gate reversal audit


def test_dq_agent_loads_adjacency_document():
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=1)
    assert "A1" in agent.adjacency_document  # first adjacency category


def test_prompt_inlines_scope_document():
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=1)
    prompt = agent._build_prompt(trigger="manual")

    assert "## S1" in prompt  # scope document inlined
    assert "## A1" in prompt  # adjacency document inlined


def test_prompt_names_three_tier_tagging():
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=1)
    prompt = agent._build_prompt(trigger="manual")

    assert "`core`" in prompt
    assert "`adjacent`" in prompt
    assert "`off_topic`" in prompt


def test_prompt_enforces_soft_cap():
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=1)
    prompt = agent._build_prompt(trigger="manual")

    assert "rank" in prompt.lower()
    assert "top 5" in prompt or "top five" in prompt.lower()


def test_prompt_specifies_json_output_format():
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=1)
    prompt = agent._build_prompt(trigger="manual")

    assert "findings" in prompt
    assert "JSON" in prompt or "json" in prompt


def test_prompt_carries_user_id():
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=42)
    prompt = agent._build_prompt(trigger="manual")

    assert "user_id=42" in prompt or "user_id: 42" in prompt


# ---------------------------------------------------------------------------
# _render_vocab_block guardrail tests (2026-07-17 executive vocab sweep --
# "modify the prompt to not allow such narrowly-scoped suggestions")
# ---------------------------------------------------------------------------

_VOCAB_BAN_PHRASES = (
    "entity names or ids",
    "run numbers",
    "detector ids",
    "`s2_`/",
    "`s4_`",
    "duplicate_of_*",
    "*_nothing_found",
    "no_finding",
    "persistent",
    "systemic",
    "recurrence",
)


def _fresh_vocab_user(label: str) -> int:
    import uuid

    from backend.db import user_repo

    email = f"{label}-{uuid.uuid4().hex[:8]}@test.local"
    return user_repo.create_user(email=email, name="vocab guardrail test")["id"]


def test_vocab_block_cold_start_states_class_not_instance():
    """Cold-start branch (no canonical rows for this user yet) states the
    issue_type-is-a-CLASS rule and the persistent-problem-CLASS framing for
    proposals, not just 'pick a descriptive label'."""
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=_fresh_vocab_user("vocab-cold"))
    prompt = agent._build_prompt(trigger="manual")

    assert "(empty -- this is a cold-start run)" in prompt
    assert "RECURRING CLASS" in prompt
    assert "PERSISTENT PROBLEM CLASS" in prompt
    assert "~10" in prompt


def test_vocab_block_cold_start_bans_narrow_labels():
    """Cold-start branch enumerates the hard bans on proposed_issue_type
    (entity/run/detector ids, dates, duplicate_of_*, *_nothing_found,
    persistent/systemic/recurrence qualifiers)."""
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=_fresh_vocab_user("vocab-cold-bans"))
    prompt = agent._build_prompt(trigger="manual")

    assert "HARD BANS" in prompt
    for phrase in _VOCAB_BAN_PHRASES:
        assert phrase in prompt, f"missing ban phrase: {phrase!r}"


def test_vocab_block_populated_states_class_not_instance():
    """Populated branch (>=1 canonical entry) tells the agent to pick the
    closest canonical class even when the fit is imperfect, and to propose
    only when no class could plausibly cover the finding -- not just 'pick
    from the list if it fits'."""
    from backend.db import dq_vocab_repo
    from backend.services.dq_agent import DQAgent

    uid = _fresh_vocab_user("vocab-pop")
    dq_vocab_repo.insert_proposal(uid, "cluster_coherence_drift", None, None)
    dq_vocab_repo.canonicalize(
        uid,
        "cluster_coherence_drift",
        "Label does not describe members; mislabeled/mixed/incoherent clusters.",
        [0.01] * 384,
        uid,
    )

    agent = DQAgent(user_id=uid)
    prompt = agent._build_prompt(trigger="manual")

    assert "cluster_coherence_drift" in prompt
    assert "RECURRING CLASS" in prompt
    assert "even when the fit" in prompt
    assert "PERSISTENT" in prompt
    assert "~10" in prompt


def test_vocab_block_populated_bans_narrow_labels_and_overlap():
    """Populated branch carries the same hard-ban list as cold-start, plus
    the 'don't propose a label that overlaps an existing class' discipline
    that keeps the vocabulary near its ~10-entry target."""
    from backend.db import dq_vocab_repo
    from backend.services.dq_agent import DQAgent

    uid = _fresh_vocab_user("vocab-pop-bans")
    dq_vocab_repo.insert_proposal(uid, "domain_silo", None, None)
    dq_vocab_repo.canonicalize(
        uid,
        "domain_silo",
        "Cluster(s) grouped by source website rather than topic.",
        [0.02] * 384,
        uid,
    )

    agent = DQAgent(user_id=uid)
    prompt = agent._build_prompt(trigger="manual")

    assert "HARD BANS" in prompt
    for phrase in _VOCAB_BAN_PHRASES:
        assert phrase in prompt, f"missing ban phrase: {phrase!r}"
    assert "do NOT" in prompt
    assert "overlap" in prompt


def test_output_contract_proposed_issue_type_line_carries_ban_reminder():
    """The RETURN FORMAT schema's proposed_issue_type line itself carries a
    one-line ban reminder, so the guardrail survives even if the agent
    jumps straight to the schema without reading the vocab block above."""
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=_fresh_vocab_user("vocab-schema"))
    prompt = agent._build_prompt(trigger="manual")

    idx = prompt.index('"proposed_issue_type":')
    line_end = prompt.index("\n", idx)
    line = prompt[idx:line_end]

    assert "NEVER" in line
    assert "entity/run/detector id" in line
    assert "duplicate_of_*" in line
    assert "persistent/systemic/recurrence" in line


# ---------------------------------------------------------------------------
# parse_cc_output tests (backward-compat alias)
# ---------------------------------------------------------------------------

def test_parse_cc_output_extracts_result_payload():
    from backend.services.dq_agent import parse_cc_output

    fake_jsonl = "\n".join([
        json.dumps({"type": "system", "subtype": "init", "session_id": "x"}),
        json.dumps({"type": "assistant", "message": {"role": "assistant"}}),
        json.dumps({
            "type": "result",
            "subtype": "success",
            "result": '{"findings": [{"tag": "core", "scope_citation": "S1"}]}',
            "is_error": False,
            "total_cost_usd": 0.42,
        }),
    ])

    parsed, cost = parse_cc_output(fake_jsonl)
    assert len(parsed["findings"]) == 1
    assert parsed["findings"][0]["tag"] == "core"
    assert cost == 0.42


def test_parse_cc_output_strips_markdown_fences():
    from backend.services.dq_agent import parse_cc_output

    fake_jsonl = json.dumps({
        "type": "result",
        "subtype": "success",
        "result": '```json\n{"findings": []}\n```',
        "is_error": False,
        "total_cost_usd": 0.0,
    })

    parsed, cost = parse_cc_output(fake_jsonl)
    assert parsed == {"findings": []}
    assert cost == 0.0


def test_parse_cc_output_raises_without_result():
    import pytest
    from backend.services.dq_agent import parse_cc_output

    fake_jsonl = json.dumps({"type": "system", "subtype": "init"})
    with pytest.raises(ValueError, match="No 'result' event"):
        parse_cc_output(fake_jsonl)


def test_parse_cc_output_skips_malformed_jsonl_lines():
    from backend.services.dq_agent import parse_cc_output

    # Malformed line between the system init and the result; parser should
    # skip it and still find the result event.
    fake_jsonl = "\n".join([
        json.dumps({"type": "system", "subtype": "init"}),
        "{this is not valid json",
        json.dumps({
            "type": "result",
            "subtype": "success",
            "result": '{"findings": []}',
            "is_error": False,
            "total_cost_usd": 0.0,
        }),
    ])

    parsed, cost = parse_cc_output(fake_jsonl)
    assert parsed == {"findings": []}


def test_parse_cc_output_tolerates_prose_prefix():
    """CC sometimes ignores the 'Return ONLY JSON' instruction and adds prose before the object.
    The parser must tolerate this rather than crash."""
    from backend.services.dq_agent import parse_cc_output

    stdout = json.dumps({
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "total_cost_usd": 1.20,
        "result": "Let me compile the output.\n\n{\"findings\": [{\"tag\": \"core\"}]}",
    })
    payload, cost = parse_cc_output(stdout)
    assert payload == {"findings": [{"tag": "core"}]}
    assert cost == 1.20


def test_parse_cc_output_tolerates_trailing_prose():
    """raw_decode bonus: trailing prose after the JSON should also be ignored."""
    from backend.services.dq_agent import parse_cc_output

    stdout = json.dumps({
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "total_cost_usd": 0.50,
        "result": "{\"findings\": []}\n\nHope that helps!",
    })
    payload, cost = parse_cc_output(stdout)
    assert payload == {"findings": []}
    assert cost == 0.50


# ---------------------------------------------------------------------------
# investigate() tests -- Popen-based
# ---------------------------------------------------------------------------

def test_investigate_handles_subprocess_timeout():
    """TimeoutExpired during proc.wait() triggers kill + final wait; result is an error dict.

    We set stderr non-empty so the outcome is classified as a real error (not a
    transient fast-fail), which prevents a retry and keeps the mock simple.
    """
    import subprocess
    from unittest.mock import MagicMock, patch
    from backend.services.dq_agent import DQAgent

    events = [{"type": "system", "subtype": "init"}]
    # stderr non-empty => classified as real error, no retry attempt
    mock_proc = _make_mock_popen(events, returncode=1, stderr="timeout context")
    # First wait(timeout=30) raises; second wait() (after kill) returns normally.
    mock_proc.wait = MagicMock(
        side_effect=[subprocess.TimeoutExpired(cmd=["claude"], timeout=30), None]
    )
    mock_proc.kill = MagicMock()

    with patch("backend.services.dq_agent.subprocess.Popen", return_value=mock_proc):
        agent = DQAgent(user_id=1)
        result = agent.investigate(trigger="manual")

    mock_proc.kill.assert_called_once()
    assert result["findings"] == []
    assert result["total_cost_usd"] == 0.0
    assert "error" in result
    assert result["error"] is not None


def test_investigate_returns_structured_findings_end_to_end():
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent

    events = [
        {"type": "system", "subtype": "init"},
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "total_cost_usd": 0.23,
            "result": json.dumps({
                "findings": [{
                    "tag": "core",
                    "scope_citation": "S1",
                    "issue_type": "reversal_pattern",
                    "entity_type": "global",
                    "entity_id": "skip_gate_prompt",
                    "observation": "Skip-gate overfits on personal-blog phrasing.",
                    "severity": "warning",
                    "rank": 1,
                    "recommendation": {
                        "headline": "Revise skip-gate prompt phrasing",
                        "rationale": "11/14 substack pages marked incorrect.",
                        "self_classification": "judgment",
                        "action_type": "edit_prompt",
                        "affected_entity_ids": ["skip_gate_prompt"],
                    },
                    "handoff_prompt_draft": None,
                }],
            }),
        },
    ]

    with patch("backend.services.dq_agent.subprocess.Popen", return_value=_make_mock_popen(events)):
        agent = DQAgent(user_id=1)
        result = agent.investigate(trigger="manual")

    assert len(result["findings"]) == 1
    assert result["findings"][0]["tag"] == "core"
    assert result["findings"][0]["scope_citation"] == "S1"
    assert result["total_cost_usd"] == 0.23


def test_investigate_handles_subprocess_failure():
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent

    # Non-zero exit, stderr present
    mock_proc = _make_mock_popen([], returncode=1, stderr="claude: auth failed")

    with patch("backend.services.dq_agent.subprocess.Popen", return_value=mock_proc):
        agent = DQAgent(user_id=1)
        result = agent.investigate(trigger="manual")

    assert result["findings"] == []
    assert "error" in result


def test_investigate_handles_malformed_result():
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent

    events = [
        {"type": "system", "subtype": "init"},
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": "not json at all",
        },
    ]

    with patch("backend.services.dq_agent.subprocess.Popen", return_value=_make_mock_popen(events)):
        agent = DQAgent(user_id=1)
        result = agent.investigate(trigger="manual")

    assert result["findings"] == []
    assert "error" in result


def test_build_prompt_embeds_candidates_when_provided():
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=1)
    candidates = [
        {
            "tag": "core",
            "scope_citation": "S1",
            "issue_type": "reversal_pattern",
            "observation": "stub candidate",
            "rank": 1,
        }
    ]
    prompt = agent._build_prompt(trigger="manual", candidates=candidates)

    assert "PRE-DETECTED CANDIDATES" in prompt
    # Compact JSON (no space after colon) -- _build_prompt uses
    # separators=(",", ":") to halve token count for the same payload.
    assert '"scope_citation":"S1"' in prompt
    assert '"observation":"stub candidate"' in prompt


def test_build_prompt_omits_candidates_section_when_none():
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=1)
    prompt = agent._build_prompt(trigger="manual", candidates=None)

    assert "PRE-DETECTED CANDIDATES" not in prompt


def test_build_prompt_omits_candidates_section_when_empty_list():
    from backend.services.dq_agent import DQAgent

    agent = DQAgent(user_id=1)
    prompt = agent._build_prompt(trigger="manual", candidates=[])

    assert "PRE-DETECTED CANDIDATES" not in prompt


def test_investigate_runs_deterministic_investigations_first():
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

    # The investigation's run() was called with the agent's user_id
    mock_inv.assert_called_once_with(user_id=1)
    # The result shape matches the existing investigate contract
    assert result["trigger"] == "manual"
    assert isinstance(result["findings"], list)


def test_investigate_passes_bypass_permissions_flag():
    """Popen argv must include --allowedTools with explicit tool allowlist.

    Without this the agent cannot invoke Bash, Read, Grep, or Glob tools,
    producing empty findings with 0 cost while silently appearing to succeed.
    The explicit allowlist avoids the root-restriction issue with bypassPermissions
    in the worker container.
    """
    from unittest.mock import call, patch
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
    ) as mock_popen:
        agent = DQAgent(user_id=1)
        agent.investigate(trigger="manual")

    called_cmd = mock_popen.call_args[0][0]
    assert "--allowedTools" in called_cmd
    idx = called_cmd.index("--allowedTools")
    assert called_cmd[idx + 1] == "Bash Read Grep Glob"


def test_investigate_uses_stream_json_flag():
    """Popen argv must include --output-format stream-json --verbose."""
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent

    events = [
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "total_cost_usd": 0.0,
            "result": '{"findings": []}',
        },
    ]

    with patch(
        "backend.services.dq_agent.subprocess.Popen",
        return_value=_make_mock_popen(events),
    ) as mock_popen:
        agent = DQAgent(user_id=1)
        agent.investigate(trigger="manual")

    called_cmd = mock_popen.call_args[0][0]
    assert "--output-format" in called_cmd
    idx = called_cmd.index("--output-format")
    assert called_cmd[idx + 1] == "stream-json"
    assert "--verbose" in called_cmd


# ---------------------------------------------------------------------------
# New streaming + retry tests
# ---------------------------------------------------------------------------

def test_investigate_with_on_event_fires_per_event():
    """on_event callback must be called once per valid JSONL event."""
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent

    events = [
        {"type": "system", "subtype": "init"},
        {"type": "assistant", "message": {"role": "assistant", "content": []}},
        {"type": "user", "message": {"role": "user", "content": []}},
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "total_cost_usd": 0.05,
            "result": '{"findings": []}',
        },
    ]

    fired: list[dict] = []

    with patch(
        "backend.services.dq_agent.subprocess.Popen",
        return_value=_make_mock_popen(events),
    ):
        agent = DQAgent(user_id=1)
        agent.investigate(trigger="manual", on_event=fired.append)

    # investigate() also emits a synthetic "_phase"/"agent_starting" event
    # right before launching the subprocess (see dq_run_executor streaming-
    # from-zero fix); the real JSONL stream events follow it 1:1.
    assert len(fired) == len(events) + 1
    types = [e.get("type") for e in fired]
    assert types[0] == "_phase"
    assert "system" in types
    assert "result" in types


def test_investigate_emits_agent_starting_phase_event_before_subprocess_result():
    """Streaming-from-zero fix: investigate() must emit a synthetic
    '_phase'/'agent_starting' event (carrying prompt_bytes) via on_event
    strictly before the subprocess's own 'result' event -- this is the gap
    where the manual-run Live pane previously showed nothing while the
    claude subprocess was starting up."""
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent

    events = [
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "total_cost_usd": 0.05,
            "result": '{"findings": []}',
        },
    ]

    fired: list[dict] = []

    with patch(
        "backend.services.dq_agent.subprocess.Popen",
        return_value=_make_mock_popen(events),
    ):
        agent = DQAgent(user_id=1)
        prompt = agent._build_prompt(trigger="manual")
        agent.investigate(trigger="manual", on_event=fired.append)

    types = [e.get("type") for e in fired]
    assert types == ["_phase", "result"]
    assert fired[0]["subtype"] == "agent_starting"
    # prompt_bytes reflects the actual prompt length passed to the subprocess.
    assert fired[0]["prompt_bytes"] == len(prompt)


def test_investigate_detects_transient_fast_fail_and_retries():
    """First subprocess exits non-zero in <60s with empty stderr; second succeeds."""
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent
    import time

    success_events = [
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "total_cost_usd": 0.12,
            "result": '{"findings": [{"tag": "core", "scope_citation": "S1", "issue_type": "reversal_pattern", "entity_type": "global", "entity_id": "x", "observation": "ok", "severity": "info", "rank": 1, "recommendation": null, "handoff_prompt_draft": null}]}',
        }
    ]

    fail_proc = _make_mock_popen([], returncode=2, stderr="")
    success_proc = _make_mock_popen(success_events, returncode=0)

    call_count = [0]

    def fake_popen(cmd, **kwargs):
        call_count[0] += 1
        if call_count[0] == 1:
            return fail_proc
        return success_proc

    retry_events: list[dict] = []

    # Patch time so attempt 1 looks like it ran in 10s (transient)
    with patch("backend.services.dq_agent.subprocess.Popen", side_effect=fake_popen):
        with patch("backend.services.dq_agent.time") as mock_time_mod:
            # monotonic() returns 0.0 on start, 10.0 on first check (fast fail),
            # then 10.0 again for retry start, 70.0 for retry end (irrelevant).
            mock_time_mod.monotonic.side_effect = [0.0, 10.0, 10.0, 70.0]
            agent = DQAgent(user_id=1)
            result = agent.investigate(
                trigger="manual",
                on_event=retry_events.append,
            )

    assert call_count[0] == 2, "Should have retried exactly once"
    assert result.get("error") is None, f"Expected success but got error: {result.get('error')}"
    assert len(result["findings"]) == 1

    # Verify the synthetic _retry event was emitted
    retry_event_types = [e.get("type") for e in retry_events]
    assert "_retry" in retry_event_types


def test_investigate_does_not_retry_slow_failure():
    """Subprocess exits non-zero at 120s -- no retry, return error."""
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent

    fail_proc = _make_mock_popen([], returncode=1, stderr="")
    call_count = [0]

    def fake_popen(cmd, **kwargs):
        call_count[0] += 1
        return fail_proc

    with patch("backend.services.dq_agent.subprocess.Popen", side_effect=fake_popen):
        with patch("backend.services.dq_agent.time") as mock_time_mod:
            # duration = 120s -- above the 60s transient threshold
            mock_time_mod.monotonic.side_effect = [0.0, 120.0]
            agent = DQAgent(user_id=1)
            result = agent.investigate(trigger="manual")

    assert call_count[0] == 1, "Should not have retried"
    assert result.get("error") is not None
    assert result["findings"] == []


def test_investigate_does_not_retry_when_stderr_populated():
    """First exit has stderr text (a real error) -- no retry."""
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent

    fail_proc = _make_mock_popen([], returncode=1, stderr="Error: authentication failed")
    call_count = [0]

    def fake_popen(cmd, **kwargs):
        call_count[0] += 1
        return fail_proc

    with patch("backend.services.dq_agent.subprocess.Popen", side_effect=fake_popen):
        with patch("backend.services.dq_agent.time") as mock_time_mod:
            mock_time_mod.monotonic.side_effect = [0.0, 20.0]
            agent = DQAgent(user_id=1)
            result = agent.investigate(trigger="manual")

    assert call_count[0] == 1, "Should not have retried when stderr is populated"
    assert result.get("error") is not None
    # Error message should include the stderr content
    assert "authentication failed" in result["error"]


def test_investigate_final_error_when_both_retries_fail():
    """Both attempts fail -- final result has error set, findings=[]."""
    from unittest.mock import patch
    from backend.services.dq_agent import DQAgent

    fail_proc1 = _make_mock_popen([], returncode=1, stderr="")
    fail_proc2 = _make_mock_popen([], returncode=1, stderr="")
    call_count = [0]

    def fake_popen(cmd, **kwargs):
        call_count[0] += 1
        if call_count[0] == 1:
            return fail_proc1
        return fail_proc2

    with patch("backend.services.dq_agent.subprocess.Popen", side_effect=fake_popen):
        with patch("backend.services.dq_agent.time") as mock_time_mod:
            # Both attempts are fast (transient pattern), but both fail
            mock_time_mod.monotonic.side_effect = [0.0, 10.0, 10.0, 20.0]
            agent = DQAgent(user_id=1)
            result = agent.investigate(trigger="manual")

    assert call_count[0] == 2
    assert result.get("error") is not None
    assert "attempt 1 + attempt 2" in result["error"] or result["error"]
    assert result["findings"] == []


def test_investigate_uses_allowedtools_not_bypass(monkeypatch):
    """The claude command pins an explicit tool allowlist and does not use
    bypassPermissions (which refuses to run as root in the worker container)."""
    from backend.services.dq_agent import DQAgent

    captured = {}

    def fake_single_pass(self, cmd, prompt, on_event, on_subprocess_start=None):
        captured["cmd"] = cmd
        return {"returncode": 0, "duration_s": 1.0, "findings": [],
                "total_cost_usd": 0.0, "saw_result": True, "error": None}

    monkeypatch.setattr(DQAgent, "_run_single_pass", fake_single_pass)
    monkeypatch.setattr(DQAgent, "_build_prompt", lambda self, trigger, candidates=None: "P")
    DQAgent(user_id=1).investigate(trigger="manual")

    cmd = captured["cmd"]
    assert "bypassPermissions" not in cmd
    assert "--allowedTools" in cmd
    i = cmd.index("--allowedTools")
    assert cmd[i + 1] == "Bash Read Grep Glob"
