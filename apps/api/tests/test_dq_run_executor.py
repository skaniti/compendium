"""execute_run: the runtime-agnostic run driver (investigate -> persist -> complete/fail).

dqBot Tier 2 (the 2026-07-19 dqbot-tier2-role-split plan, private)
split execute_run's dispatch on DQ_RUN_MODE + run_kind; this file's tests
predate that split and all exercise the DQ_RUN_MODE=legacy path (the
`fake_investigate` fakes below take `(trigger, investigations, on_event,
on_subprocess_start)` -- the legacy monolithic call shape). The autouse
fixture below pins DQ_RUN_MODE=legacy so they keep testing that path.
Tier-2 sensor/full dispatch coverage lives in tests/test_dq_run_kinds.py."""

import pytest

from unittest.mock import MagicMock, patch

from backend.services import dq_run_executor


@pytest.fixture(autouse=True)
def _legacy_run_mode(monkeypatch):
    monkeypatch.setenv("DQ_RUN_MODE", "legacy")


def test_execute_run_persists_and_completes_on_success():
    agent = MagicMock()
    agent.investigate.return_value = {"findings": [{"x": 1}], "total_cost_usd": 0.5}
    agent.persist_findings.return_value = {"observations_written": 2, "recommendations_written": 1}

    with (
        patch.object(dq_run_executor, "DQAgent", return_value=agent),
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
    ):
        dq_run_executor.execute_run(user_id=42, run_id=7, trigger="schedule", run_kind="full",
                                    investigations=["cluster_coherence_drift"])

    complete.assert_called_once_with(
        run_id=7, observations_written=2, recommendations_written=1, llm_cost_usd=0.5
    )
    fail.assert_not_called()


def test_execute_run_fails_on_agent_error():
    agent = MagicMock()
    agent.investigate.return_value = {"findings": [], "total_cost_usd": 0.0, "error": "boom"}

    with (
        patch.object(dq_run_executor, "DQAgent", return_value=agent),
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
    ):
        dq_run_executor.execute_run(user_id=42, run_id=7, trigger="schedule", run_kind="full",
                                    investigations=[])

    fail.assert_called_once()
    assert fail.call_args.args[0] == 7
    complete.assert_not_called()


def test_execute_run_fails_on_exception():
    agent = MagicMock()
    agent.investigate.side_effect = RuntimeError("kaboom")

    with (
        patch.object(dq_run_executor, "DQAgent", return_value=agent),
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
    ):
        dq_run_executor.execute_run(user_id=42, run_id=7, trigger="manual", run_kind="full",
                                    investigations=[])

    fail.assert_called_once()
    assert "kaboom" in fail.call_args.args[1]


def test_execute_run_aborts_when_flag_set():
    """When abort is requested, the run terminates the subprocess and fails as aborted."""

    class FakeProc:
        def __init__(self):
            self.terminated = False
        def terminate(self):
            self.terminated = True

    proc = FakeProc()

    def fake_investigate(trigger, investigations, on_event, on_subprocess_start):
        on_subprocess_start(proc)        # executor captures the proc
        on_event({"type": "assistant"})  # triggers the throttled abort check
        return {"findings": [], "total_cost_usd": 0.0}

    agent = MagicMock()
    agent.investigate.side_effect = fake_investigate

    # execute_run now emits a synthetic "_phase"/"run_claimed" event through
    # _on_event before agent.investigate() runs, which consumes the first
    # throttle slot (last_check starts at 0.0, so a monotonic() of 0.0 there
    # does NOT clear the >=2s throttle). Mock monotonic so the run_claimed
    # check is a no-op (t=0.0) and the "assistant" event's check lands well
    # past the throttle window (t=100.0), matching the original two-events-
    # apart intent deterministically instead of relying on real wall time.
    with (
        patch.object(dq_run_executor, "DQAgent", return_value=agent),
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor.dq_runs_repo, "is_abort_requested", return_value=True),
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
        patch.object(dq_run_executor.time, "monotonic", side_effect=[0.0, 100.0]),
    ):
        dq_run_executor.execute_run(user_id=42, run_id=7, trigger="manual", run_kind="full",
                                    investigations=[])

    assert proc.terminated is True
    complete.assert_not_called()
    fail.assert_called_once()
    assert "abort" in fail.call_args.args[1].lower()


def test_execute_run_emits_run_claimed_phase_event_before_agent_work():
    """Manual runs must stream life from second zero: a synthetic
    '_phase'/'run_claimed' event should reach on_event immediately after the
    user context is set, strictly before agent.investigate() is invoked --
    that's the multi-minute deterministic-investigator gap the frontend Live
    pane previously showed nothing for."""
    seen: list[dict] = []
    order: list[str] = []

    def fake_investigate(trigger, investigations, on_event, on_subprocess_start):
        order.append("investigate_called")
        return {"findings": [], "total_cost_usd": 0.0}

    agent = MagicMock()
    agent.investigate.side_effect = fake_investigate

    with (
        patch.object(dq_run_executor, "DQAgent", return_value=agent),
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor.dq_runs_repo, "is_abort_requested", return_value=False),
        patch.object(dq_run_executor.dq_runs_repo, "complete_run"),
        patch.object(dq_run_executor.dq_runs_repo, "fail_run"),
    ):
        def _on_event(event):
            if event.get("type") == "_phase":
                order.append("run_claimed_event")
            seen.append(event)

        dq_run_executor.execute_run(
            user_id=42, run_id=7, trigger="manual", run_kind="full",
            investigations=["cluster_coherence_drift"], on_event=_on_event,
        )

    phase_events = [e for e in seen if e.get("type") == "_phase"]
    assert len(phase_events) == 1
    assert phase_events[0] == {
        "type": "_phase",
        "subtype": "run_claimed",
        "trigger": "manual",
        "investigations": ["cluster_coherence_drift"],
    }
    # Ordering: the phase event must precede the (mocked) agent work.
    assert order == ["run_claimed_event", "investigate_called"]


def test_execute_run_run_claimed_event_survives_on_event_exception():
    """The run_claimed emission is best-effort: an exception from a caller's
    on_event callback must not abort the run (mirrors the existing _retry
    emission guard in dq_agent.investigate)."""
    agent = MagicMock()
    agent.investigate.return_value = {"findings": [], "total_cost_usd": 0.0}
    agent.persist_findings.return_value = {"observations_written": 0, "recommendations_written": 0}

    def flaky_on_event(event):
        raise RuntimeError("frontend poller boom")

    with (
        patch.object(dq_run_executor, "DQAgent", return_value=agent),
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor.dq_runs_repo, "is_abort_requested", return_value=False),
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
    ):
        dq_run_executor.execute_run(
            user_id=42, run_id=7, trigger="manual", run_kind="full", investigations=[],
            on_event=flaky_on_event,
        )

    complete.assert_called_once()
    fail.assert_not_called()
