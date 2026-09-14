"""Generic demo-noise ingestion runner.

Reads URLs from a markdown URL-table doc, groups them by supercluster
(per the doc's ``### Supercluster N -- <Name>`` headers), and ingests
each as one capture under user 153 (`demo@traversal.local`). After
ingest, backfills `pages.title` from the persisted fetched_content
because PageVisit.title was None at construction time -- the
production extension always sends a browser-tab title, but our
direct-pipeline runner doesn't.

Usage:

    ~/.venvs/compendium-explorer/bin/python3 \\
        -m scripts.demo.ingest_demo_noise \\
        --source-doc <path-to-phase-doc>.md \\
        --capture-id-prefix demo_noise_phase1
"""

from __future__ import annotations

# ENV setup MUST happen before backend imports that resolve user_id.
import os
os.environ["DEV_DEFAULT_USER_EMAIL"] = "demo@traversal.local"

import argparse
import asyncio
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("wikipediaapi").setLevel(logging.WARNING)
logging.getLogger("backend.services.rag_pipeline").setLevel(logging.INFO)


from backend.api.main import _save_capture_to_db, process_capture  # noqa: E402
from backend.db.connection import get_conn  # noqa: E402
from backend.models.capture import CaptureInput, PageVisit  # noqa: E402
from backend.process_captures import update_pages_from_response  # noqa: E402
# parse_v1_urls originally lived in scripts/calibration/ (not extracted into
# this repo); its inlined home is now the sibling ingest script.
from scripts.demo.ingest_demo_v1 import parse_v1_urls  # noqa: E402


logger = logging.getLogger(__name__)

DEMO_USER_ID = 153


def _slugify(name: str) -> str:
    """Lowercase, alpha-num + underscore only, for capture-id slugs."""
    out = []
    for ch in name.lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "_":
            out.append("_")
    return "".join(out).strip("_")


def _build_capture(
    capture_id_prefix: str,
    supercluster: str,
    urls: list[str],
    started: datetime,
) -> CaptureInput:
    """Construct a CaptureInput for one supercluster's worth of URLs."""
    slug = _slugify(supercluster)
    capture_id = f"{capture_id_prefix}_{slug}_{started.strftime('%Y%m%d')}"

    pages: list[PageVisit] = []
    cursor = started
    for url in urls:
        pages.append(
            PageVisit(
                url=url,
                timestamp=cursor,
                dwell_time_seconds=60,
                title=None,
                is_tracked_domain=True,
                transition_type="link",
            )
        )
        cursor = cursor + timedelta(seconds=60)

    return CaptureInput(
        capture_id=capture_id,
        pages=pages,
        events=[],
        started_at=started,
        ended_at=cursor,
    )


def _backfill_titles(capture_db_id: int) -> int:
    """Set pages.title from page_content.fetched_content for this capture.

    Returns the number of rows updated. Called immediately after
    `update_pages_from_response` so each capture lands with valid titles.

    Two SQL passes: first the JSON `title` field (Wikipedia, YouTube,
    arxiv, GenericPageContent); second the GitHub `owner/repo` derivation
    for fetch_github_content rows that don't have a title field.
    """
    n = 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE pages p
                SET title = pc.fetched_content->>'title'
                FROM page_content pc
                WHERE p.capture_id = %s
                  AND p.page_content_id = pc.id
                  AND (p.title IS NULL OR p.title = '')
                  AND pc.fetched_content ? 'title'
                  AND length(coalesce(pc.fetched_content->>'title','')) > 0
                """,
                (capture_db_id,),
            )
            n += cur.rowcount
            cur.execute(
                """
                UPDATE pages p
                SET title = (pc.fetched_content->>'owner') || '/'
                            || (pc.fetched_content->>'repo')
                FROM page_content pc
                WHERE p.capture_id = %s
                  AND p.page_content_id = pc.id
                  AND (p.title IS NULL OR p.title = '')
                  AND pc.tool_selected = 'fetch_github_content'
                """,
                (capture_db_id,),
            )
            n += cur.rowcount
            conn.commit()
    return n


async def _run_one_capture(
    capture_id_prefix: str,
    supercluster: str,
    urls: list[str],
    started: datetime,
    log_dir: Path,
) -> dict:
    """Persist + process one supercluster's capture."""
    capture = _build_capture(capture_id_prefix, supercluster, urls, started)
    log_path = log_dir / f"{capture.capture_id}.json"

    print(f"\n=== {supercluster} ({len(urls)} URLs) -- {capture.capture_id} ===")
    try:
        cap_row = _save_capture_to_db(capture, user_id=DEMO_USER_ID)
    except Exception as exc:
        msg = f"_save_capture_to_db failed: {type(exc).__name__}: {exc}"
        print(f"  ERROR: {msg}")
        return {"supercluster": supercluster, "capture_id": capture.capture_id,
                "status": "save_failed", "error": msg}

    print(f"  saved cap_id={cap_row['id']} ({len(capture.pages)} pages pending)")

    try:
        response = await process_capture(capture)
    except Exception as exc:
        msg = f"process_capture failed: {type(exc).__name__}: {exc}"
        print(f"  ERROR: {msg}")
        return {"supercluster": supercluster, "capture_id": capture.capture_id,
                "cap_db_id": cap_row["id"], "status": "process_failed",
                "error": msg}

    page_errors = update_pages_from_response(cap_row["id"], response)
    titles_filled = _backfill_titles(cap_row["id"])
    print(f"  titles backfilled: {titles_filled}")

    outcome_counts: dict[str, int] = {}
    for r in response.results:
        key = (r.processing_depth or r.status or "unknown")
        outcome_counts[key] = outcome_counts.get(key, 0) + 1

    summary = {
        "supercluster": supercluster,
        "capture_id": capture.capture_id,
        "cap_db_id": cap_row["id"],
        "status": "ok",
        "pages": len(capture.pages),
        "outcome_counts": outcome_counts,
        "page_persist_errors": page_errors,
        "titles_backfilled": titles_filled,
        "total_cost_usd": round(response.total_llm_cost_usd or 0.0, 5),
    }
    log_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"  outcomes: {outcome_counts}  cost: ${summary['total_cost_usd']:.4f}")
    return summary


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generic demo-noise ingestion runner."
    )
    parser.add_argument("--source-doc", type=Path, required=True,
                        help="Path to a markdown URL-table doc.")
    parser.add_argument("--capture-id-prefix", type=str, required=True,
                        help="Prefix for generated capture_ids (e.g. demo_noise_phase1).")
    args = parser.parse_args()

    timestamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    log_dir = PROJECT_ROOT / "logs" / f"demo-noise-ingest-{timestamp}"
    log_dir.mkdir(parents=True, exist_ok=True)

    from backend.api.main import get_default_user_id
    resolved = get_default_user_id()
    print(f"DEV_DEFAULT_USER_EMAIL = {os.environ.get('DEV_DEFAULT_USER_EMAIL')!r}")
    print(f"resolved user_id = {resolved}")
    if resolved != DEMO_USER_ID:
        print(f"ERROR: expected user_id={DEMO_USER_ID}, got {resolved}. Aborting.")
        return 1
    print(f"source-doc: {args.source_doc}")
    print(f"capture-id-prefix: {args.capture_id_prefix}")
    print(f"logs dir: {log_dir}")

    urls = parse_v1_urls(args.source_doc)
    by_super: dict[str, list[str]] = {}
    for _idx, supercluster, url in urls:
        by_super.setdefault(supercluster, []).append(url)
    print(f"\nParsed {len(urls)} URLs across {len(by_super)} supercluster(s):")
    for sc, lst in by_super.items():
        print(f"  {sc}: {len(lst)}")

    base = datetime.now(tz=timezone.utc).replace(microsecond=0)
    summaries: list[dict] = []
    for offset, (supercluster, super_urls) in enumerate(by_super.items()):
        started = base + timedelta(hours=offset)
        summary = await _run_one_capture(
            args.capture_id_prefix, supercluster, super_urls, started, log_dir,
        )
        summaries.append(summary)
        await asyncio.sleep(2.0)

    overall = {
        "timestamp": timestamp,
        "demo_user_id": DEMO_USER_ID,
        "source_doc": str(args.source_doc),
        "captures": summaries,
        "total_cost_usd": round(
            sum(s.get("total_cost_usd", 0.0) for s in summaries), 5
        ),
    }
    (log_dir / "summary.json").write_text(json.dumps(overall, indent=2),
                                          encoding="utf-8")
    print()
    print("=== Overall ===")
    print(json.dumps(overall, indent=2))
    return 0


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    sys.exit(asyncio.run(main()))
