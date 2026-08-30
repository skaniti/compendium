"""One-time / resumable backfill: populate embedding_gists (ctv3 contract).

The ctv3 embedding-text recipe (``ClusteringService._build_embedding_text_v3``)
prefers a per-page LLM gist over the ctv2 300-char head sample, but
``_compute_embeddings_openai`` only generates gists lazily -- for whichever
pages happen to need re-embedding on a given recluster. This script front-
loads that work for a user's full clusterable corpus so a cluster_eval
``--text-contract ctv3`` run (or a prod cutover) doesn't pay per-page LLM
latency inline.

Reuses ``ClusteringService._load_all_pages`` + ``_filter_clusterable_pages``
for corpus loading (same pages a recluster would see) and
``_generate_embedding_gists`` for generation (same batched gpt-4o-mini call,
same fail-open behavior) -- no reimplementation of either.

Idempotent: only processes pages whose page_content_id has no cached row
under GIST_PROMPT_KEY (``embedding_repo.get_embedding_gists``), so an
interrupted run resumes cleanly. Each slice's gists are persisted
immediately after that slice's LLM call returns (crash-safe) via
``embedding_repo.upsert_embedding_gists``.

Usage:
    python -m backend.scripts.backfill_embedding_gists --user-id 152 --dry-run
    python -m backend.scripts.backfill_embedding_gists --user-id 152 --concurrency 8
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

# repo root = two levels up (this file lives at backend/scripts/)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db import embedding_repo, trends_repo
from backend.services.clustering_service import (
    GIST_BATCH_SIZE,
    GIST_PROMPT_KEY,
    NAMING_MODEL,
    ClusteringService,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

DEFAULT_CONCURRENCY = 8
# One slice == one internal LLM batch call inside _generate_embedding_gists
# (which itself chunks its input into GIST_BATCH_SIZE-sized calls), so
# --concurrency directly bounds the number of concurrent LLM calls in flight.
SLICE_SIZE = GIST_BATCH_SIZE


def _chunk(items: list, size: int) -> list[list]:
    """Split ``items`` into consecutive slices of at most ``size`` each."""
    return [items[i : i + size] for i in range(0, len(items), size)]


def _load_missing_pages(
    service: ClusteringService, user_id: int
) -> tuple[list[dict], int, int]:
    """Load clusterable pages and diff against cached gists.

    Returns (missing_pages, total_loaded, total_clusterable). A page counts
    as "missing" only when it has a page_content_id (gists are keyed on it)
    and that id has no row in embedding_gists under GIST_PROMPT_KEY.
    """
    all_pages = service._load_all_pages(user_id)
    pages, _filter_stats = service._filter_clusterable_pages(all_pages)

    pcids = sorted(
        {p["page_content_id"] for p in pages if p.get("page_content_id") is not None}
    )
    cached = embedding_repo.get_embedding_gists(pcids, GIST_PROMPT_KEY)

    missing = [
        p
        for p in pages
        if p.get("page_content_id") is not None and p["page_content_id"] not in cached
    ]
    return missing, len(all_pages), len(pages)


async def main_async(user_id: int | None, concurrency: int, dry_run: bool) -> None:
    service = ClusteringService(user_id=user_id)
    resolved_user_id = service._get_user_id()

    log.info(
        f"{'DRY RUN' if dry_run else 'BACKFILL'} — embedding gist backfill "
        f"(user={resolved_user_id}, prompt_key={GIST_PROMPT_KEY}, "
        f"concurrency={concurrency})"
    )

    missing, total_loaded, total_clusterable = _load_missing_pages(
        service, resolved_user_id
    )
    total_missing = len(missing)
    log.info(
        f"Pages: {total_loaded} loaded -> {total_clusterable} clusterable "
        f"-> {total_missing} missing a gist"
    )

    if total_missing == 0:
        log.info("Nothing to backfill.")
        return

    slices = _chunk(missing, SLICE_SIZE)

    if dry_run:
        log.info(
            f"Would process {total_missing} pages in {len(slices)} slices "
            f"(concurrency {concurrency}) — dry run, no spend."
        )
        return

    sem = asyncio.Semaphore(concurrency)
    processed = 0
    total_cost = 0.0
    total_gisted = 0
    total_failed = 0

    async def _run_slice(slice_pages: list[dict]) -> None:
        nonlocal processed, total_cost, total_gisted, total_failed
        async with sem:
            try:
                gists, cost = await service._generate_embedding_gists(slice_pages)
            except Exception as e:
                log.warning(f"  slice failed (fail-open): {e}")
                gists, cost = {}, 0.0

            if gists:
                embedding_repo.upsert_embedding_gists(
                    sorted(gists.items()), GIST_PROMPT_KEY
                )

            processed += len(slice_pages)
            total_cost += cost
            total_gisted += len(gists)
            failed_in_slice = len(slice_pages) - len(gists)
            total_failed += failed_in_slice
            status = "ok" if failed_in_slice == 0 else f"partial ({failed_in_slice} missing)"
            log.info(
                f"[{processed}/{total_missing}] batch {status}, "
                f"${cost:.4f} (${total_cost:.4f} cumulative)"
            )

    await asyncio.gather(*[_run_slice(s) for s in slices])

    log.info(
        f"\nDone: {total_gisted}/{total_missing} pages gisted "
        f"({total_failed} failed), ${total_cost:.4f} total cost"
    )

    try:
        trends_repo.insert_cost_event(
            user_id=resolved_user_id,
            event_type="embedding_gist",
            model=NAMING_MODEL,
            cost_usd=total_cost,
            metadata={"backfill": True, "pages": total_missing},
        )
    except Exception:
        log.debug("embedding gist cost event insert failed", exc_info=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Backfill embedding_gists (ctv3 text-contract prerequisite)"
    )
    parser.add_argument(
        "--user-id",
        type=int,
        default=None,
        help="target user id (default: get_default_user_id())",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help="max concurrent LLM slice calls (default: 8)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the would-process count and exit; no LLM spend",
    )
    return parser


if __name__ == "__main__":
    args = _build_parser().parse_args()
    asyncio.run(main_async(args.user_id, args.concurrency, args.dry_run))
