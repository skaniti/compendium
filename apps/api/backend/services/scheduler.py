"""Nightly scheduler for deferred-maintenance jobs (Milestone 14).

Why this exists
---------------
Milestone 14's architectural bet is a **two-path pipeline**. The realtime
path (skip gate, capture handler, RAG agent) stays synchronous because the
user is waiting on it. The deferred path (cluster naming, supercluster
maintenance, learning-gate batch, RAG re-index) runs once a day, because
no user is waiting and the OpenAI Batch API gives a 50% discount on
calls that can tolerate a 24h SLA.

This module is the deferred path's runner. It follows the same minimal
pattern already used by ``_prune_app_logs_loop`` in ``backend/api/main.py``
— a single asyncio task that sleeps, wakes, runs registered jobs, sleeps
again. No external dependency (APScheduler / Celery / cron) was
introduced for this.

Registration is done by calling :func:`register_job` from any module that
wants to opt in. Jobs run **sequentially** in the order they were
registered, so a long job can't be starved by a later one and a failure
in job N doesn't prevent job N+1 from running.

Environment controls
--------------------
- ``ENABLE_NIGHTLY_MAINT=1`` — turn the scheduler on. Off by default so
  dev servers don't fire jobs unexpectedly during local testing.
- ``SCHEDULER_OVERRIDE_SECONDS=<int>`` — when set, the scheduler sleeps
  this many seconds between cycles instead of waking at ``wake_hour``
  local time. Intended for smoke tests (e.g. ``=60`` to fire a minute
  after startup); never set in production.

Each cycle writes one row per job to ``scheduled_runs`` so the job
history is queryable from the same Trends surface that already tracks
``recluster_runs``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta

from backend.db import scheduled_runs_repo

logger = logging.getLogger(__name__)


# A job is a zero-arg async factory that produces the awaitable to run.
# Using a factory (rather than a pre-built coroutine) lets the scheduler
# re-invoke the job each cycle; a bare coroutine can only be awaited once.
JobFactory = Callable[[], Awaitable[dict | None]]

_registry: list[tuple[str, JobFactory]] = []


def register_job(name: str, factory: JobFactory) -> None:
    """Register ``factory`` to run as job ``name`` each cycle.

    The factory returns an awaitable that, on completion, yields either
    ``None`` (treated as a successful no-op) or a ``dict`` of notes —
    typically ``{"cost_usd": float, ...}`` — persisted to the
    ``scheduled_runs.notes`` column. Any exception is caught and logged;
    the next job in the registry still runs.
    """
    _registry.append((name, factory))
    logger.info("scheduler: registered job %r", name)


def _seconds_until_local(hour: int, minute: int, now: datetime | None = None) -> float:
    """Seconds from ``now`` until the next local ``HH:MM``. Always positive."""
    now = now or datetime.now()
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def _run_one(name: str, factory: JobFactory) -> None:
    """Run a single registered job, recording start / finish in ``scheduled_runs``."""
    run_id = scheduled_runs_repo.start_run(name)
    t0 = time.perf_counter()
    try:
        result = await factory()
        elapsed = time.perf_counter() - t0
        notes = dict(result) if isinstance(result, dict) else {}
        cost = float(notes.pop("cost_usd", 0.0) or 0.0)
        scheduled_runs_repo.complete_run(
            run_id,
            cost_usd=cost,
            elapsed_seconds=elapsed,
            notes=notes,
        )
        logger.info(
            "scheduler: job %r completed in %.1fs (cost=$%.4f, notes=%s)",
            name,
            elapsed,
            cost,
            notes or {},
        )
    except Exception as exc:  # never let one job kill the loop
        elapsed = time.perf_counter() - t0
        logger.exception("scheduler: job %r failed after %.1fs", name, elapsed)
        try:
            scheduled_runs_repo.fail_run(run_id, error=str(exc), elapsed_seconds=elapsed)
        except Exception:
            logger.exception("scheduler: could not persist fail_run for %r", name)


async def _nightly_loop(wake_hour: int, wake_minute: int = 0) -> None:
    """Long-running loop. Do not call directly — use :func:`start_nightly_scheduler`."""
    await asyncio.sleep(30)  # let startup settle (match _prune_app_logs_loop ergonomics)

    override = os.getenv("SCHEDULER_OVERRIDE_SECONDS")
    override_seconds: float | None = None
    if override:
        try:
            override_seconds = max(5.0, float(override))
            logger.info(
                "scheduler: SCHEDULER_OVERRIDE_SECONDS=%s active — smoke-test cadence",
                override_seconds,
            )
        except ValueError:
            logger.warning("scheduler: invalid SCHEDULER_OVERRIDE_SECONDS=%r — ignoring", override)

    while True:
        if override_seconds is not None:
            delay = override_seconds
        else:
            delay = _seconds_until_local(wake_hour, wake_minute)
        logger.info(
            "scheduler: next wake in %.0fs (at %s)",
            delay,
            (datetime.now() + timedelta(seconds=delay)).strftime("%Y-%m-%d %H:%M"),
        )
        await asyncio.sleep(delay)

        if not _registry:
            logger.info("scheduler: woke, no jobs registered — sleeping")
            continue

        logger.info("scheduler: running %d job(s)", len(_registry))
        for name, factory in list(_registry):
            await _run_one(name, factory)


def _auto_discover_jobs() -> None:
    """Import modules that register scheduler jobs as a side-effect.

    Keeps the coupling direction clean: the scheduler module doesn't depend
    on any specific payload at import time, but calling
    :func:`start_nightly_scheduler` lazily triggers the known registrations.
    Failures here are logged and swallowed — a broken payload module must
    not prevent the scheduler from starting for the *other* payload modules.
    """
    try:
        from backend.services import nightly_maintenance

        nightly_maintenance.register_jobs()
    except Exception:
        logger.exception("scheduler: nightly_maintenance registration failed")


def start_nightly_scheduler(wake_hour: int = 3, wake_minute: int = 0) -> asyncio.Task | None:
    """Launch the nightly scheduler. No-op if ``ENABLE_NIGHTLY_MAINT`` is unset.

    Returns the background task so callers can hold a reference (prevents
    asyncio garbage-collecting it mid-flight), or None when disabled.
    """
    if os.getenv("ENABLE_NIGHTLY_MAINT", "0") != "1":
        logger.info("scheduler: ENABLE_NIGHTLY_MAINT not set — scheduler is off")
        return None

    _auto_discover_jobs()

    logger.info(
        "scheduler: starting (wake %02d:%02d local, %d job(s) registered)",
        wake_hour,
        wake_minute,
        len(_registry),
    )
    return asyncio.create_task(_nightly_loop(wake_hour, wake_minute))
