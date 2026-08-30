"""Standalone DQ worker process.

Runs as its own container (same image, different command:
`python -m backend.services.dq_worker`). Two responsibilities:

  1. A thread-based BackgroundScheduler fires the weekly tick (Sun 03:00 UTC),
     which ENQUEUES rows (dq_scheduler.enqueue_weekly_dq).
  2. A synchronous poll loop claims queued rows and executes them.

Why synchronous + BackgroundScheduler (not AsyncIOScheduler): a full run's
adjudication step (dq_adjudicator, and the sensor pass's dq_gate confirm
step, which itself calls dq_adjudicator) calls asyncio.run() internally.
That throws under a running event loop, so the run MUST execute on a thread
with no loop. A plain blocking loop guarantees that; the scheduler thread
only does INSERTs, never investigations."""

import logging
import os
import signal
import threading

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from backend.db import dq_run_events_repo, dq_runs_repo
from backend.services import dq_run_executor, dq_scheduler
from backend.services.dq_investigations import (
    DEFAULT_INVESTIGATIONS,
    STRUCTURAL_INVESTIGATIONS,
)
from backend.services.dq_sql_receipt import verify_readonly_grants

logger = logging.getLogger(__name__)

POLL_INTERVAL_SEC = int(os.getenv("DQ_WORKER_POLL_SEC", "8"))
REAP_EVERY_TICKS = int(os.getenv("DQ_WORKER_REAP_EVERY_TICKS", "30"))

_shutdown = threading.Event()


def _investigations_for(trigger: str) -> list[str]:
    """Recluster-event runs the structural subset; everything else runs the
    full set. Legacy-only (DQ_RUN_MODE=legacy): dq_run_executor's Tier-2
    paths pick their own investigation set internally
    (STRUCTURAL_INVESTIGATIONS / DEFAULT_INVESTIGATIONS) keyed off the
    claimed row's run_kind, not trigger -- this function only feeds the
    monolithic legacy call path's `investigations=` argument."""
    return STRUCTURAL_INVESTIGATIONS if trigger == "recluster_event" else DEFAULT_INVESTIGATIONS


_FORENSIC_EVENT_TYPES = frozenset({"result", "_retry"})


def _make_event_persister(run: dict, event_types: frozenset[str] | None = None):
    """Build an on_event callback that appends claude stream events to
    dq_run_events.

    ``event_types=None`` (manual runs) persists the full stream so the live
    pane can poll every event (mirrors the old in-process router path).
    Passing a filter set (e.g. _FORENSIC_EVENT_TYPES) restricts persistence
    to just those event types -- scheduled/recluster runs have no live
    watcher, so writing every intermediate event would be pure DB load with
    no reader; only the terminal 'result' (and '_retry' diagnostics) are
    worth the write, so a failed unattended run still leaves a forensic
    trail instead of zero rows."""
    seq = [0]

    def _persist(event: dict) -> None:
        event_type = event.get("type", "unknown")
        if event_types is not None and event_type not in event_types:
            return
        dq_run_events_repo.append_event(
            user_id=run["user_id"],
            run_id=run["id"],
            seq=seq[0],
            event_type=event_type,
            payload=event,
        )
        seq[0] += 1

    return _persist


def poll_once() -> bool:
    """Claim and execute one queued run. Returns True if a run executed.

    Manual runs get an event-persisting callback so the live event-log pane
    streams the full event sequence. Scheduled/recluster runs get a filtered
    persister (only 'result'/'_retry' event types) instead of on_event=None --
    a failed unattended run now leaves a forensic trail without the per-event
    DB write load of the full stream.

    dqBot Tier 2: the claimed row's run_kind (sensor vs full) is passed
    straight through to the executor, which does the actual sensor/full
    dispatch (and the DQ_RUN_MODE=legacy bypass) -- this function's own job
    is unchanged: pick the event persister by trigger, pick the legacy
    investigation set by trigger, and hand both off."""
    run = dq_runs_repo.claim_next_queued_run()
    if run is None:
        return False
    logger.info("dq worker: claimed run %s (user %s, trigger %s, run_kind %s)",
                run["id"], run["user_id"], run["trigger"], run["run_kind"])
    is_manual = run["trigger"] == "manual"
    dq_run_executor.execute_run(
        user_id=run["user_id"],
        run_id=run["id"],
        trigger=run["trigger"],
        run_kind=run["run_kind"],
        investigations=_investigations_for(run["trigger"]),
        on_event=_make_event_persister(
            run, event_types=None if is_manual else _FORENSIC_EVENT_TYPES
        ),
    )
    return True


def _build_scheduler() -> BackgroundScheduler:
    sched = BackgroundScheduler(timezone="UTC")
    sched.add_job(
        dq_scheduler.enqueue_weekly_dq,
        CronTrigger(day_of_week="sun", hour=3, minute=0),
        id=dq_scheduler.WEEKLY_JOB_ID,
        replace_existing=True,
    )
    return sched


def _run_startup_canary() -> None:
    """Log an ERROR (not a crash) when the dq_bot_readonly grants are broken.

    Every SQL receipt goes through this same readonly path -- if the canary
    fails, every receipt this worker executes will fail identically. Loud
    startup logging surfaces that immediately instead of silently accumulating
    213 failed receipts before anyone notices (2026-07-17 audit)."""
    try:
        error = verify_readonly_grants()
    except Exception:
        logger.exception("dq worker: readonly-grants canary crashed unexpectedly")
        return
    if error is not None:
        logger.error(
            "dq worker: readonly-grants canary FAILED: %s -- "
            "dq_bot_readonly grants missing — re-run backend.db.migrate "
            "(migration 040) / check role grants; SQL receipts will all "
            "fail until fixed",
            error,
        )
    else:
        logger.info("dq worker: readonly-grants canary OK")


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    signal.signal(signal.SIGTERM, lambda *_: _shutdown.set())
    signal.signal(signal.SIGINT, lambda *_: _shutdown.set())

    _run_startup_canary()

    sched = _build_scheduler()
    sched.start()
    logger.info("dq worker: started (poll=%ss, weekly cron sun 03:00 UTC)", POLL_INTERVAL_SEC)

    ticks = 0
    try:
        while not _shutdown.is_set():
            ticks += 1
            if ticks % REAP_EVERY_TICKS == 0:
                reaped = dq_runs_repo.reap_stale_runs()
                if reaped:
                    logger.info("dq worker: reaped %s stale run(s)", reaped)
            # Drain the queue, then sleep. poll_once handles one run per call.
            if not poll_once():
                _shutdown.wait(POLL_INTERVAL_SEC)
    finally:
        sched.shutdown(wait=False)
        logger.info("dq worker: stopped")


if __name__ == "__main__":
    main()
