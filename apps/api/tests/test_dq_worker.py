"""Worker loop: claim a queued run, pick the investigation set by trigger, execute.

dqBot Tier 2 (docs/project-plans/2026-07-19-131356-dqbot-tier2-role-split/):
claimed rows now carry run_kind (sensor vs full); poll_once passes it
straight through to dq_run_executor.execute_run, which owns the actual
sensor/full dispatch. See test_poll_once_dispatches_by_claimed_run_kind."""

from unittest.mock import patch

from backend.services import dq_worker
from backend.services.dq_investigations import DEFAULT_INVESTIGATIONS, STRUCTURAL_INVESTIGATIONS


def test_poll_once_runs_claimed_job():
    claimed = {"id": 7, "user_id": 42, "trigger": "schedule", "run_kind": "full", "status": "running"}
    captured = {}
    with (
        patch.object(dq_worker.dq_runs_repo, "claim_next_queued_run", return_value=claimed),
        patch.object(dq_worker.dq_run_executor, "execute_run",
                     side_effect=lambda **kw: captured.update(kw)),
    ):
        ran = dq_worker.poll_once()
    assert ran is True
    assert captured["user_id"] == 42
    assert captured["run_id"] == 7
    assert captured["trigger"] == "schedule"
    assert captured["run_kind"] == "full"
    assert captured["investigations"] == DEFAULT_INVESTIGATIONS


def test_poll_once_recluster_uses_structural_set():
    claimed = {"id": 8, "user_id": 42, "trigger": "recluster_event", "run_kind": "sensor", "status": "running"}
    captured = {}
    with (
        patch.object(dq_worker.dq_runs_repo, "claim_next_queued_run", return_value=claimed),
        patch.object(dq_worker.dq_run_executor, "execute_run",
                     side_effect=lambda **kw: captured.update(kw)),
    ):
        dq_worker.poll_once()
    assert captured["investigations"] == STRUCTURAL_INVESTIGATIONS


def test_poll_once_dispatches_by_claimed_run_kind():
    """dqBot Tier 2: the claimed row's run_kind flows straight through to
    the executor -- the executor (not the worker) does the sensor/full
    dispatch. A recluster_event row claimed with run_kind='sensor' must
    reach execute_run with that exact run_kind, distinct from the
    trigger-keyed investigation set (which stays legacy-only)."""
    claimed = {"id": 12, "user_id": 42, "trigger": "recluster_event", "run_kind": "sensor", "status": "running"}
    captured = {}
    with (
        patch.object(dq_worker.dq_runs_repo, "claim_next_queued_run", return_value=claimed),
        patch.object(dq_worker.dq_run_executor, "execute_run",
                     side_effect=lambda **kw: captured.update(kw)),
    ):
        dq_worker.poll_once()
    assert captured["run_kind"] == "sensor"

    claimed_full = {"id": 13, "user_id": 42, "trigger": "manual", "run_kind": "full", "status": "running"}
    captured2 = {}
    with (
        patch.object(dq_worker.dq_runs_repo, "claim_next_queued_run", return_value=claimed_full),
        patch.object(dq_worker.dq_run_executor, "execute_run",
                     side_effect=lambda **kw: captured2.update(kw)),
    ):
        dq_worker.poll_once()
    assert captured2["run_kind"] == "full"


def test_poll_once_returns_false_when_idle():
    with (
        patch.object(dq_worker.dq_runs_repo, "claim_next_queued_run", return_value=None),
        patch.object(dq_worker.dq_run_executor, "execute_run") as ex,
    ):
        ran = dq_worker.poll_once()
    assert ran is False
    ex.assert_not_called()


def test_investigations_for_trigger():
    assert dq_worker._investigations_for("recluster_event") == STRUCTURAL_INVESTIGATIONS
    assert dq_worker._investigations_for("schedule") == DEFAULT_INVESTIGATIONS
    assert dq_worker._investigations_for("manual") == DEFAULT_INVESTIGATIONS


def test_poll_once_manual_wires_event_persister():
    """Manual runs get an on_event that appends to dq_run_events (live pane streams)."""
    claimed = {"id": 9, "user_id": 42, "trigger": "manual", "run_kind": "full", "status": "running"}
    captured = {}
    appended = []
    with (
        patch.object(dq_worker.dq_runs_repo, "claim_next_queued_run", return_value=claimed),
        patch.object(dq_worker.dq_run_executor, "execute_run",
                     side_effect=lambda **kw: captured.update(kw)),
        patch.object(dq_worker.dq_run_events_repo, "append_event",
                     side_effect=lambda **kw: appended.append(kw)),
    ):
        dq_worker.poll_once()
        on_event = captured["on_event"]
        assert on_event is not None
        on_event({"type": "assistant"})
        on_event({"type": "result"})
    assert [a["seq"] for a in appended] == [0, 1]
    assert appended[0]["run_id"] == 9
    assert appended[0]["user_id"] == 42
    assert appended[0]["event_type"] == "assistant"


def test_poll_once_scheduled_persists_result_event():
    """Scheduled/recluster runs get a filtered persister (migration 040 run
    forensics), not on_event=None: only 'result'/'_retry' event types reach
    dq_run_events, so a failed unattended run still leaves a forensic trail
    without the per-event write load of the full stream."""
    claimed = {"id": 10, "user_id": 42, "trigger": "schedule", "run_kind": "full", "status": "running"}
    captured = {}
    appended = []
    with (
        patch.object(dq_worker.dq_runs_repo, "claim_next_queued_run", return_value=claimed),
        patch.object(dq_worker.dq_run_executor, "execute_run",
                     side_effect=lambda **kw: captured.update(kw)),
        patch.object(dq_worker.dq_run_events_repo, "append_event",
                     side_effect=lambda **kw: appended.append(kw)),
    ):
        dq_worker.poll_once()
        on_event = captured["on_event"]
        assert on_event is not None
        on_event({"type": "assistant"})  # filtered out -- not forensic
        on_event({"type": "tool_use"})  # filtered out -- not forensic
        on_event({"type": "result", "subtype": "success"})  # persisted
    assert len(appended) == 1
    assert appended[0]["event_type"] == "result"
    assert appended[0]["run_id"] == 10
    assert appended[0]["user_id"] == 42


def test_poll_once_scheduled_persists_retry_event():
    """'_retry' diagnostic events also pass the filter for recluster_event runs."""
    claimed = {"id": 11, "user_id": 42, "trigger": "recluster_event", "run_kind": "sensor", "status": "running"}
    captured = {}
    appended = []
    with (
        patch.object(dq_worker.dq_runs_repo, "claim_next_queued_run", return_value=claimed),
        patch.object(dq_worker.dq_run_executor, "execute_run",
                     side_effect=lambda **kw: captured.update(kw)),
        patch.object(dq_worker.dq_run_events_repo, "append_event",
                     side_effect=lambda **kw: appended.append(kw)),
    ):
        dq_worker.poll_once()
        on_event = captured["on_event"]
        on_event({"type": "_retry", "attempt": 1})
    assert len(appended) == 1
    assert appended[0]["event_type"] == "_retry"


# ---------------------------------------------------------------------------
# _run_startup_canary -- readonly-grants check at worker startup
# ---------------------------------------------------------------------------


def test_startup_canary_logs_error_on_failure(caplog):
    """verify_readonly_grants() returning an error text logs ERROR with a
    remediation hint; startup must not raise."""
    with patch.object(dq_worker, "verify_readonly_grants", return_value="permission denied for table dq_runs"):
        with caplog.at_level("ERROR"):
            dq_worker._run_startup_canary()
    assert any("readonly-grants canary FAILED" in r.message for r in caplog.records)
    assert any("migration 040" in r.message for r in caplog.records)


def test_startup_canary_logs_info_on_success():
    with patch.object(dq_worker, "verify_readonly_grants", return_value=None):
        dq_worker._run_startup_canary()  # must not raise


def test_startup_canary_does_not_crash_on_exception(caplog):
    """A raised exception from the canary must not propagate -- worker startup
    must not crash on canary failure."""
    with patch.object(dq_worker, "verify_readonly_grants", side_effect=RuntimeError("db down")):
        with caplog.at_level("ERROR"):
            dq_worker._run_startup_canary()  # must not raise
    assert any("canary crashed unexpectedly" in r.message for r in caplog.records)
