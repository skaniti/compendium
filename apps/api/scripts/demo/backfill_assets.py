"""Backfill asset archive for user 153's demo captures.

The original ingest_demo_v1 runner called process_capture directly,
bypassing _process_capture_background. The latter is the wrapper that
kicks off _archive_assets_for_response, so no images / stylesheets were
downloaded into data/captures/assets/. Without that, preview_renderer
has nothing to URL-rewrite to, leaving the iframe to load
upload.wikimedia.org images directly -- which Edge Tracking Prevention
silently blocks inside iframe contexts (third-party-in-subframe).

This script reruns archive_assets_for_page over every page_content row
that has raw_html populated for user 153.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

import logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
logging.getLogger('httpx').setLevel(logging.WARNING)

from backend.db.connection import get_conn  # noqa: E402
from backend.services.asset_archiver import archive_assets_for_page  # noqa: E402


async def main() -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT pc.id, pc.url, pc.raw_html
                FROM page_content pc
                JOIN pages p ON p.page_content_id = pc.id
                WHERE p.user_id = 153 AND pc.raw_html IS NOT NULL
                ORDER BY pc.id
                """
            )
            rows = [(r[0], r[1], bytes(r[2])) for r in cur.fetchall()]

    print(f"backfilling {len(rows)} pages for user 153")
    total_assets = 0
    fail = 0
    for pid, url, gz in rows:
        try:
            n = await archive_assets_for_page(pid, gz, url, user_id=153)
        except Exception as exc:
            print(f"  pid={pid} {url}: ERROR {type(exc).__name__}: {exc}")
            fail += 1
            continue
        total_assets += n
        print(f"  pid={pid:5d}  {n:3d} assets  {url}"[:140])

    print()
    print(f"done. {total_assets} assets total across {len(rows)} pages, {fail} failed.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
