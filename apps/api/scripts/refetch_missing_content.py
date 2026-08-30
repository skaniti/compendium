"""One-time re-fetch for page_content rows missing fetched_content JSONB.

Targets Wikipedia and YouTube rows where the fetcher ran historically but
only stored a 300-char summary — fetched_content and extracted_text are NULL.

Usage:
    python scripts/refetch_missing_content.py           # dry-run
    python scripts/refetch_missing_content.py --apply   # actually update DB
"""

import asyncio
import json
import logging
import sys

from backend.db.connection import get_conn
from backend.services.content_fetcher import (
    fetch_wikipedia_content,
    fetch_youtube_metadata,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

DRY_RUN = "--apply" not in sys.argv

# Text extraction keys per fetcher (priority order)
TEXT_KEYS = {
    "fetch_wikipedia_content": "full_text",
    "fetch_youtube_metadata": "transcript",
}


async def refetch_rows(tool_selected: str, fetcher_fn):
    """Re-fetch and update rows for a given tool."""
    text_key = TEXT_KEYS[tool_selected]

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, url FROM page_content "
                "WHERE tool_selected = %s "
                "  AND fetched_content IS NULL "
                "  AND extracted_text IS NULL "
                "ORDER BY id",
                (tool_selected,),
            )
            rows = cur.fetchall()

    logger.info(f"\n{'='*60}")
    logger.info(f"{tool_selected}: {len(rows)} rows to re-fetch")
    logger.info(f"{'='*60}")

    if not rows:
        return 0, 0

    success = 0
    failed = 0

    for row_id, url in rows:
        try:
            content = await fetcher_fn(url=url)
            content_dict = content.model_dump()
            extracted = content_dict.get(text_key, "")

            if DRY_RUN:
                text_len = len(extracted) if extracted else 0
                logger.info(f"  [dry-run] id={row_id} {url[:70]}... → {text_len} chars")
            else:
                with get_conn() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE page_content "
                            "SET fetched_content = %s, "
                            "    extracted_text = CASE WHEN %s != '' AND LENGTH(%s) >= 50 THEN %s ELSE extracted_text END "
                            "WHERE id = %s",
                            (
                                json.dumps(content_dict),
                                extracted or "",
                                extracted or "",
                                extracted,
                                row_id,
                            ),
                        )
                logger.info(
                    f"  [updated] id={row_id} {url[:70]}... → {len(extracted) if extracted else 0} chars"
                )

            success += 1

        except Exception as e:
            failed += 1
            logger.warning(f"  [error] id={row_id} {url[:70]}... → {e}")

    return success, failed


async def main():
    if DRY_RUN:
        logger.info("DRY RUN — pass --apply to update the database\n")
    else:
        logger.info("APPLYING changes to the database\n")

    total_success = 0
    total_failed = 0

    for tool, fetcher in [
        ("fetch_wikipedia_content", fetch_wikipedia_content),
        ("fetch_youtube_metadata", fetch_youtube_metadata),
    ]:
        s, f = await refetch_rows(tool, fetcher)
        total_success += s
        total_failed += f

    logger.info(f"\n{'='*60}")
    logger.info(f"Done. Success: {total_success}, Failed: {total_failed}")
    if DRY_RUN:
        logger.info("(dry run — no changes made)")


if __name__ == "__main__":
    asyncio.run(main())
