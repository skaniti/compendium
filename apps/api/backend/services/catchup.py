"""Nightly catch-up backfills: chunk unindexed active pages and classify
pages with NULL is_learning. Both are safety nets -- the live pipeline does
this inline; this re-does anything that slipped through. Cost is ~$0 (local
SBERT for chunks; small gpt-4o-mini for is_learning).
"""
import logging

from backend.scripts.backfill_chunks import fetch_targets, write_page
from backend.services.rag_pipeline import _detect_chunker
from backend.services.sbert_loader import get_sbert_model

logger = logging.getLogger(__name__)


def _chunk_active_pages(user_id: int) -> int:
    """Chunk + embed every active page that has content but zero chunks.
    Returns the number of pages chunked. Mirrors backfill_chunks.main's
    --active-only path: each target is (page_content_id, url, fetched_content),
    chunked via ``_detect_chunker(url)(url, fc or {})``."""
    targets = fetch_targets(user_id, None, active_only=True)
    if not targets:
        return 0
    model = get_sbert_model()
    chunked = 0
    for pcid, url, fc in targets:
        try:
            chunks = _detect_chunker(url)(url, fc or {})
            if chunks:
                write_page(pcid, chunks, model)
                chunked += 1
        except Exception:
            logger.exception("catchup: chunk failed for page_content %s", pcid)
    return chunked


async def _classify_learning(user_id: int) -> bool:
    """Run the is_learning backfill for NULL rows. Returns True if it ran.
    (The underlying script is global-active-scoped; in single-user prod this
    is the primary user. Revisit if multi-user.)"""
    from backend.scripts.backfill_learning_classification import main as classify_main

    await classify_main(dry_run=False)
    return True


async def run_catchup_backfills(user_id: int) -> dict:
    """Run both catch-up passes, each isolated. Never raises.

    Returns ``{"chunked_pages": int, "classified_done": bool, "cost_usd": float}``.
    A failure in either pass is logged and reflected in the dict (the other
    pass still runs).
    """
    out = {"chunked_pages": 0, "classified_done": False, "cost_usd": 0.0}
    try:
        out["chunked_pages"] = _chunk_active_pages(user_id)
    except Exception:
        logger.exception("catchup: chunk pass failed")
    try:
        out["classified_done"] = await _classify_learning(user_id)
    except Exception:
        logger.exception("catchup: learning-classification pass failed")
    return out
