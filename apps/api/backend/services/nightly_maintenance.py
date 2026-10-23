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

The page/content join check (:mod:`backend.services.content_join_check`) also
always runs, read-only, right after the pending sweep; its result is recorded
under ``content_join_mismatches`` in the notes and a nonzero count is logged as
a WARNING. It flags only: repair is a manual run of the repair script.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from backend.config.settings import settings
from backend.db import page_repo
from backend.db.connection import get_conn
from backend.services import content_join_check, scheduler

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


async def _content_join_check_notes() -> dict:
    """Run the page/content join check; never raises.

    Returns the notes payload (``{"count", "by_user"}``), or ``{"error": <message>}``
    when the check itself failed, so a broken check cannot fail the nightly run or
    skip the steps after it. A nonzero count logs one WARNING with the count and the
    capped page ids per user.
    """
    try:
        # sync, blocking SQL over pages x page_content: keep it off the event loop
        result = await asyncio.to_thread(content_join_check.check_content_joins)
    except Exception as exc:
        logger.exception("content join check failed")
        return {"error": str(exc)[:300]}
    if result["count"]:
        per_user = "; ".join(
            f"user {uid}: {u['count']} page(s), ids {u['page_ids']}"
            for uid, u in result["by_user"].items()
        )
        logger.warning(
            "content join check: %d page(s) point at a content row for a different url (%s). "
            "Repair: python -m backend.scripts.repair_page_content_joins",
            result["count"],
            per_user,
        )
    return result


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


LABEL_HOOK_DRAIN_TIMEOUT_S = 900.0
"""Longest the nightly catch-up waits for ingest labelling hooks queued by the sweep."""


async def _maybe_label_catchup(user_id: int) -> dict:
    """Label up to ``label_catchup_limit`` active pages that have no label yet.

    Ingest-time labelling is fail-open, so a failed call leaves a page
    unlabelled for good; this retries a small batch each night. Only with
    ``label_first_enabled`` (default off = no-op, nothing imported); 0 turns it
    off. Retries lowest content ids first, so content that can never be labelled
    holds the head of the queue (no failure counter yet). Spend is recorded as
    ``page_labelling`` cost events by the labeller itself, and also summed into the
    returned notes. Fail-open: an error is
    returned in the notes, never raised.
    """
    if not getattr(settings, "label_first_enabled", False):
        return {}
    limit = int(getattr(settings, "label_catchup_limit", 0) or 0)
    if limit <= 0:
        return {}
    try:
        from backend.db import page_label_repo
        from backend.process_captures import drain_label_hooks
        from backend.services import page_labeller

        # The sweep above queues ingest hooks that label these same pages; wait
        # for them (bounded) so the catch-up does not pay for them twice.
        try:
            await asyncio.wait_for(drain_label_hooks(), timeout=LABEL_HOOK_DRAIN_TIMEOUT_S)
        except TimeoutError:
            logger.warning("label catch-up: ingest hooks still running; continuing anyway")

        ids = page_label_repo.get_unlabelled_content_ids(
            page_labeller.labeller_version(), user_id=user_id, limit=limit
        )
        if not ids:
            return {}
        out = {"requested": len(ids), "labelled": 0, "failed_requests": 0, "cost_usd": 0.0}
        step = max(1, int(settings.label_batch_size)) * 10
        for i in range(0, len(ids), step):
            run = await page_labeller.label_content_ids(ids[i : i + step], user_id=user_id)
            out["labelled"] += len(run.labels)
            out["failed_requests"] += run.failed_requests
            out["cost_usd"] += run.cost_usd
            if run.error:
                out["error"] = run.error
                break
        return out
    except Exception as exc:
        logger.exception("label catch-up failed")
        return {"error": f"{type(exc).__name__}: {exc}"[:300]}


async def run_nightly_maintenance() -> dict:
    """Nightly maintenance orchestrator. Always: reap stale runs, sweep
    stranded pending captures, check page/content joins (flag only), run
    catch-up backfills, write a status snapshot. Reclusters only when new
    pages exist since the last run.
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

    # 2a. Page/content join check (read-only; flags only): after the sweep so pages it
    # just re-processed are included. Failure-proof: an error lands in the notes.
    notes[content_join_check.NOTES_KEY] = await _content_join_check_notes()

    cost = 0.0

    # 2b. Label-first: label a few pages whose ingest-time labelling failed
    # (flag-gated; default off = no-op), so the recluster below sees them.
    notes_label = await _maybe_label_catchup(user_id)
    if notes_label:
        notes["label_catchup"] = notes_label
        cost += float(notes_label.get("cost_usd") or 0.0)

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
