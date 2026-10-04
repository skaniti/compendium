"""One-time re-fetch for GitHub repo pages missing content.

Fetches README + metadata via the GitHub REST API for pages that
have sparse or missing extracted_text.

Usage:
    python scripts/_archive/refetch_github.py           # dry-run
    python scripts/_archive/refetch_github.py --apply   # actually update DB
"""

import asyncio
import json
import logging
import sys

from backend.db.connection import get_conn
from backend.services.content_fetcher import fetch_github_content, ContentFetchError

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

DRY_RUN = "--apply" not in sys.argv

# GitHub unauthenticated API: 60 req/hr. Be conservative.
RATE_DELAY = 1.5  # seconds between requests


async def main():
    if DRY_RUN:
        logger.info("DRY RUN — pass --apply to update the database\n")
    else:
        logger.info("APPLYING changes to the database\n")

    # Find GitHub page_content rows with sparse extracted_text
    # Only fetch repo-root URLs (owner/repo), not /blob/, /tree/, /settings etc.
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT pc.id, pc.url
                FROM page_content pc
                JOIN pages p ON p.page_content_id = pc.id
                WHERE pc.domain = 'github.com'
                  AND (pc.extracted_text IS NULL OR LENGTH(pc.extracted_text) < 50)
                  AND pc.url ~ '^https://github.com/[^/]+/[^/]+/?$'
                ORDER BY pc.id
            """)
            rows = cur.fetchall()

    logger.info(f"Found {len(rows)} GitHub repo pages to re-fetch\n")

    success = 0
    failed = 0
    skipped = 0

    for row_id, url in rows:
        try:
            content = await fetch_github_content(url)
            text = content.full_text

            if DRY_RUN:
                logger.info(f"  [dry-run] id={row_id} {url} → {len(text)} chars")
            else:
                content_dict = content.model_dump()
                with get_conn() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            """UPDATE page_content
                               SET fetched_content = %s,
                                   extracted_text = CASE
                                       WHEN LENGTH(%s) >= 50 THEN %s
                                       ELSE extracted_text END,
                                   tool_selected = 'fetch_github_content'
                               WHERE id = %s""",
                            (json.dumps(content_dict), text, text, row_id),
                        )
                logger.info(f"  [updated] id={row_id} {url} → {len(text)} chars")

            success += 1

        except ContentFetchError as e:
            failed += 1
            logger.warning(f"  [skip] id={row_id} {url} → {e}")

        except Exception as e:
            failed += 1
            logger.warning(f"  [error] id={row_id} {url} → {e}")

        # Rate limiting
        await asyncio.sleep(RATE_DELAY)

    logger.info(f"\nDone. Success: {success}, Failed: {failed}")
    if DRY_RUN:
        logger.info("(dry run — no changes made)")


if __name__ == "__main__":
    asyncio.run(main())
