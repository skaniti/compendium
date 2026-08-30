"""Process pending captures through the LLM pipeline.

Reads captures with pending pages from PostgreSQL and runs the 2-stage
processing pipeline (content fetch + skip gate).  Page statuses and
content are updated in the database.

Only processes captures that have pages in 'pending' status, so it's safe
to re-run.

Usage:
    # Process all pending captures
    python -m backend.process_captures

    # Process a specific capture by capture_id
    python -m backend.process_captures cap_abc123
"""

import asyncio
import json
import logging
import sys
import time

import psycopg2
from pathlib import Path

from tqdm import tqdm

# Suppress noisy HTTP/API loggers so tqdm output stays clean
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("wikipediaapi").setLevel(logging.WARNING)
logging.getLogger("backend.services.rag_pipeline").setLevel(logging.WARNING)

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.main import (
    process_capture,
    get_default_user_id,
    TOOL_SELECTION_MODEL,
)
from backend.db import capture_repo, content_repo, page_repo
from backend.models.capture import CaptureInput, PageVisit
from backend.services.clustering_service import _BOILERPLATE_SUMMARY_RE
from backend.services.graph_builder import build_graph_from_db
from backend.services.graph_service import save_graph


def load_content_cache_from_db() -> dict[str, dict]:
    """Build a URL→content cache from the page_content table.

    Replaces the old filesystem-based cache that scanned processed JSON files.
    """
    from backend.db.connection import get_conn

    cache: dict[str, dict] = {}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT url, fetched_content FROM page_content " "WHERE fetched_content IS NOT NULL"
            )
            for row in cur.fetchall():
                url = row[0]
                fc = row[1]
                if isinstance(fc, str):
                    fc = json.loads(fc)
                if fc:
                    cache[url] = fc

    return cache


def find_pending_captures(user_id: int) -> list[dict]:
    """Find captures that have pages still in 'pending' status."""
    return page_repo.get_pending_captures(user_id)


_PAGE_VISIT_TEXT_MAX = 100_000  # mirrors PageVisit.extracted_text max_length
_PAGE_VISIT_TITLE_MAX = 500  # mirrors PageVisit.title max_length


def build_capture_input_from_db(cap: dict) -> CaptureInput:
    """Reconstruct a CaptureInput from DB data for the processing pipeline."""
    pages_data = page_repo.get_pages_for_capture(cap["id"])
    page_visits = []
    for p in pages_data:
        # Defensive truncation: legacy rows can exceed the PageVisit max_length
        # constraint (100k chars). Truncating here keeps the startup sweep
        # resilient instead of aborting the whole capture on one oversize page.
        text = p.get("extracted_text")
        if text is not None and len(text) > _PAGE_VISIT_TEXT_MAX:
            logging.getLogger(__name__).warning(
                "Truncating oversize extracted_text (%d → %d chars) for url=%s",
                len(text),
                _PAGE_VISIT_TEXT_MAX,
                p.get("url", "?")[:100],
            )
            text = text[:_PAGE_VISIT_TEXT_MAX]

        # Same defensive truncation for title: passive/mobile rows can store a
        # URL-as-title far longer than PageVisit.title's 500-char limit, which
        # would otherwise abort reprocessing (and strand the capture pending).
        title = p.get("title")
        if title is not None and len(title) > _PAGE_VISIT_TITLE_MAX:
            logging.getLogger(__name__).warning(
                "Truncating oversize title (%d → %d chars) for url=%s",
                len(title),
                _PAGE_VISIT_TITLE_MAX,
                p.get("url", "?")[:100],
            )
            title = title[:_PAGE_VISIT_TITLE_MAX]

        page_visits.append(
            PageVisit(
                url=p["url"],
                timestamp=p["visited_at"] or cap["started_at"],
                dwell_time_seconds=p.get("dwell_time_seconds"),
                title=title,
                is_tracked_domain=p.get("is_tracked_domain", True),
                transition_type=p.get("transition_type"),
                transition_qualifiers=p.get("transition_qualifiers"),
                extracted_text=text,
            )
        )

    return CaptureInput(
        capture_id=cap["capture_id"],
        pages=page_visits,
        events=[],
        started_at=cap["started_at"],
        ended_at=cap["ended_at"],
    )


def _format_duration(ms: float) -> str:
    """Format milliseconds as human-readable duration."""
    seconds = ms / 1000
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes = int(seconds // 60)
    secs = seconds % 60
    return f"{minutes}m {secs:.0f}s"


def _print_capture_report(response, elapsed_ms: float) -> None:
    """Print a detailed per-capture summary after processing."""
    cost = response.total_llm_cost_usd or 0

    n_fetched = sum(1 for r in response.results if r.status == "success")
    n_depth_calls = sum(1 for r in response.results if r.processing_depth is not None)

    duration = _format_duration(elapsed_ms)
    tqdm.write(f"  {'─' * 60}")
    tqdm.write(f"  Capture: {response.capture_id}")
    if response.capture_title:
        tqdm.write(f"  Title:   {response.capture_title}")
    tqdm.write(f"  Cost:    ${cost:.4f}  |  Duration: {duration}  |  LLM calls: {n_depth_calls}")

    tqdm.write(f"  ┌─ Stage 0  Content fetch     {n_fetched} pages fetched")
    tqdm.write(f"  └─ Stage 1  Depth gating      {n_depth_calls} calls  ({TOOL_SELECTION_MODEL})")

    skipped = sum(1 for r in response.results if r.processing_depth == "skipped")
    processed = sum(1 for r in response.results if r.processing_depth == "processed")
    tqdm.write(f"              Results:           skip={skipped}  processed={processed}")
    tqdm.write("")


def update_pages_from_response(cap_db_id: int, response) -> int:
    """Update page statuses and content in DB from pipeline response.

    Processes each page independently so a single failure (e.g. URL too
    long for the page_content index) doesn't kill the entire capture.
    Returns the number of pages that failed to persist.
    """
    pages = page_repo.get_pages_for_capture(cap_db_id)
    page_errors = 0

    for page_row, result in zip(pages, response.results):
        try:
            _persist_single_page(page_row, result, response)
        except Exception:
            page_errors += 1
            _log_page_error(response.capture_id, page_row, result)

    # Update capture title/summary even if some pages failed
    capture_repo.update_capture(
        cap_db_id,
        title=response.capture_title,
        mini_summary=response.mini_summary,
    )

    return page_errors


def _persist_single_page(page_row: dict, result, response) -> None:
    """Persist a single page's processing results to the database."""
    # Determine status
    if result.processing_depth == "skipped":
        status = "archived"
        archive_reason = (
            "domain_skip" if "Domain skipped" in (result.content_summary or "") else "skip_gate"
        )
    elif result.content_summary and _BOILERPLATE_SUMMARY_RE.match(result.content_summary):
        # Untracked-domain catchall pages with no usable text persist as the
        # generic "Page browsed outside API tool scope for N seconds" stub
        # (main.py's catchall branch, no fetcher/tool selected). No real
        # content -- archive instead of polluting the active corpus (dq
        # queue RC-D: these were 1500 rows, 57% of "active" pages).
        status = "archived"
        archive_reason = "placeholder_no_content"
    elif result.status in ("success", "catchall"):
        status = "active"
        archive_reason = None
    else:
        status = "active"
        archive_reason = None

    # Sensitive-skip retention carve-out (retain-skipped-pages plan): the thin
    # audit row (url/title/domain/verdict) is kept, but content must not be --
    # no page_content link, no real summary, and extracted_text nulled below.
    from backend.utils.skip_retention import should_redact_snippet

    redact = (
        status == "archived"
        and archive_reason in ("skip_gate", "domain_skip")
        and should_redact_snippet(getattr(result, "processing_depth_reasoning", None))
    )

    # Save fetched content to page_content table
    content_id = None
    fetched = response.fetched_contents.get(result.url)
    if not redact and (fetched or result.content_summary):
        # Use extension Readability text if available; otherwise extract from
        # the fetcher's structured JSONB (tracked domains skip Readability).
        ext_text = page_row.get("extracted_text")
        if (not ext_text or len(ext_text) < 50) and fetched:
            for key in (
                "full_text",
                "transcript",
                "body",
                "selftext",
                "abstract",
                "text",
            ):
                candidate = fetched.get(key)
                if candidate and len(candidate) >= 50:
                    ext_text = candidate
                    break

            # Reddit: append top comments for richer content
            if fetched.get("top_comments"):
                comments = fetched["top_comments"]
                if isinstance(comments, list):
                    comments_text = "\n\n".join(str(c) for c in comments)
                else:
                    comments_text = str(comments)
                if comments_text:
                    ext_text = (ext_text or "") + "\n\n---\n\n" + comments_text

        content_row = content_repo.get_or_create_content(
            result.url,
            extracted_text=ext_text,
            fetched_content=fetched,
            content_summary=result.content_summary,
            tool_selected=result.tool_selected,
        )
        content_id = content_row["id"]

        # Write learning classification to page_content (Plan 07)
        if getattr(result, "is_learning", None) is not None:
            content_repo.update_content(content_id, is_learning=result.is_learning)

        # Raw HTML archival (iframe preview) — best-effort; only runs
        # when the archiver in backend/services/raw_html_archiver.py
        # succeeded for this URL. Absent entries leave raw_html null
        # and the preview falls back to plaintext rendering.
        artifact = response.raw_html_artifacts.get(result.url)
        if artifact and artifact.get("gzipped"):
            from datetime import datetime, timezone
            import gzip as _gzip
            from backend.services.content_extractor import is_usable

            # Evaluate whether the stored HTML is renderable before we
            # persist — JS shells and auth walls get raw_html_usable
            # = false, which makes the Dash layer fall through to the
            # plaintext renderer instead of showing an empty iframe.
            try:
                usable = is_usable(_gzip.decompress(artifact["gzipped"]), result.url)
            except Exception:
                usable = False
            content_repo.update_content(
                content_id,
                raw_html=psycopg2.Binary(artifact["gzipped"]),
                raw_html_content_type=artifact.get("content_type"),
                raw_html_fetched_at=datetime.now(timezone.utc),
                raw_html_usable=usable,
            )

    # Stash the content_id back onto the result so downstream async
    # steps (asset archival) can find the row they just created.
    if content_id is not None:
        result.page_content_id = content_id

    page_repo.update_page_status(
        page_row["id"],
        status,
        archive_reason=archive_reason,
        skip_reasoning=result.processing_depth_reasoning,
        processing_depth=result.processing_depth,
        processing_metadata={
            "cost_usd": result.cost_usd,
            "input_tokens": result.input_tokens,
            "output_tokens": result.output_tokens,
            "latency_ms": result.latency_ms,
        }
        if result.cost_usd
        else None,
        content_summary=(
            "[redacted: sensitive-skip retention carve-out]"
            if redact
            else result.content_summary
        ),
        page_content_id=content_id,
    )
    if redact:
        page_repo.redact_page_extracted_text(page_row["id"])


def _log_page_error(capture_id: str, page_row: dict, result) -> None:
    """Log a per-page persistence error to data/page_errors.log and tqdm."""
    import traceback

    url = result.url if result else page_row.get("url", "?")
    url_preview = url[:120] + "..." if len(url) > 120 else url
    tb = traceback.format_exc()

    tqdm.write(f"  WARN: skipped page (DB error): {url_preview}")

    log_path = PROJECT_ROOT / "data" / "page_errors.log"
    try:
        with open(log_path, "a") as f:
            f.write(
                f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] " f"capture={capture_id} url={url}\n{tb}\n"
            )
    except OSError:
        pass


async def process_one(
    cap: dict,
    pbar: tqdm | None = None,
    content_cache: dict[str, dict] | None = None,
) -> tuple[bool, float]:
    """Process a single capture from DB. Returns (success, cost)."""
    if pbar:
        pbar.set_postfix_str(cap["capture_id"][:40], refresh=True)

    start = time.perf_counter()
    try:
        capture_input = build_capture_input_from_db(cap)
        response = await process_capture(
            capture_input,
            content_cache=content_cache,
        )
        elapsed_ms = (time.perf_counter() - start) * 1000

        # Update DB with processing results
        page_errors = update_pages_from_response(cap["id"], response)

        _print_capture_report(response, elapsed_ms)
        if page_errors:
            tqdm.write(
                f"  WARN: {page_errors} page(s) failed to persist (see data/page_errors.log)"
            )
        return True, response.total_llm_cost_usd or 0
    except Exception as e:
        elapsed_ms = (time.perf_counter() - start) * 1000
        tqdm.write(f"  ERROR processing {cap['capture_id']}: {e} ({_format_duration(elapsed_ms)})")
        return False, 0.0


async def main():
    args = sys.argv[1:]

    user_id = get_default_user_id()

    # Build content cache from page_content table
    print("Loading content cache from page_content table...")
    content_cache = load_content_cache_from_db()
    print(f"Cache: {len(content_cache)} URLs from prior captures\n")

    if args:
        # Process a specific capture by capture_id
        cap = capture_repo.get_capture(args[0])
        if not cap:
            print(f"Capture not found: {args[0]}")
            sys.exit(1)
        ok, cost = await process_one(cap, content_cache=content_cache)
        if ok:
            print(f"\nTotal cost: ${cost:.4f}")
        return

    # Process all pending captures
    pending = find_pending_captures(user_id)
    if not pending:
        print("No pending captures found.")
        return

    print(f"Found {len(pending)} capture(s) with pending pages\n")

    succeeded = 0
    total_cost = 0.0
    batch_start = time.perf_counter()

    with tqdm(pending, desc="Processing captures", unit="capture") as pbar:
        for cap in pbar:
            ok, cost = await process_one(cap, pbar, content_cache=content_cache)
            if ok:
                succeeded += 1
                total_cost += cost

    batch_duration = _format_duration((time.perf_counter() - batch_start) * 1000)

    print(f"\n{'═' * 60}")
    print("  BATCH COMPLETE")
    print(f"  Captures:  {succeeded}/{len(pending)} succeeded")
    print(f"  Duration:  {batch_duration}")
    print(f"  Cost:      ${total_cost:.4f}")
    print(f"{'═' * 60}")

    # Record status snapshot for Trends view
    try:
        from backend.db import trends_repo

        page_counts = page_repo.get_page_status_counts(user_id)
        trends_repo.insert_status_snapshot(
            user_id=user_id,
            active_count=page_counts.get("active", 0),
            pending_count=page_counts.get("pending", 0),
            archived_count=page_counts.get("archived", 0),
            total_cost_usd=total_cost,
        )
    except Exception:
        pass  # fail-silent — never break the pipeline

    # Rebuild knowledge graph from DB
    if succeeded > 0:
        print("\nRebuilding knowledge graph...")
        graph = build_graph_from_db(user_id)
        save_graph(graph, user_id)
        print(f"Graph saved: {len(graph.nodes)} nodes, {len(graph.edges)} edges")


if __name__ == "__main__":
    asyncio.run(main())
