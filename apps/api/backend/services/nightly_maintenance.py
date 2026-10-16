"""Nightly maintenance job — the registered payload of the M14 scheduler.

The scheduler (:mod:`backend.services.scheduler`) is a generic loop. This
module is the project-specific payload that it runs. It is a full
maintenance orchestrator that ALWAYS: reaps stale ``running`` recluster/DQ
runs, sweeps stranded ``pending`` captures, runs catch-up backfills, and
writes a status snapshot. Reclustering — through the **Batch API** (50%
discount, ≤24h SLA), the deferred-path move the Milestone 14 report
designs — is the one conditional step: it runs only when new pages exist
since the last successful recluster.

Registration is lazy — :func:`register_jobs` is called from
:func:`scheduler.start_nightly_scheduler` so callers don't have to wire
anything beyond ``ENABLE_NIGHTLY_MAINT=1``. If you're running a test or
headless script that starts the scheduler without the FastAPI lifespan,
call :func:`register_jobs` yourself first.

Cost-flatness on quiet days comes from gating only the recluster step on
new pages (recorded as ``recluster_skipped`` in the notes); the cheap
maintenance steps still run so nothing strands until the next night.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from backend.config.settings import settings
from backend.db import page_repo
from backend.db.connection import get_conn
from backend.services import scheduler

logger = logging.getLogger(__name__)


def _default_user_id() -> int:
    """Resolve the default user without a hard import cycle against main.py."""
    from backend.api.main import get_default_user_id

    return get_default_user_id()


def _pages_added_since(user_id: int, cutoff) -> int:
    """Count pages created strictly after ``cutoff`` for ``user_id``.

    Kept as a small raw query so we don't force a schema change on
    :mod:`backend.db.page_repo` for what is effectively a health check.
    ``cutoff`` is a ``datetime`` or None.
    """
    if cutoff is None:
        # No prior run — any active pages qualify. Use a cheap count.
        return len(page_repo.get_active_pages(user_id))

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM pages WHERE user_id = %s AND created_at > %s",
            (user_id, cutoff),
        )
        row = cur.fetchone()
        return int(row[0]) if row else 0


def _last_successful_recluster_at(user_id: int):
    """Return ``completed_at`` of the most recent ``completed`` recluster run, or None."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
                SELECT completed_at
                  FROM recluster_runs
                 WHERE user_id = %s AND status = 'completed'
              ORDER BY completed_at DESC
                 LIMIT 1
                """,
            (user_id,),
        )
        row = cur.fetchone()
        return row[0] if row else None


async def _maybe_weekly_shelf_maintenance(user_id: int) -> dict:
    """Run shelf merge/split once a week, only when ``label_first_enabled`` is on.

    Fail-open: a shelf-maintenance error is logged and reported in the notes; it
    must never fail the nightly run. Returns ``{}`` when nothing ran.
    """
    if not getattr(settings, "label_first_enabled", False):
        return {}
    weekday = int(getattr(settings, "shelf_maintenance_weekday", 6))
    if datetime.now().weekday() != weekday:
        return {}
    try:
        from backend.services import shelf_service

        # sync + blocking LLM/embedding calls: keep them off the event loop
        return await asyncio.to_thread(shelf_service.weekly_maintenance, user_id)
    except Exception as exc:
        logger.exception("weekly shelf maintenance failed")
        return {"error": str(exc)[:200]}


async def run_nightly_maintenance() -> dict:
    """Nightly maintenance orchestrator. Always: reap stale runs, sweep
    stranded pending captures, run catch-up backfills, write a status
    snapshot. Reclusters only when new pages exist since the last run.
    Returns notes for scheduled_runs (cost_usd + counts + skip reasons).
    Any exception propagates so the scheduler records a failed run.
    """
    from backend.db import dq_runs_repo, page_repo, recluster_repo, trends_repo

    user_id = _default_user_id()
    notes: dict = {}

    # 1. Reap crashed 'running' runs so guards/has_running checks don't deadlock.
    notes["reaped_recluster"] = recluster_repo.reap_stale_runs()
    notes["reaped_dq"] = dq_runs_repo.reap_stale_runs()

    # 2. Pending-capture safety sweep (drains stranded pages -> new active pages).
    from backend.api.main import sweep_pending_once  # lazy: break import cycle
    sweep = await sweep_pending_once(user_id)
    notes["pending_swept"] = sweep["processed"]
    notes["pending_failed"] = sweep["failed"]

    cost = 0.0

    # 3. Recluster only if new pages (after the sweep may have produced some).
    last_at = _last_successful_recluster_at(user_id)
    new_pages = _pages_added_since(user_id, last_at)
    if last_at is None or new_pages > 0:
        from backend.services.clustering_service import ClusteringService
        result = await ClusteringService(user_id=user_id).recluster_all(batch_mode=True)
        cost += float(result.get("naming_cost") or 0.0)
        notes["cluster_count"] = int(result.get("cluster_count") or 0)
        notes["noise_count"] = int(result.get("noise_count") or 0)
        notes["new_pages_since_last_run"] = new_pages
        if result.get("skipped"):
            notes["recluster_skipped"] = result["skipped"]
    else:
        notes["recluster_skipped"] = f"no new pages since {last_at.isoformat()}"

    # 4. Catch-up backfills (chunk unindexed active pages; classify NULL is_learning).
    from backend.services.catchup import run_catchup_backfills
    catchup = await run_catchup_backfills(user_id)
    notes["chunked_pages"] = catchup["chunked_pages"]
    notes["classified_done"] = catchup["classified_done"]
    cost += float(catchup.get("cost_usd") or 0.0)

    # 4b. Label-first shelves: weekly merge/split (flag-gated; default off = no-op).
    notes_shelf = await _maybe_weekly_shelf_maintenance(user_id)
    if notes_shelf:
        notes["shelf_maintenance"] = notes_shelf
        cost += float(notes_shelf.get("cost_usd") or 0.0)

    # 5. Status snapshot (always — records current state for the Trends view).
    counts = page_repo.get_page_status_counts(user_id)
    trends_repo.insert_status_snapshot(
        user_id=user_id,
        active_count=counts.get("active", 0),
        pending_count=counts.get("pending", 0),
        archived_count=counts.get("archived", 0),
        cluster_count=notes.get("cluster_count", 0),
        noise_count=notes.get("noise_count", 0),
        total_cost_usd=trends_repo.get_total_cost_usd(user_id),
    )

    notes["cost_usd"] = cost
    return notes


def register_jobs() -> None:
    """Register the nightly-maintenance job with the scheduler (idempotent).

    Safe to call multiple times — re-registration is a cheap append; the
    scheduler loop runs each entry in order. Callers who want to enforce
    single-registration can check :data:`scheduler._registry` or restart
    the process.
    """
    scheduler.register_job("nightly_maintenance", run_nightly_maintenance)
