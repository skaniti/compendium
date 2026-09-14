"""dqBot Tier 2 run-kind dispatch (the 2026-07-19 dqbot-tier2-role-split plan, private):
dq_run_executor.execute_run dispatches on DQ_RUN_MODE + run_kind --

  - DQ_RUN_MODE=legacy: today's monolithic path (agent.investigate(
    investigations=[...])), no adjudicator/gate/verdict-history involved.
  - default "tier2", run_kind="sensor": zero-LLM structural detectors ->
    dq_gate.evaluate -> gate_metrics persisted, no observations/recs, a
    confirmed gate enqueues a full run.
  - default "tier2", run_kind="full" (or anything else): detectors ->
    dq_adjudicator.adjudicate -> dq_verdict_history.render_verdict_history ->
    Opus synthesis (agent.investigate(candidates=...)) -> vetoed survivors
    dropped -> persist -> complete_run with adjudication gate_metrics.

Pure unit tests: DQAgent, dq_gate, dq_adjudicator, dq_verdict_history, and
the DB-backed _snapshot_run_id / _run_investigations helpers are all mocked
-- no live LLM calls, no PG connection required.
"""

import os
from unittest.mock import MagicMock, patch

from backend.services import dq_run_executor
from backend.services.dq_investigations import DEFAULT_INVESTIGATIONS, STRUCTURAL_INVESTIGATIONS


# ---------------------------------------------------------------------------
# Sensor run
# ---------------------------------------------------------------------------


def test_sensor_run_investigates_once_gates_and_completes_with_zero_counts():
    """Sensor run: _snapshot_run_id resolved ONCE and threaded into the
    structural investigators; dq_gate.evaluate decides; set_gate_metrics
    persists the verdict; complete_run reports zero counts/cost; no
    DQAgent is ever constructed (zero-LLM detection path)."""
    verdict = {
        "metrics": {"counts": {"S2": 3}, "novel_counts": {"S2": 1}, "novel_total": 1},
        "tripped": True,
        "confirmed": False,
        "reasons": ["novel candidate count 1 >= threshold 10"],
        "confirm_cost_note": None,
    }
    with (
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor, "_snapshot_run_id", return_value=99) as snap,
        patch.object(dq_run_executor, "_run_investigations", return_value=[{"scope_citation": "S2"}]) as run_inv,
        patch.object(dq_run_executor.dq_gate, "evaluate", return_value=verdict) as evaluate,
        patch.object(dq_run_executor.dq_runs_repo, "set_gate_metrics") as set_gm,
        patch.object(dq_run_executor.dq_runs_repo, "enqueue") as enqueue,
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
        patch.object(dq_run_executor, "DQAgent") as agent_cls,
    ):
        dq_run_executor.execute_run(
            user_id=42, run_id=7, trigger="recluster_event", run_kind="sensor",
            investigations=[],
        )

    snap.assert_called_once_with(42)
    run_inv.assert_called_once()
    call_args = run_inv.call_args.args
    assert call_args[0] == 42
    assert call_args[1] == STRUCTURAL_INVESTIGATIONS
    assert call_args[2] == 99  # single snapshot id threaded through

    evaluate.assert_called_once_with(42, [{"scope_citation": "S2"}])

    set_gm.assert_called_once()
    assert set_gm.call_args.args[0] == 7
    metrics = set_gm.call_args.args[1]
    assert metrics["counts"] == {"S2": 3}
    assert metrics["tripped"] is True
    assert metrics["confirmed"] is False
    assert metrics["reasons"] == verdict["reasons"]
    assert metrics["generation"] == 99

    enqueue.assert_not_called()
    complete.assert_called_once_with(7, 0, 0, 0.0)
    fail.assert_not_called()
    agent_cls.assert_not_called()


def test_sensor_run_confirmed_gate_enqueues_full_run():
    """When dq_gate confirms, the sensor run enqueues exactly one signal_gate
    full run -- and still writes zero observations/recommendations itself."""
    verdict = {
        "metrics": {"counts": {"S2": 20}},
        "tripped": True,
        "confirmed": True,
        "reasons": ["S2 raw count 20 > 2x baseline 5"],
        "confirm_cost_note": "confirm step adjudicated 20 novel candidate(s), 8 counted survivor(s)",
    }
    with (
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor, "_snapshot_run_id", return_value=5),
        patch.object(dq_run_executor, "_run_investigations", return_value=[]),
        patch.object(dq_run_executor.dq_gate, "evaluate", return_value=verdict),
        patch.object(dq_run_executor.dq_runs_repo, "set_gate_metrics"),
        patch.object(dq_run_executor.dq_runs_repo, "enqueue") as enqueue,
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
    ):
        dq_run_executor.execute_run(
            user_id=42, run_id=7, trigger="recluster_event", run_kind="sensor",
            investigations=[],
        )

    enqueue.assert_called_once_with(42, "signal_gate", run_kind="full")
    complete.assert_called_once_with(7, 0, 0, 0.0)
    fail.assert_not_called()


def test_sensor_run_unconfirmed_gate_never_enqueues():
    verdict = {
        "metrics": {"counts": {}},
        "tripped": False,
        "confirmed": False,
        "reasons": [],
        "confirm_cost_note": None,
    }
    with (
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor, "_snapshot_run_id", return_value=5),
        patch.object(dq_run_executor, "_run_investigations", return_value=[]),
        patch.object(dq_run_executor.dq_gate, "evaluate", return_value=verdict),
        patch.object(dq_run_executor.dq_runs_repo, "set_gate_metrics"),
        patch.object(dq_run_executor.dq_runs_repo, "enqueue") as enqueue,
        patch.object(dq_run_executor.dq_runs_repo, "complete_run"),
        patch.object(dq_run_executor.dq_runs_repo, "fail_run"),
    ):
        dq_run_executor.execute_run(
            user_id=42, run_id=7, trigger="recluster_event", run_kind="sensor",
            investigations=[],
        )
    enqueue.assert_not_called()


# ---------------------------------------------------------------------------
# Full run
# ---------------------------------------------------------------------------


def test_full_run_phase_order_and_veto_exclusion_and_gate_metrics():
    """Full run: snapshot -> detectors -> adjudicate -> verdict history ->
    Opus synthesis -> persist, in that order. A survivor Opus vetoes must
    never reach persist_findings. complete_run's gate_metrics carries the
    adjudication stats, generation, and vetoed count."""
    order: list[str] = []
    survivors = [
        {"entity_id": "e1", "scope_citation": "S2"},
        {"entity_id": "e2", "scope_citation": "S1"},
    ]
    adj_stats = {"judged": 2, "passed_through": 0, "suppressed": 0, "skipped_batches": 0}
    suppressed = [{"candidate": {"entity_id": "e0"}, "reason": "coherent with label", "confidence": 0.9}]

    def fake_snapshot(user_id):
        order.append("snapshot")
        assert user_id == 42
        return 55

    def fake_run_investigations(user_id, investigations, recluster_run_id, on_event=None):
        order.append("detectors")
        assert user_id == 42
        assert investigations == DEFAULT_INVESTIGATIONS
        assert recluster_run_id == 55
        return [{"raw": True}]

    def fake_adjudicate(candidates, user_id):
        order.append("adjudicate")
        assert candidates == [{"raw": True}]
        assert user_id == 42
        return {"survivors": survivors, "suppressed": suppressed, "stats": adj_stats}

    def fake_render_history(user_id):
        order.append("verdict_history")
        assert user_id == 42
        return "HISTORY_TEXT"

    agent = MagicMock()

    def fake_investigate(**kwargs):
        order.append("agent_investigate")
        assert kwargs["candidates"] == survivors
        assert kwargs["verdict_history"] == "HISTORY_TEXT"
        assert kwargs["adjudication_summary"]["judged"] == 2
        assert kwargs["adjudication_summary"]["suppressed_samples"] == ["coherent with label"]
        return {
            "findings": [
                {"entity_id": "e1", "note": "should be dropped"},
                {"entity_id": "e2", "note": "should survive"},
            ],
            "vetoed": [{"entity_id": "e1", "reason": "not actually incoherent"}],
            "total_cost_usd": 1.23,
        }

    agent.investigate.side_effect = fake_investigate

    def fake_persist(**kwargs):
        order.append("persist")
        return {"observations_written": 1, "recommendations_written": 1}

    agent.persist_findings.side_effect = fake_persist

    with (
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor, "_snapshot_run_id", side_effect=fake_snapshot),
        patch.object(dq_run_executor, "_run_investigations", side_effect=fake_run_investigations),
        patch.object(dq_run_executor.dq_adjudicator, "adjudicate", side_effect=fake_adjudicate),
        patch.object(dq_run_executor.dq_verdict_history, "render_verdict_history", side_effect=fake_render_history),
        patch.object(dq_run_executor, "DQAgent", return_value=agent),
        patch.object(dq_run_executor.dq_runs_repo, "is_abort_requested", return_value=False),
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
    ):
        dq_run_executor.execute_run(
            user_id=42, run_id=7, trigger="manual", run_kind="full", investigations=[],
        )

    assert order == ["snapshot", "detectors", "adjudicate", "verdict_history", "agent_investigate", "persist"]

    persisted_findings = agent.persist_findings.call_args.kwargs["findings"]
    persisted_entity_ids = {f["entity_id"] for f in persisted_findings}
    assert "e1" not in persisted_entity_ids  # vetoed by Opus
    assert "e2" in persisted_entity_ids

    complete.assert_called_once()
    args, kwargs = complete.call_args
    assert args[0] == 7
    assert args[1] == 1  # observations_written
    assert args[2] == 1  # recommendations_written
    assert args[3] == 1.23  # total_cost_usd
    assert kwargs["gate_metrics"]["adjudication"] == adj_stats
    assert kwargs["gate_metrics"]["generation"] == 55
    assert kwargs["gate_metrics"]["vetoed"] == 1
    fail.assert_not_called()


def test_full_run_agent_error_fails_without_persisting():
    with (
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor, "_snapshot_run_id", return_value=1),
        patch.object(dq_run_executor, "_run_investigations", return_value=[]),
        patch.object(dq_run_executor.dq_adjudicator, "adjudicate",
                     return_value={"survivors": [], "suppressed": [], "stats": {}}),
        patch.object(dq_run_executor.dq_verdict_history, "render_verdict_history", return_value=""),
        patch.object(dq_run_executor, "DQAgent") as agent_cls,
        patch.object(dq_run_executor.dq_runs_repo, "is_abort_requested", return_value=False),
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
    ):
        agent = agent_cls.return_value
        agent.investigate.return_value = {"findings": [], "total_cost_usd": 0.0, "error": "opus boom"}
        dq_run_executor.execute_run(
            user_id=42, run_id=7, trigger="manual", run_kind="full", investigations=[],
        )
        agent.persist_findings.assert_not_called()

    complete.assert_not_called()
    fail.assert_called_once_with(7, "opus boom")


def test_full_run_abort_skips_persist():
    with (
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor, "_snapshot_run_id", return_value=1),
        patch.object(dq_run_executor, "_run_investigations", return_value=[]),
        patch.object(dq_run_executor.dq_adjudicator, "adjudicate",
                     return_value={"survivors": [], "suppressed": [], "stats": {}}),
        patch.object(dq_run_executor.dq_verdict_history, "render_verdict_history", return_value=""),
        patch.object(dq_run_executor, "DQAgent") as agent_cls,
        patch.object(dq_run_executor.dq_runs_repo, "is_abort_requested", return_value=True),
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
    ):
        agent = agent_cls.return_value
        agent.investigate.return_value = {"findings": [], "total_cost_usd": 0.0}
        dq_run_executor.execute_run(
            user_id=42, run_id=7, trigger="manual", run_kind="full", investigations=[],
        )
        agent.persist_findings.assert_not_called()

    complete.assert_not_called()
    fail.assert_called_once_with(7, "aborted by user")


# ---------------------------------------------------------------------------
# DQ_RUN_MODE=legacy
# ---------------------------------------------------------------------------


def test_legacy_mode_runs_monolithic_investigate_with_no_adjudicator():
    """DQ_RUN_MODE=legacy bypasses the sensor/full split entirely: the
    deterministic pass runs INSIDE agent.investigate(investigations=[...]),
    and dq_adjudicator/dq_gate/dq_verdict_history are never touched --
    regardless of what run_kind the caller passes."""
    agent = MagicMock()
    agent.investigate.return_value = {"findings": [{"x": 1}], "total_cost_usd": 0.5}
    agent.persist_findings.return_value = {"observations_written": 2, "recommendations_written": 1}

    with (
        patch.dict(os.environ, {"DQ_RUN_MODE": "legacy"}, clear=False),
        patch.object(dq_run_executor, "DQAgent", return_value=agent),
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor.dq_runs_repo, "is_abort_requested", return_value=False),
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
        patch.object(dq_run_executor, "_snapshot_run_id") as snap,
        patch.object(dq_run_executor.dq_adjudicator, "adjudicate") as adjudicate,
        patch.object(dq_run_executor.dq_gate, "evaluate") as gate_evaluate,
        patch.object(dq_run_executor.dq_verdict_history, "render_verdict_history") as render_history,
    ):
        dq_run_executor.execute_run(
            user_id=42, run_id=7, trigger="schedule", run_kind="full",
            investigations=["cluster_coherence_drift"],
        )

    agent.investigate.assert_called_once()
    call_kwargs = agent.investigate.call_args.kwargs
    assert call_kwargs["investigations"] == ["cluster_coherence_drift"]
    assert call_kwargs["trigger"] == "schedule"
    assert "candidates" not in call_kwargs
    assert "verdict_history" not in call_kwargs
    assert "adjudication_summary" not in call_kwargs

    snap.assert_not_called()
    adjudicate.assert_not_called()
    gate_evaluate.assert_not_called()
    render_history.assert_not_called()

    complete.assert_called_once_with(
        run_id=7, observations_written=2, recommendations_written=1, llm_cost_usd=0.5
    )
    fail.assert_not_called()


def test_legacy_mode_ignores_sensor_run_kind():
    """Even a claimed row with run_kind='sensor' runs the monolithic legacy
    path when DQ_RUN_MODE=legacy -- run_kind is a Tier-2-only concept."""
    agent = MagicMock()
    agent.investigate.return_value = {"findings": [], "total_cost_usd": 0.0}
    agent.persist_findings.return_value = {"observations_written": 0, "recommendations_written": 0}

    with (
        patch.dict(os.environ, {"DQ_RUN_MODE": "legacy"}, clear=False),
        patch.object(dq_run_executor, "DQAgent", return_value=agent),
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor.dq_runs_repo, "is_abort_requested", return_value=False),
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run"),
        patch.object(dq_run_executor.dq_gate, "evaluate") as gate_evaluate,
    ):
        dq_run_executor.execute_run(
            user_id=42, run_id=7, trigger="recluster_event", run_kind="sensor",
            investigations=["cluster_coherence_drift"],
        )

    gate_evaluate.assert_not_called()
    call_kwargs = agent.investigate.call_args.kwargs
    assert call_kwargs["trigger"] == "recluster_event"
    assert call_kwargs["investigations"] == ["cluster_coherence_drift"]
    assert "candidates" not in call_kwargs
    complete.assert_called_once()

def test_full_run_drops_findings_matching_suppressed_candidates():
    """Structural veto-contract enforcement (final-review F2): a finding
    Opus files on the identity triple of an adjudicator-suppressed
    candidate must never reach persist_findings, even though the prompt
    also forbids it."""
    suppressed = [{
        "candidate": {
            "entity_type": "cluster",
            "entity_id": "dead-beef-stable-id",
            "issue_type": "cluster_coherence_drift",
        },
        "reason": "coherent with label",
        "confidence": 0.9,
    }]
    survivors = [{"entity_id": "kept", "entity_type": "cluster",
                  "issue_type": "cluster_coherence_drift", "scope_citation": "S2"}]

    agent = MagicMock()
    agent.investigate.return_value = {
        "findings": [
            # Opus re-discovered the suppressed cluster on its own:
            {"entity_type": "cluster", "entity_id": "dead-beef-stable-id",
             "issue_type": "cluster_coherence_drift"},
            # legit survivor re-emission:
            {"entity_type": "cluster", "entity_id": "kept",
             "issue_type": "cluster_coherence_drift"},
        ],
        "vetoed": [],
        "total_cost_usd": 0.5,
    }
    agent.persist_findings.return_value = {
        "observations_written": 1, "recommendations_written": 1,
    }

    with (
        patch.object(dq_run_executor, "set_current_user_id"),
        patch.object(dq_run_executor, "_snapshot_run_id", return_value=60),
        patch.object(dq_run_executor, "_run_investigations", return_value=[]),
        patch.object(
            dq_run_executor.dq_adjudicator, "adjudicate",
            return_value={"survivors": survivors, "suppressed": suppressed,
                          "stats": {"judged": 2, "passed_through": 0,
                                    "suppressed": 1, "skipped_batches": 0}},
        ),
        patch.object(dq_run_executor.dq_verdict_history, "render_verdict_history", return_value="H"),
        patch.object(dq_run_executor, "DQAgent", return_value=agent),
        patch.object(dq_run_executor.dq_runs_repo, "is_abort_requested", return_value=False),
        patch.object(dq_run_executor.dq_runs_repo, "complete_run") as complete,
        patch.object(dq_run_executor.dq_runs_repo, "fail_run") as fail,
    ):
        dq_run_executor.execute_run(
            user_id=42, run_id=8, trigger="schedule", run_kind="full", investigations=[],
        )

    persisted = agent.persist_findings.call_args.kwargs["findings"]
    persisted_ids = {f["entity_id"] for f in persisted}
    assert "dead-beef-stable-id" not in persisted_ids
    assert "kept" in persisted_ids
    assert complete.call_args.kwargs["gate_metrics"]["suppressed_resurrections_dropped"] == 1
    fail.assert_not_called()
