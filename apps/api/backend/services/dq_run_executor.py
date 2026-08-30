"""Runtime-agnostic DQ run driver: investigate -> persist -> complete/fail.

Originally extracted from the now-removed `run_investigation_for_user` in
backend.api.routers.dq_bot so the worker process can run it without importing
the FastAPI app (the router pulls verify_api_key from backend.api.main). The
in-memory abort registry is gone; abort is a DB flag polled here during streaming.

dqBot Tier 2 (docs/project-plans/2026-07-19-131356-dqbot-tier2-role-split/):
`execute_run` now dispatches on `run_kind` -- `_execute_sensor_run` (zero-LLM
structural detectors + the deterministic dq_gate, no persistence) vs
`_execute_full_run` (detectors + gpt-4o-mini adjudication + Opus synthesis,
same persist -> complete/fail shape as before). `DQ_RUN_MODE=legacy`
(dq_scheduler.DQ_RUN_MODE, read at call time so tests/callers can flip it
without a reload) bypasses the split entirely and runs `_execute_legacy` --
today's monolithic `agent.investigate(investigations=[...])` call,
byte-for-byte. The abort-polling scaffolding in `execute_run` wraps every
mode; only the full-run/legacy paths ever populate a subprocess handle (the
sensor path spawns no claude subprocess), so the terminate branch is a no-op
there."""

from __future__ import annotations

import importlib
import logging
import os
import time
from typing import Callable, Optional
import subprocess

from backend.db import dq_runs_repo
from backend.db.connection import get_conn, set_current_user_id
from backend.services import dq_adjudicator, dq_gate, dq_scheduler, dq_verdict_history
from backend.services.dq_agent import DQAgent, DQ_MAX_CANDIDATES_PER_INVESTIGATOR
from backend.services.dq_investigations import DEFAULT_INVESTIGATIONS, STRUCTURAL_INVESTIGATIONS

logger = logging.getLogger(__name__)

_ABORT_CHECK_INTERVAL_SEC = 2.0


def _run_mode() -> str:
    """DQ_RUN_MODE, read at call time. dq_scheduler owns the env var name
    (its enqueue semantics and this executor's dispatch must stay in
    lockstep on one flag)."""
    return os.environ.get(dq_scheduler.DQ_RUN_MODE, "tier2")


def _snapshot_run_id(user_id: int) -> int | None:
    """The full-pass generation snapshot: this user's latest completed
    recluster_run id, resolved ONCE per pass and threaded verbatim into
    every investigator so a recluster completing mid-pass can't split
    findings across two generations (see dq_investigations/__init__.py)."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM recluster_runs WHERE user_id = %s AND status = 'completed' "
            "ORDER BY completed_at DESC LIMIT 1", (user_id,))
        row = cur.fetchone()
    return row[0] if row else None


def _run_investigations(
    user_id: int,
    investigations: list[str],
    recluster_run_id: int | None,
    on_event: Optional[Callable[[dict], None]] = None,
) -> list[dict]:
    """Mirrors DQAgent._run_deterministic_investigations, threading an
    explicit recluster_run_id (the generation snapshot above) instead of
    letting each investigator resolve its own latest-completed run. The
    agent's own copy is untouched and still used by the legacy monolithic
    path (which has no generation snapshot to thread)."""
    candidates: list[dict] = []
    for name in investigations:
        if on_event is not None:
            try:
                on_event({"type": "_phase", "subtype": "investigator_start", "name": name})
            except Exception:
                logger.exception("[dq] on_event callback raised on investigator_start; continuing")

        module = importlib.import_module(f"backend.services.dq_investigations.{name}")
        inv_out = module.run(user_id=user_id, recluster_run_id=recluster_run_id)
        # Same per-investigator cap as the agent's legacy copy -- prompt
        # verboseness only, not a correctness bound.
        if len(inv_out) > DQ_MAX_CANDIDATES_PER_INVESTIGATOR:
            logger.info(
                "[dq] investigator %s produced %d candidates; capping to %d",
                name, len(inv_out), DQ_MAX_CANDIDATES_PER_INVESTIGATOR,
            )
            inv_out = inv_out[:DQ_MAX_CANDIDATES_PER_INVESTIGATOR]
        candidates.extend(inv_out)

        if on_event is not None:
            try:
                on_event({
                    "type": "_phase",
                    "subtype": "investigator_done",
                    "name": name,
                    "candidates": len(inv_out),
                })
            except Exception:
                logger.exception("[dq] on_event callback raised on investigator_done; continuing")
    return candidates


def _execute_sensor_run(
    user_id: int,
    run_id: int,
    on_event: Optional[Callable[[dict], None]],
) -> None:
    """Zero-LLM structural pass -> deterministic dq_gate decision.

    Writes NO observations/recommendations -- only gate_metrics (and, when
    the gate confirms, a queued full run). `complete_run` always reports
    zero counts and zero cost; the gate's own confirm step cost (if any)
    lives in `dq_gate`'s telemetry, not here."""
    gen = _snapshot_run_id(user_id)
    candidates = _run_investigations(user_id, STRUCTURAL_INVESTIGATIONS, gen, on_event)
    verdict = dq_gate.evaluate(user_id, candidates)
    dq_runs_repo.set_gate_metrics(run_id, {
        **verdict["metrics"],
        "tripped": verdict["tripped"],
        "confirmed": verdict["confirmed"],
        "reasons": verdict["reasons"],
        "generation": gen,
    })
    if verdict["confirmed"]:
        dq_runs_repo.enqueue(user_id, "signal_gate", run_kind="full")
    dq_runs_repo.complete_run(run_id, 0, 0, 0.0)


def _execute_full_run(
    user_id: int,
    run_id: int,
    trigger: str,
    on_event: Optional[Callable[[dict], None]],
    on_subprocess_start: Optional[Callable[["subprocess.Popen"], None]],
) -> None:
    """Detectors -> gpt-4o-mini adjudication -> Opus synthesis -> persist.

    Abort/failure handling matches `_execute_legacy` exactly: abort is
    checked before persisting, an agent error fails the run without
    persisting, and survivors Opus vetoes never reach `persist_findings`."""
    gen = _snapshot_run_id(user_id)
    candidates = _run_investigations(user_id, DEFAULT_INVESTIGATIONS, gen, on_event)
    adj = dq_adjudicator.adjudicate(candidates, user_id)
    history = dq_verdict_history.render_verdict_history(user_id)
    agent = DQAgent(user_id=user_id)
    result = agent.investigate(
        trigger=trigger,
        on_event=on_event,
        on_subprocess_start=on_subprocess_start,
        candidates=adj["survivors"],
        verdict_history=history,
        adjudication_summary=adj["stats"] | {
            "suppressed_samples": [
                s["reason"] or "(no reason recorded)"
                for s in adj["suppressed"][:10]
            ]
        },
    )
    if dq_runs_repo.is_abort_requested(run_id):
        logger.info("dq run %s: aborted by user; skipping persist", run_id)
        dq_runs_repo.fail_run(run_id, "aborted by user")
        return
    if result.get("error") is not None:
        logger.warning("dq run %s: agent error: %s", run_id, str(result["error"])[:500])
        dq_runs_repo.fail_run(run_id, result["error"])
        return
    # str-coerce both sides: findings' entity_id is coerced below, and Opus
    # may emit a veto entity_id as an int for integer-keyed entities.
    vetoed_ids = {str(v.get("entity_id")) for v in result.get("vetoed", [])}
    findings = [f for f in result.get("findings", []) if str(f.get("entity_id")) not in vetoed_ids]

    # Structural enforcement of "Opus may NOT resurrect suppressed
    # candidates" (spec's veto contract; final-review F2). The prompt says
    # it, but Opus explores the DB and can re-discover a suppressed FP as
    # its "own" finding -- the exact rec-260 class this build removes.
    # Filter on the same identity triple the dedup ledger uses.
    suppressed_keys = {
        (
            str((s.get("candidate") or {}).get("entity_type")),
            str((s.get("candidate") or {}).get("entity_id")),
            (s.get("candidate") or {}).get("issue_type"),
        )
        for s in adj["suppressed"]
    }
    resurrected = [
        f for f in findings
        if (str(f.get("entity_type")), str(f.get("entity_id")), f.get("issue_type"))
        in suppressed_keys
    ]
    if resurrected:
        logger.warning(
            "dq run %s: dropping %d finding(s) matching adjudicator-suppressed "
            "candidates (entity_ids: %s)",
            run_id, len(resurrected),
            [str(f.get("entity_id")) for f in resurrected],
        )
        findings = [f for f in findings if f not in resurrected]

    # Audit honesty (final-review F5): a survivor Opus neither re-emitted
    # nor vetoed vanishes silently otherwise. Log the set difference.
    emitted_ids = {str(f.get("entity_id")) for f in result.get("findings", [])}
    omitted = [
        str(s.get("entity_id")) for s in adj["survivors"]
        if str(s.get("entity_id")) not in emitted_ids
        and str(s.get("entity_id")) not in vetoed_ids
    ]
    if omitted:
        logger.warning(
            "dq run %s: %d adjudicated survivor(s) neither re-emitted nor "
            "vetoed by the synthesis pass (entity_ids: %s)",
            run_id, len(omitted), omitted,
        )

    counts = agent.persist_findings(user_id=user_id, run_id=run_id, findings=findings)
    dq_runs_repo.complete_run(
        run_id,
        counts["observations_written"],
        counts["recommendations_written"],
        result.get("total_cost_usd", 0.0),
        gate_metrics={
            "adjudication": adj["stats"],
            "generation": gen,
            "vetoed": len(vetoed_ids),
            "suppressed_resurrections_dropped": len(resurrected),
            "survivors_omitted_by_synthesis": len(omitted),
        },
    )


def _execute_legacy(
    user_id: int,
    run_id: int,
    trigger: str,
    investigations: list[str],
    on_event: Optional[Callable[[dict], None]],
    on_subprocess_start: Optional[Callable[["subprocess.Popen"], None]],
) -> None:
    """DQ_RUN_MODE=legacy: today's monolithic path, unchanged -- the
    deterministic pass runs INSIDE agent.investigate() itself, with no
    adjudicator, no gate, and no verdict history."""
    agent = DQAgent(user_id=user_id)
    result = agent.investigate(
        trigger=trigger,
        investigations=investigations,
        on_event=on_event,
        on_subprocess_start=on_subprocess_start,
    )
    if dq_runs_repo.is_abort_requested(run_id):
        logger.info("dq run %s: aborted by user; skipping persist", run_id)
        dq_runs_repo.fail_run(run_id, "aborted by user")
        return
    if result.get("error") is not None:
        logger.warning("dq run %s: agent error: %s", run_id, str(result["error"])[:500])
        dq_runs_repo.fail_run(run_id, result["error"])
        return
    counts = agent.persist_findings(
        user_id=user_id, run_id=run_id, findings=result.get("findings", [])
    )
    dq_runs_repo.complete_run(
        run_id=run_id,
        observations_written=counts["observations_written"],
        recommendations_written=counts["recommendations_written"],
        llm_cost_usd=result.get("total_cost_usd", 0.0),
    )


def execute_run(
    user_id: int,
    run_id: int,
    trigger: str,
    run_kind: str,
    investigations: list[str],
    on_event: Optional[Callable[[dict], None]] = None,
    on_subprocess_start: Optional[Callable[["subprocess.Popen"], None]] = None,
) -> None:
    """Drive one already-claimed dq_runs row to terminal state.

    Caller has set status='running' (via claim) and passes the run_id. We set
    the RLS user context (the executor runs off the request path, so contextvars
    don't auto-propagate), dispatch by run mode + run_kind, then persist +
    complete or fail.

    Dispatch: DQ_RUN_MODE=legacy bypasses the Tier-2 split and runs
    `_execute_legacy` (ignores `run_kind`). Otherwise (default "tier2"),
    `run_kind == "sensor"` runs `_execute_sensor_run`; anything else runs
    `_execute_full_run`.

    Abort wiring: polls dq_runs_repo.is_abort_requested on a throttle during
    streaming; terminates the claude subprocess when the flag is set, then calls
    fail_run('aborted by user') and returns without persisting findings."""
    proc_holder: dict = {"proc": None}
    last_check = {"t": 0.0}

    def _capture_proc(proc) -> None:
        proc_holder["proc"] = proc
        if on_subprocess_start is not None:
            on_subprocess_start(proc)

    def _on_event(event: dict) -> None:
        now = time.monotonic()
        if now - last_check["t"] >= _ABORT_CHECK_INTERVAL_SEC:
            last_check["t"] = now
            if dq_runs_repo.is_abort_requested(run_id) and proc_holder["proc"] is not None:
                logger.info("dq run %s: abort requested; terminating subprocess", run_id)
                try:
                    proc_holder["proc"].terminate()
                except Exception:
                    logger.exception("dq run %s: terminate failed", run_id)
        if on_event is not None:
            on_event(event)

    try:
        set_current_user_id(user_id)
        try:
            _on_event({
                "type": "_phase",
                "subtype": "run_claimed",
                "trigger": trigger,
                "investigations": investigations,
            })
        except Exception:
            logger.exception("dq run %s: on_event callback raised on run_claimed phase event; continuing", run_id)

        if _run_mode() == "legacy":
            _execute_legacy(user_id, run_id, trigger, investigations, _on_event, _capture_proc)
        elif run_kind == "sensor":
            _execute_sensor_run(user_id, run_id, _on_event)
        else:
            _execute_full_run(user_id, run_id, trigger, _on_event, _capture_proc)
    except Exception as exc:
        logger.exception("dq run %s crashed", run_id)
        dq_runs_repo.fail_run(run_id, f"run crashed: {exc}")
