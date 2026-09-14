"""Enqueue helpers for the standalone DQ worker.

This module provides `enqueue_weekly_dq` and `enqueue_recluster_dq`, which
insert `dq_runs` rows for the DQ worker to consume. Gating logic (env
kill-switch, per-user preference, active-run skip) lives here; the worker
owns execution.
"""

from __future__ import annotations

import logging
import os

from backend.db import dq_runs_repo, user_repo

logger = logging.getLogger(__name__)

# Name of the preferences flag that gates scheduled runs. Kept as a module
# constant so the Task 6.2 toggle UI and any future opt-out tooling use the
# same string. (Exposed publicly so tests can monkey-patch or reference it.)
SCHEDULED_RUNS_PREF_KEY = "enable_scheduled_runs"

# Job id used in the scheduler registry. Exposed so tests can look it up
# without hardcoding the string.
WEEKLY_JOB_ID = "dq_weekly_investigation"

# dqBot Tier 2 rollout kill switch
# (the 2026-07-19 dqbot-tier2-role-split plan, private): "legacy"
# restores today's enqueue + monolithic execute semantics exactly, both here
# (the recluster hook enqueues a full run, matching pre-Tier-2 behavior) and
# in dq_run_executor.execute_run (bypasses the sensor/full split entirely).
# Default "tier2" is the sensor/full role split. Read at call time (not
# cached at import), same pattern as DQ_SCHEDULER_DISABLED above, so
# tests/callers can flip it without a module reload.
DQ_RUN_MODE = "DQ_RUN_MODE"


def _is_disabled() -> bool:
    """DQ_SCHEDULER_DISABLED=1 is the operator kill switch for scheduled enqueues."""
    return os.getenv("DQ_SCHEDULER_DISABLED", "0") == "1"


def _run_mode() -> str:
    return os.getenv(DQ_RUN_MODE, "tier2")


def enqueue_weekly_dq() -> None:
    """Weekly tick (runs in the worker): enqueue one run per opted-in user.

    Skips users who already have a queued/running run so a manual run in flight
    isn't doubled. Enqueue only -- the worker's poll loop does the actual work.
    """
    if _is_disabled():
        logger.info("dq scheduler: weekly tick skipped (DQ_SCHEDULER_DISABLED=1)")
        return
    users = user_repo.list_users_with_pref(SCHEDULED_RUNS_PREF_KEY, True)
    if not users:
        logger.info("dq scheduler: weekly tick found 0 opted-in users")
        return
    for user in users:
        uid = user["id"]
        if dq_runs_repo.has_active_run_for_user(uid):
            logger.info("dq scheduler: weekly skip user %s (run already active)", uid)
            continue
        dq_runs_repo.enqueue(user_id=uid, trigger="schedule")
        logger.info("dq scheduler: weekly enqueued run for user %s", uid)


def enqueue_recluster_dq(user_id: int) -> None:
    """Recluster-event hook (runs in the app): enqueue a DQ run if the user
    is opted in and has no active run. Gated identically to the old
    in-process hook, but the worker consumes the row. Never raises.

    dqBot Tier 2 (default): enqueues a zero-LLM sensor pass (run_kind
    "sensor") -- the sensor's own dq_gate decides whether a full (Opus) run
    is warranted. DQ_RUN_MODE=legacy: unchanged pre-Tier-2 behavior, a full
    run enqueued directly.
    """
    if _is_disabled():
        return
    user = user_repo.get_user_by_id(user_id)
    if user is None:
        logger.warning("dq recluster-enqueue: user %s not found", user_id)
        return
    if not user["preferences"].get(SCHEDULED_RUNS_PREF_KEY, False):
        logger.info("dq scheduler: recluster enqueue skipped for user %s (pref off)", user_id)
        return
    if dq_runs_repo.has_active_run_for_user(user_id):
        logger.info("dq scheduler: recluster enqueue skipped for user %s (run active)", user_id)
        return
    if _run_mode() == "legacy":
        dq_runs_repo.enqueue(user_id=user_id, trigger="recluster_event")
    else:
        dq_runs_repo.enqueue(user_id=user_id, trigger="recluster_event", run_kind="sensor")
    logger.info("dq scheduler: recluster enqueued run for user %s", user_id)
