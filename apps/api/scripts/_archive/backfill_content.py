"""One-time backfill: propagate extracted_text and re-fetch Reddit content.

Fixes two historical gaps:
  1. pages.extracted_text was never copied to page_content.extracted_text
  2. Reddit posts had no backend fetcher, so they went to catchall with no content

Usage:
    python scripts/_archive/backfill_content.py              # dry run (default)
    python scripts/_archive/backfill_content.py --apply       # actually write changes
"""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

# Allow running as `python scripts/_archive/backfill_content.py`
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db.connection import get_conn
from backend.services.content_fetcher import (
    fetch_reddit_content,
    ContentFetchError,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)


def backfill_extracted_text(dry_run: bool) -> int:
    """Copy pages.extracted_text → page_content.extracted_text where missing."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            # Find eligible rows
            cur.execute("""
                SELECT pc.id, p.extracted_text, pc.url
                FROM pages p
                JOIN page_content pc ON p.page_content_id = pc.id
                WHERE p.extracted_text IS NOT NULL
                  AND pc.extracted_text IS NULL
            """)
            rows = cur.fetchall()

            if not rows:
                log.info("[extracted_text] Nothing to backfill.")
                return 0

            log.info(f"[extracted_text] Found {len(rows)} page_content rows to update.")

            if dry_run:
                # Show sample
                for pc_id, text, url in rows[:5]:
                    preview = text[:80].replace("\n", " ") if text else ""
                    log.info(
                        f"  would update pc.id={pc_id}: {url[:80]}  ({len(text)} chars: {preview}...)"
                    )
                if len(rows) > 5:
                    log.info(f"  ... and {len(rows) - 5} more")
                return len(rows)

            # Batch update
            updated = 0
            for pc_id, text, url in rows:
                cur.execute(
                    "UPDATE page_content SET extracted_text = %s WHERE id = %s",
                    (text, pc_id),
                )
                updated += 1

            log.info(f"[extracted_text] Updated {updated} rows.")
            return updated


async def backfill_reddit(dry_run: bool) -> int:
    """Re-fetch Reddit posts that are currently in catchall."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT p.id, p.url, p.title, pc.id as pc_id
                FROM pages p
                JOIN page_content pc ON p.page_content_id = pc.id
                WHERE p.domain = 'www.reddit.com'
                  AND p.url LIKE '%%/comments/%%'
                  AND (pc.tool_selected IS NULL
                       OR pc.content_summary LIKE 'Tracked domain%%')
            """)
            rows = cur.fetchall()

    if not rows:
        log.info("[reddit] No Reddit posts to re-fetch.")
        return 0

    # Deduplicate by URL (multiple page visits may point to same page_content)
    seen_urls = {}
    for page_id, url, title, pc_id in rows:
        if url not in seen_urls:
            seen_urls[url] = (page_id, title, pc_id)

    log.info(f"[reddit] Found {len(seen_urls)} unique Reddit posts to re-fetch.")

    if dry_run:
        for url, (page_id, title, pc_id) in list(seen_urls.items())[:10]:
            log.info(f"  would fetch: {title[:60]} — {url[:80]}")
        if len(seen_urls) > 10:
            log.info(f"  ... and {len(seen_urls) - 10} more")
        return len(seen_urls)

    fetched = 0
    failed = 0
    for url, (page_id, title, pc_id) in seen_urls.items():
        try:
            content = await fetch_reddit_content(url)
            content_dict = content.model_dump()

            # Build summary from fetched data
            summary_parts = []
            if content.title:
                summary_parts.append(content.title)
            if content.selftext:
                summary_parts.append(content.selftext[:200])
            content_summary = (
                " | ".join(summary_parts)[:300] if summary_parts else "Reddit post fetched"
            )

            with get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE page_content
                        SET fetched_content = %s,
                            content_summary = %s,
                            tool_selected = 'fetch_reddit_content'
                        WHERE id = %s
                    """,
                        (json.dumps(content_dict), content_summary, pc_id),
                    )

                    # Also update the page status from catchall if needed
                    cur.execute(
                        """
                        UPDATE pages
                        SET content_summary = %s
                        WHERE page_content_id = %s
                          AND content_summary LIKE 'Tracked domain%%'
                    """,
                        (content_summary, pc_id),
                    )

            fetched += 1
            log.info(f"  ✓ {title[:50]} — r/{content.subreddit} ({content.comment_count} comments)")

        except ContentFetchError as e:
            failed += 1
            log.info(f"  ✗ {title[:50]} — {e}")
        except Exception as e:
            failed += 1
            log.info(f"  ✗ {title[:50]} — unexpected: {e}")

    log.info(f"[reddit] Fetched {fetched}, failed {failed}.")
    return fetched


async def main():
    parser = argparse.ArgumentParser(description="Backfill page content data.")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually write changes (default is dry run)",
    )
    args = parser.parse_args()

    dry_run = not args.apply
    if dry_run:
        log.info("=== DRY RUN (pass --apply to write changes) ===\n")
    else:
        log.info("=== APPLYING CHANGES ===\n")

    # Phase 1: SQL-only backfill
    text_count = backfill_extracted_text(dry_run)

    # Phase 2: Reddit re-fetch
    reddit_count = await backfill_reddit(dry_run)

    log.info(
        f"\n{'Would update' if dry_run else 'Updated'}: "
        f"{text_count} extracted_text rows, {reddit_count} Reddit posts"
    )


if __name__ == "__main__":
    asyncio.run(main())
