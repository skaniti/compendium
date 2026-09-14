"""Materialize the v1 demo dataset by ingesting the 59 curated URLs.

Reads URLs from
the 2026-05-03 demo-curation-v1 plan (private), spec.md,
groups them by supercluster (4 captures), and runs each through the full
production capture pipeline (Stage 0 fetch + RAG indexing + skip gate +
content + cluster) under user_id 153 (`demo@traversal.local`).

Persistence identity is locked at the runner level: `DEV_DEFAULT_USER_EMAIL`
is set to `demo@traversal.local` BEFORE backend imports execute, so every
internal call site that resolves via `get_default_user_id()` lands on the
demo user. `_save_capture_to_db` is also called with `user_id=153`
explicitly for belt-and-suspenders.

Capture-id naming: `demo_<supercluster>_<YYYYMMDD>` -- stable across reruns
within a day so the script can be re-invoked safely (it errors on
duplicate, deletion is manual).

Usage:

    ~/.venvs/compendium-explorer/bin/python3 \\
        -m scripts.demo.ingest_demo_v1

Output goes to `logs/demo-ingest-<YYYY-MM-DD-HHMMSS>/` per the project
log convention.
"""

from __future__ import annotations

# ENV setup MUST happen before any backend import that resolves user_id.
import os
os.environ["DEV_DEFAULT_USER_EMAIL"] = "demo@traversal.local"

import asyncio
import json
import logging
import re
import sys
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

# Repo root (PROJECT_ROOT is apps/api, needed on sys.path for the `backend`
# imports below) — only used to locate the v1 URL-list doc, which lives
# in a private planning archive outside this repo.
REPO_ROOT = PROJECT_ROOT.parent


# Quiet noisy loggers; keep our own at INFO
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("wikipediaapi").setLevel(logging.WARNING)
logging.getLogger("backend.services.rag_pipeline").setLevel(logging.INFO)


from backend.api.main import (  # noqa: E402
    _save_capture_to_db,
    process_capture,
)
from backend.models.capture import CaptureInput, PageVisit  # noqa: E402
from backend.process_captures import update_pages_from_response  # noqa: E402


logger = logging.getLogger(__name__)

DEMO_USER_ID = 153
DEMO_USER_EMAIL = "demo@traversal.local"

# The doc lives in a private planning archive outside this repo, reachable
# here only via a gitignored symlink — it moved to `_completed/` after the
# curation work finished; the path below is stale-fixed to match (was
# missing that segment).
V1_DOC_PATH = (
    REPO_ROOT / "docs" / "project-plans" / "_completed"
    / "2026-05-03-160117-demo-curation-v1" / "spec.md"
)

# Markdown-table URL extractor: stops at whitespace / asterisk (markdown
# bold) / pipe (table cell separator) / closing bracket. Parens are kept
# inside the URL so Wikipedia titles like
# `Diffusion_model_(machine_learning)` survive.
_URL_RE = re.compile(r"https?://[^\s*|\]]+")
# Header-row detection for the supercluster URL tables.
_SUPERCLUSTER_HEADER_RE = re.compile(
    r"^###\s+Supercluster\s+\d+\s+--\s+(.+?)\s+\(", re.IGNORECASE
)


def parse_v1_urls(doc_path: Path) -> list[tuple[int, str, str]]:
    """Parse the v1 doc's URL tables; return (index, supercluster, url) tuples.

    Inlined from the private predecessor repo's
    scripts/calibration/run_demo_skip_gate_dry.py, which this repo's
    extraction did not carry over (that module also pulls in LLMService +
    the skip-gate prompt machinery just to do a dry-run scoring pass this
    script has no use for) — parse_v1_urls itself has no such dependency,
    so it's copied here directly rather than dragging the rest of that
    module in. Walks the doc, tracks the current supercluster from headers
    like `### Supercluster 1 -- Diffusion models (n=12)`, and extracts
    every URL inside the URL table rows that follow.
    """
    text = doc_path.read_text(encoding="utf-8")
    out: list[tuple[int, str, str]] = []
    current_super: str | None = None
    in_url_table = False
    row_index = 0

    for raw_line in text.splitlines():
        line = raw_line.strip()
        m = _SUPERCLUSTER_HEADER_RE.match(line)
        if m:
            current_super = m.group(1).strip()
            in_url_table = False
            row_index = 0
            continue

        if current_super is None:
            continue

        if line.startswith("|---") or line.startswith("|----"):
            in_url_table = True
            continue
        if in_url_table:
            if not line.startswith("|"):
                in_url_table = False
                continue
            url_match = _URL_RE.search(line)
            if url_match:
                row_index += 1
                url = url_match.group(0).rstrip(",;")
                out.append((row_index, current_super, url))

    return out

# Map raw supercluster names from the v1 doc to short capture-id slugs.
_CLUSTER_SLUG: dict[str, str] = {
    "Diffusion models": "diffusion",
    "Cephalopods": "cephalopods",
    "Greek + Roman mythology": "mythology",
    "Hardware tinkering": "hardware",
}


def _build_capture(
    supercluster: str, urls: list[str], started: datetime
) -> CaptureInput:
    """Construct a CaptureInput for one supercluster.

    Synthetic timestamps -- 60 seconds of dwell per page, sequential.
    Browse-sequencing realism is round 7 / out of v1 scope; doc order
    is the deterministic stand-in.
    """
    slug = _CLUSTER_SLUG.get(supercluster, supercluster.lower().replace(" ", "_"))
    capture_id = f"demo_{slug}_{started.strftime('%Y%m%d')}"

    pages: list[PageVisit] = []
    cursor = started
    for url in urls:
        pages.append(
            PageVisit(
                url=url,
                timestamp=cursor,
                dwell_time_seconds=60,
                title=None,            # the fetcher provides; extension sends None too
                is_tracked_domain=True,  # routes through DOMAIN_TO_FETCHER + generic fallback
                transition_type="link",
            )
        )
        cursor = cursor + timedelta(seconds=60)

    ended = cursor
    return CaptureInput(
        capture_id=capture_id,
        pages=pages,
        events=[],
        started_at=started,
        ended_at=ended,
    )


async def _run_one_capture(
    supercluster: str, urls: list[str], started: datetime, log_dir: Path
) -> dict:
    """Persist + process one supercluster's capture.

    Returns a small status dict for the summary.
    """
    capture = _build_capture(supercluster, urls, started)
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

    # Per-URL outcome counts
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
        "total_cost_usd": round(response.total_llm_cost_usd or 0.0, 5),
        "total_processing_time_ms": round(response.total_processing_time_ms or 0.0, 1),
        "capture_title": response.capture_title,
    }

    log_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"  status: {summary['status']}  outcomes: {outcome_counts}  "
          f"cost: ${summary['total_cost_usd']:.4f}")
    return summary


async def main() -> int:
    timestamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    log_dir = PROJECT_ROOT / "logs" / f"demo-ingest-{timestamp}"
    log_dir.mkdir(parents=True, exist_ok=True)

    # Verify env actually flowed through
    from backend.api.main import get_default_user_id
    resolved = get_default_user_id()
    print(f"DEV_DEFAULT_USER_EMAIL = {os.environ.get('DEV_DEFAULT_USER_EMAIL')!r}")
    print(f"resolved user_id = {resolved}")
    if resolved != DEMO_USER_ID:
        print(f"ERROR: expected user_id={DEMO_USER_ID}, got {resolved}. Aborting.")
        return 1
    print(f"Logs dir: {log_dir}")

    urls = parse_v1_urls(V1_DOC_PATH)
    by_super: dict[str, list[str]] = {}
    for _idx, supercluster, url in urls:
        by_super.setdefault(supercluster, []).append(url)
    print(f"Parsed {len(urls)} URLs across {len(by_super)} superclusters:")
    for sc, lst in by_super.items():
        print(f"  {sc}: {len(lst)}")

    # Stagger capture start times by 1 hour each so the ordering is stable
    # in any reverse-chronological view of the demo user's captures.
    base = datetime.now(tz=timezone.utc).replace(microsecond=0)
    summaries: list[dict] = []
    for offset, (supercluster, super_urls) in enumerate(by_super.items()):
        started = base + timedelta(hours=offset)
        summary = await _run_one_capture(supercluster, super_urls, started, log_dir)
        summaries.append(summary)
        # Brief pause between captures: lets the recluster (if it fires
        # after a capture) settle and gives external services a breather.
        await asyncio.sleep(2.0)

    overall = {
        "timestamp": timestamp,
        "demo_user_id": DEMO_USER_ID,
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
