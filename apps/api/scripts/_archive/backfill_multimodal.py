"""Backfill: re-fetch existing Wikipedia pages with multimodal vision augment.

Re-runs ``fetch_wikipedia_content`` with an LLMService for every Wikipedia page
in ``page_content``, so GPT-4o vision describes up to 3 article images each.
Then deletes the page's existing RAG chunks and re-indexes with the fresh
content (which now includes the synthetic "Image descriptions (AI-generated)"
section). The agent's ``search_compendium`` tool can then surface image
descriptions on retrieval.

Idempotent: re-running replaces chunks with fresh descriptions. The
``page_content`` row itself is NOT modified -- clustering and page-level
embeddings are unaffected. Only the RAG ``page_chunks`` / ``chunk_embeddings``
rows for the targeted URLs are rewritten.

Resumable: by default, pages whose chunks already contain an
"Image descriptions (AI-generated)" section are skipped, so reruns
pick up where a previous (possibly crashed) run left off. Use
``--all`` to force-reprocess every Wikipedia page.

Usage:
    python scripts/_archive/backfill_multimodal.py                     # dry-run (default)
    python scripts/_archive/backfill_multimodal.py --apply             # write, skip already-done pages
    python scripts/_archive/backfill_multimodal.py --apply --all       # force-reprocess everything
    python scripts/_archive/backfill_multimodal.py --apply --limit 5
    python scripts/_archive/backfill_multimodal.py --apply --url https://en.wikipedia.org/wiki/Hominidae

Persisted log (recommended on long runs):
    python scripts/_archive/backfill_multimodal.py --apply 2>&1 | tee logs/$(date +%Y-%m-%d-%H%M%S)-multimodal-backfill.log
"""

import argparse
import asyncio
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db.connection import get_conn
from backend.services.content_fetcher import fetch_wikipedia_content
from backend.services.llm_service import LLMService
from backend.services.rag_pipeline import RAGPipeline

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)


def get_wikipedia_pages(
    limit: int | None = None,
    url_filter: str | None = None,
    skip_done: bool = True,
) -> list[dict]:
    """Find Wikipedia pages currently in page_content.

    Args:
        limit: Cap the number of pages returned.
        url_filter: Restrict to a single URL.
        skip_done: When True, exclude pages whose chunks already contain
            an "Image descriptions (AI-generated)" section -- the unique
            signature of a successful M8 backfill. This makes reruns
            resumable: if the script crashes mid-run, the next invocation
            picks up where the previous one left off. Pages with no
            usable images (vision filter rejected all images, or all
            descriptions were refusals) will get re-checked on rerun
            but cost ~$0 because no LLM calls fire when nothing passes
            the filter. Set to False to force re-processing.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            sql = """
                SELECT pc.id, pc.url, pc.content_summary
                FROM page_content pc
                WHERE pc.tool_selected = 'fetch_wikipedia_content'
            """
            params: list = []
            if url_filter:
                sql += " AND pc.url = %s"
                params.append(url_filter)
            if skip_done:
                sql += """
                    AND pc.id NOT IN (
                        SELECT DISTINCT page_content_id
                        FROM page_chunks
                        WHERE section_title = 'Image descriptions (AI-generated)'
                    )
                """
            sql += " ORDER BY pc.id"
            if limit:
                sql += f" LIMIT {int(limit)}"
            cur.execute(sql, params)
            return [
                {"page_content_id": r[0], "url": r[1], "title": r[2] or ""}
                for r in cur.fetchall()
            ]


def get_existing_chunk_ids(page_content_id: int) -> list[int]:
    """Return page_chunks.id list for a given page_content row."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM page_chunks WHERE page_content_id = %s",
                (page_content_id,),
            )
            return [r[0] for r in cur.fetchall()]


async def backfill_one(
    page: dict, llm: LLMService, rag: RAGPipeline
) -> dict:
    """Re-fetch + re-index a single Wikipedia page. Returns counts + flags."""
    url = page["url"]
    pc_id = page["page_content_id"]

    existing_ids = get_existing_chunk_ids(pc_id)
    log.info(f"    existing chunks: {len(existing_ids)}")

    t0 = time.perf_counter()
    try:
        content = await fetch_wikipedia_content(url, llm=llm)
    except Exception as e:
        log.warning(f"    fetch failed: {e}")
        return {
            "existing": len(existing_ids),
            "new": 0,
            "has_images": False,
            "error": str(e),
        }
    fetch_ms = (time.perf_counter() - t0) * 1000
    log.info(
        f"    re-fetched: {len(content.sections)} sections, "
        f"{len(content.full_text)} chars ({fetch_ms:.0f}ms)"
    )

    has_image_section = any(
        "Image descriptions" in s.get("title", "") for s in content.sections
    )
    log.info(
        f"    image-descriptions section: "
        f"{'YES' if has_image_section else 'NO (vision returned no usable descriptions)'}"
    )

    if existing_ids:
        await rag.store.delete([str(i) for i in existing_ids])
        log.info(f"    deleted {len(existing_ids)} old chunks")

    chunk_ids = await rag.add_document(
        url, content.model_dump(), {"title": content.title}
    )
    log.info(f"    re-indexed: {len(chunk_ids)} new chunks")

    return {
        "existing": len(existing_ids),
        "new": len(chunk_ids),
        "has_images": has_image_section,
    }


async def main():
    parser = argparse.ArgumentParser(
        description="Backfill multimodal image descriptions for existing Wikipedia pages",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually re-fetch + re-index (default: dry-run, lists pages only)",
    )
    parser.add_argument("--limit", type=int, help="Process at most N pages")
    parser.add_argument("--url", type=str, help="Process only this specific URL")
    parser.add_argument(
        "--all",
        action="store_true",
        help="Force re-process even pages that already have an Image-descriptions chunk (default: skip)",
    )
    args = parser.parse_args()

    dry_run = not args.apply
    skip_done = not args.all

    log.info(
        f"Backfill mode: {'DRY-RUN' if dry_run else 'APPLY'} "
        f"(resume={'ON, skipping pages already backfilled' if skip_done else 'OFF, processing all pages'})"
    )
    pages = get_wikipedia_pages(
        limit=args.limit, url_filter=args.url, skip_done=skip_done
    )
    log.info(f"Wikipedia pages to process: {len(pages)}")
    if not pages:
        return

    if dry_run:
        log.info("\n--- DRY RUN: would re-fetch the following ---")
        for p in pages[:20]:
            log.info(f"  {p['url']}")
        if len(pages) > 20:
            log.info(f"  ... and {len(pages) - 20} more")
        log.info("\nRe-run with --apply to actually re-fetch and re-index.")
        return

    llm = LLMService()
    rag = RAGPipeline()
    total_existing = 0
    total_new = 0
    total_with_images = 0
    failures: list[str] = []

    overall_t0 = time.perf_counter()
    for i, page in enumerate(pages, 1):
        log.info(f"\n[{i}/{len(pages)}] {page['url']}")
        result = await backfill_one(page, llm, rag)
        if "error" in result:
            failures.append(f"{page['url']}: {result['error']}")
            continue
        total_existing += result["existing"]
        total_new += result["new"]
        if result["has_images"]:
            total_with_images += 1
    overall_elapsed = time.perf_counter() - overall_t0

    log.info("\n" + "=" * 60)
    log.info("Backfill summary:")
    log.info(f"  pages processed:                 {len(pages) - len(failures)} / {len(pages)}")
    log.info(f"  pages with image descriptions:   {total_with_images}")
    log.info(f"  total chunks before:             {total_existing}")
    log.info(f"  total chunks after:              {total_new}")
    log.info(f"  net chunk delta:                 {total_new - total_existing:+d}")
    log.info(f"  total elapsed:                   {overall_elapsed:.1f}s")
    if failures:
        log.info(f"\nFailures ({len(failures)}):")
        for f in failures[:20]:
            log.info(f"  {f}")


if __name__ == "__main__":
    asyncio.run(main())
