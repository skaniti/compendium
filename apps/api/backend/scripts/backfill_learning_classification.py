"""One-time backfill: classify page_content rows as LEARNING or SKIP.

Populates the is_learning column added by migration 013. Three-tier strategy:
  1. Domain shortcuts (no LLM): Wikipedia/arxiv → TRUE, skipped pages → FALSE
  2. LLM classification via gpt-4o-mini for the rest
  3. Idempotent: only processes rows where is_learning IS NULL

Usage:
    python -m backend.scripts.backfill_learning_classification              # dry run
    python -m backend.scripts.backfill_learning_classification --apply      # write changes
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

# repo root = two levels up (this file lives at backend/scripts/)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db.connection import get_conn
from backend.prompts.templates import get_prompt
from backend.services.llm_service import LLMService

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

CLASSIFICATION_MODEL = "gpt-4o-mini"
CONCURRENCY = 10

# Domain shortcuts — skip the LLM for obvious cases
ALWAYS_LEARNING_DOMAINS = {"en.wikipedia.org", "arxiv.org"}


def _load_unclassified_rows() -> list[dict]:
    """Load page_content rows that need classification."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT pc.id, pc.url, pc.domain,
                       COALESCE(pc.content_summary, '') AS content_summary,
                       pc.extracted_text,
                       pc.fetched_content,
                       p.processing_depth
                FROM page_content pc
                JOIN pages p ON p.page_content_id = pc.id
                WHERE pc.is_learning IS NULL
                  AND COALESCE(p.human_status, p.status) = 'active'
                GROUP BY pc.id, pc.url, pc.domain, pc.content_summary,
                         pc.extracted_text, pc.fetched_content, p.processing_depth
            """)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def _build_snippet(row: dict) -> str:
    """Build a content snippet for the LLM prompt."""
    if row.get("content_summary"):
        return row["content_summary"][:500]
    if row.get("extracted_text"):
        return row["extracted_text"][:500]
    return ""


def _apply_domain_shortcuts(
    rows: list[dict],
) -> tuple[list[tuple[int, bool]], list[dict]]:
    """Classify rows by domain shortcut. Returns (classified, remaining)."""
    classified: list[tuple[int, bool]] = []
    remaining: list[dict] = []

    for row in rows:
        domain = (row.get("domain") or "").lower()

        # Shortcut: known learning domains
        if domain in ALWAYS_LEARNING_DOMAINS:
            classified.append((row["id"], True))
            continue

        # Shortcut: pages the skip gate already rejected
        if row.get("processing_depth") == "skipped":
            classified.append((row["id"], False))
            continue

        remaining.append(row)

    return classified, remaining


async def _classify_one(
    llm: LLMService,
    row: dict,
) -> tuple[int, bool, float]:
    """Classify a single row via LLM. Returns (id, is_learning, cost)."""
    domain = row.get("domain") or "unknown"
    title = (row.get("url") or "").split("/")[-1] or "Unknown"

    # Try to extract a better title from fetched_content
    if row.get("fetched_content"):
        import json

        try:
            fc = row["fetched_content"]
            if isinstance(fc, str):
                fc = json.loads(fc)
            title = fc.get("title") or title
        except Exception:
            pass

    snippet = _build_snippet(row)
    prompt = get_prompt(
        "learning_gate_v1",
        title=title,
        domain=domain,
        snippet=snippet or "(no content preview available)",
    )

    response = await llm.complete(
        prompt=prompt,
        model=CLASSIFICATION_MODEL,
        temperature=0.0,
        max_tokens=5,
    )

    answer = response.content.strip().upper()
    is_learning = answer != "SKIP"
    return row["id"], is_learning, response.cost_usd


async def _classify_batch(
    llm: LLMService,
    rows: list[dict],
) -> tuple[list[tuple[int, bool]], float]:
    """Classify a batch of rows via LLM with concurrency limit."""
    sem = asyncio.Semaphore(CONCURRENCY)
    total_cost = 0.0
    results: list[tuple[int, bool]] = []

    async def _limited(row: dict):
        async with sem:
            return await _classify_one(llm, row)

    tasks = [_limited(row) for row in rows]
    for coro in asyncio.as_completed(tasks):
        try:
            content_id, is_learning, cost = await coro
            results.append((content_id, is_learning))
            total_cost += cost
        except Exception as e:
            log.warning(f"  Classification failed: {e}")

    return results, total_cost


def _write_classifications(
    classifications: list[tuple[int, bool]],
    dry_run: bool,
) -> None:
    """Write is_learning values to page_content."""
    if dry_run or not classifications:
        return

    with get_conn() as conn:
        with conn.cursor() as cur:
            for content_id, is_learning in classifications:
                cur.execute(
                    "UPDATE page_content SET is_learning = %s WHERE id = %s",
                    (is_learning, content_id),
                )
        conn.commit()


async def main(dry_run: bool) -> None:
    log.info(f"{'DRY RUN' if dry_run else 'APPLYING'} — Learning classification backfill")

    rows = _load_unclassified_rows()
    log.info(f"Found {len(rows)} unclassified page_content rows")

    if not rows:
        log.info("Nothing to do.")
        return

    # Phase 1: domain shortcuts
    shortcut_results, remaining = _apply_domain_shortcuts(rows)
    learning_shortcuts = sum(1 for _, v in shortcut_results if v)
    skip_shortcuts = sum(1 for _, v in shortcut_results if not v)
    log.info(
        f"Domain shortcuts: {len(shortcut_results)} classified "
        f"({learning_shortcuts} LEARNING, {skip_shortcuts} SKIP)"
    )
    log.info(f"Remaining for LLM: {len(remaining)}")

    _write_classifications(shortcut_results, dry_run)

    # Phase 2: LLM classification
    llm_results: list[tuple[int, bool]] = []
    if remaining:
        llm = LLMService()
        llm_results, total_cost = await _classify_batch(llm, remaining)
        learning_llm = sum(1 for _, v in llm_results if v)
        skip_llm = sum(1 for _, v in llm_results if not v)
        log.info(
            f"LLM classified: {len(llm_results)} "
            f"({learning_llm} LEARNING, {skip_llm} SKIP, ${total_cost:.4f})"
        )
        _write_classifications(llm_results, dry_run)

    # Summary
    all_results = shortcut_results + llm_results
    total_learning = sum(1 for _, v in all_results if v)
    total_skip = sum(1 for _, v in all_results if not v)
    log.info(
        f"\nTotal: {len(all_results)} classified — "
        f"{total_learning} LEARNING ({total_learning/len(all_results)*100:.0f}%), "
        f"{total_skip} SKIP"
    )
    if not dry_run:
        log.info("Classifications written to page_content.is_learning")
    else:
        log.info("Dry run — no changes written. Use --apply to write.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill is_learning classification")
    parser.add_argument("--apply", action="store_true", help="Actually write changes")
    args = parser.parse_args()
    asyncio.run(main(dry_run=not args.apply))
