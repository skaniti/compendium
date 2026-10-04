"""Historical cleanup for SPA param-mutation dupes in the pages table.

Complements ``backend/db/page_repo.py::_collapse_consecutive_duplicates``
by applying the same two rules retroactively to existing pages rows
that were recorded before the rules existed in the extension + backend.

Background:
    Plan 03 (2026-04-05) introduced an unconditional last-10 dedup
    window in the extension and a matching helper on
    ``insert_pages``. That handles new captures.

    But plenty of existing ``pages`` rows come from older extension
    versions. Specifically, the DuckDuckGo-style case — where a page's
    JavaScript mutates its own URL via pushState/replaceState and
    produces a chain of visits with different query strings but the
    same host+path — was never caught by any prior dedup layer. Those
    rows are in the DB now and visible when browsing the DB viewer.

    This script is the retroactive cleanup: scan every capture, find
    near-consecutive visits with either (a) matching normalized_url
    or (b) matching host+path within 5 seconds, and merge losers into
    the canonical pages row. Then drop any page_content rows that
    become orphaned as a result.

What this script does NOT do:
    - It does not touch rows across different captures. Same URL in
      two captures stays as two pages rows (revisits are real data).
    - It does not change the normalized_url unique constraint on
      page_content — Plan 04 already enforced that. The extra
      page_content rows this script deletes are the *distinct-but-
      semantically-equivalent* ones (different normalized URLs that
      happen to share host+path and were visited within 5 seconds).

Dry-run by default. Pass ``--execute`` to mutate. Every action logged
to ``scripts/_archive/diagnostics/dedup_cleanup_pages_log_{ts}.jsonl``.

Usage::

    uv run python scripts/_archive/diagnostics/dedup_cleanup_pages.py
    uv run python scripts/_archive/diagnostics/dedup_cleanup_pages.py --execute
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from backend.db.connection import get_conn
from backend.db.page_repo import (
    _DEDUP_WINDOW,
    _SPA_MUTATION_WINDOW_SECONDS,
    _host_path_key,
)
from backend.utils.url_normalize import normalize_url

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("dedup_cleanup_pages")


_log_file: Path | None = None


def _open_log() -> Path:
    global _log_file
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    _log_file = Path(__file__).parent / f"dedup_cleanup_pages_log_{ts}.jsonl"
    log.info(f"Logging actions to {_log_file}")
    return _log_file


def _emit(action: str, **fields) -> None:
    if _log_file is None:
        return
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "action": action, **fields}
    with _log_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


# ─── Core: identify mergeable groups ────────────────────────────────────────


def _identify_merges() -> list[dict]:
    """Scan all pages and return the list of merge operations to perform.

    Each merge is a dict with:
      - capture_id
      - canonical: dict (the pages row we keep)
      - losers:    list of dicts (the pages rows to delete)
      - summed_dwell: int (the dwell_time to set on canonical)
      - reason:    'normalized_url' | 'host_path_5s'
    """
    log.info("Scanning pages table for mergeable near-duplicates...")

    with get_conn() as conn:
        with conn.cursor() as cur:
            # Pull every non-archived-by-merge pages row with the fields
            # we need for the dedup rules.
            cur.execute(
                """
                SELECT id, capture_id, page_content_id, url, normalized_url,
                       visited_at, dwell_time_seconds, extracted_text
                FROM pages
                ORDER BY capture_id, visited_at ASC NULLS LAST, id
                """
            )
            rows = cur.fetchall()

    log.info(f"  Total pages rows: {len(rows)}")

    # Group by capture_id
    by_capture: dict[int, list[dict]] = defaultdict(list)
    for r in rows:
        (pid, cap_id, pc_id, url, stored_norm, visited, dwell, ext_text) = r
        norm = stored_norm or normalize_url(url or "")
        host_path = _host_path_key(url or "")
        by_capture[cap_id].append(
            {
                "id": pid,
                "capture_id": cap_id,
                "page_content_id": pc_id,
                "url": url,
                "normalized_url": norm,
                "host_path": host_path,
                "visited_at": visited,
                "dwell_time_seconds": dwell or 0,
                "extracted_text": ext_text or "",
            }
        )

    merges: list[dict] = []

    for cap_id, pages in by_capture.items():
        # Track which positions have already been absorbed into a canonical
        # so we don't merge them again when we encounter the next dup.
        # Each entry is a list: [canonical_dict, losers_list_dict, reason]
        # Index is the position in `pages` where the canonical lives.
        active: dict[int, dict] = {}  # canonical_position -> merge dict

        for i, page in enumerate(pages):
            # Is this page already absorbed into an earlier merge?
            absorbed_into = None
            for j, merge in active.items():
                if any(l["id"] == page["id"] for l in merge["losers"]):
                    absorbed_into = j
                    break
            if absorbed_into is not None:
                continue

            # Look back over the last _DEDUP_WINDOW non-absorbed entries.
            # Because we process in order and absorb as we go, `active`
            # keeps the canonical position for any run we've already
            # started — new dup matches extend that run.
            match = None
            match_reason = None
            lo = max(0, i - _DEDUP_WINDOW)
            for j in range(i - 1, lo - 1, -1):
                prev = pages[j]
                # If prev was absorbed, skip to its canonical.
                if any(prev["id"] == l["id"] for merge in active.values() for l in merge["losers"]):
                    continue
                if prev["normalized_url"] == page["normalized_url"]:
                    match = prev
                    match_reason = "normalized_url"
                    break
                if (
                    prev["host_path"]
                    and page["host_path"]
                    and prev["host_path"] == page["host_path"]
                    and prev["visited_at"] is not None
                    and page["visited_at"] is not None
                ):
                    gap = abs((page["visited_at"] - prev["visited_at"]).total_seconds())
                    if gap <= _SPA_MUTATION_WINDOW_SECONDS:
                        match = prev
                        match_reason = "host_path_5s"
                        break

            if match is None:
                continue

            # Find (or create) the active merge for this canonical.
            canonical_pos = None
            for j in range(len(pages)):
                if pages[j]["id"] == match["id"]:
                    canonical_pos = j
                    break

            if canonical_pos is None:
                continue  # Should not happen; defensive

            if canonical_pos not in active:
                active[canonical_pos] = {
                    "capture_id": cap_id,
                    "canonical": match,
                    "losers": [],
                    "reason": match_reason,
                }
            active[canonical_pos]["losers"].append(page)

        # Emit completed merges for this capture.
        for merge in active.values():
            if merge["losers"]:
                summed_dwell = merge["canonical"]["dwell_time_seconds"] + sum(
                    l["dwell_time_seconds"] for l in merge["losers"]
                )
                # Pick the longest extracted_text across the run.
                longest_text = merge["canonical"]["extracted_text"]
                for l in merge["losers"]:
                    if len(l["extracted_text"]) > len(longest_text):
                        longest_text = l["extracted_text"]
                merge["summed_dwell"] = summed_dwell
                merge["longest_text"] = longest_text
                merges.append(merge)

    return merges


# ─── Execution ──────────────────────────────────────────────────────────────


def phase_1_report(merges: list[dict]) -> None:
    log.info("─" * 70)
    log.info("PHASE 1 — merge plan")
    log.info("─" * 70)
    log.info(f"  Capture-level merge groups: {len(merges)}")
    total_losers = sum(len(m["losers"]) for m in merges)
    log.info(f"  Total loser rows to delete:  {total_losers}")

    by_reason: dict[str, int] = defaultdict(int)
    for m in merges:
        by_reason[m["reason"]] += len(m["losers"])
    for reason, n in by_reason.items():
        log.info(f"    via {reason}: {n} rows")
    log.info("")

    if not merges:
        return

    # Sample
    log.info("  Sample merges:")
    for m in merges[:5]:
        canonical = m["canonical"]
        log.info(f"    cap={m['capture_id']}  reason={m['reason']}  keep id={canonical['id']}")
        log.info(f"      canonical url: {canonical['url'][:90]}")
        log.info(f"      canonical visited_at: {canonical['visited_at']}")
        log.info(f"      dwell: {canonical['dwell_time_seconds']} → {m['summed_dwell']}")
        for l in m["losers"]:
            log.info(f"      drop id={l['id']}  url: {l['url'][:90]}")
    if len(merges) > 5:
        log.info(f"    ... and {len(merges) - 5} more")
    log.info("")

    _emit(
        "phase_1_plan",
        merge_groups=len(merges),
        total_losers=total_losers,
        by_reason=dict(by_reason),
    )


def phase_2_execute(merges: list[dict]) -> dict:
    log.info("─" * 70)
    log.info("PHASE 2 — executing merges")
    log.info("─" * 70)

    if not merges:
        log.info("  Nothing to merge.")
        return {"pages_deleted": 0, "page_content_deleted": 0}

    pages_deleted = 0
    affected_pc_ids: set[int] = set()

    for m in merges:
        canonical = m["canonical"]
        loser_ids = [l["id"] for l in m["losers"]]
        loser_pc_ids = {l["page_content_id"] for l in m["losers"] if l["page_content_id"]}

        # Track which page_content rows may become orphaned.
        affected_pc_ids.update(loser_pc_ids)
        # Don't mark the canonical's own pc_id for orphan-delete — it's
        # still referenced by the canonical pages row.
        affected_pc_ids.discard(canonical["page_content_id"])

        with get_conn() as conn:
            with conn.cursor() as cur:
                # Update canonical's dwell + extracted_text
                cur.execute(
                    """
                    UPDATE pages SET
                        dwell_time_seconds = %s,
                        extracted_text = COALESCE(%s, extracted_text)
                    WHERE id = %s
                    """,
                    (m["summed_dwell"], m["longest_text"] or None, canonical["id"]),
                )
                # Delete loser pages rows
                cur.execute("DELETE FROM pages WHERE id = ANY(%s)", (loser_ids,))
                pages_deleted += cur.rowcount

        _emit(
            "phase_2_merge",
            capture_id=m["capture_id"],
            canonical_id=canonical["id"],
            loser_ids=loser_ids,
            loser_pc_ids=list(loser_pc_ids),
            reason=m["reason"],
            summed_dwell=m["summed_dwell"],
        )

    log.info(f"  Deleted {pages_deleted} loser pages rows")

    # Phase 2b: delete orphaned page_content rows. A row is orphaned if
    # no pages row references it anymore.
    if affected_pc_ids:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id FROM page_content
                    WHERE id = ANY(%s)
                      AND NOT EXISTS (
                          SELECT 1 FROM pages WHERE page_content_id = page_content.id
                      )
                    """,
                    (list(affected_pc_ids),),
                )
                orphan_ids = [r[0] for r in cur.fetchall()]

                if orphan_ids:
                    cur.execute(
                        "DELETE FROM page_content WHERE id = ANY(%s)",
                        (orphan_ids,),
                    )
                    pc_deleted = cur.rowcount
                else:
                    pc_deleted = 0

        log.info(f"  Deleted {pc_deleted} orphaned page_content rows")
        _emit("phase_2_orphan_cleanup", orphan_pc_ids=orphan_ids, deleted=pc_deleted)
    else:
        pc_deleted = 0

    return {"pages_deleted": pages_deleted, "page_content_deleted": pc_deleted}


def phase_3_verify() -> None:
    log.info("─" * 70)
    log.info("PHASE 3 — verification")
    log.info("─" * 70)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM pages")
            pages_count = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM page_content")
            pc_count = cur.fetchone()[0]
            cur.execute(
                """
                SELECT COUNT(*) FROM pages
                WHERE page_content_id NOT IN (SELECT id FROM page_content)
                """
            )
            orphan_fks = cur.fetchone()[0]

    log.info(f"  pages total:                    {pages_count}")
    log.info(f"  page_content total:             {pc_count}")
    log.info(f"  Orphan FKs (pages → missing pc): {orphan_fks}  (target: 0)")
    log.info("")

    _emit(
        "phase_3_verify",
        pages_count=pages_count,
        page_content_count=pc_count,
        orphan_fks=orphan_fks,
    )


# ─── CLI ────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually mutate the database. Default is dry-run.",
    )
    args = parser.parse_args()
    dry_run = not args.execute

    log.info("")
    log.info("╔" + "═" * 68 + "╗")
    log.info("║  Historical pages dedup — SPA param mutation cleanup              ║")
    log.info(
        "║  "
        + (
            "DRY-RUN mode (no writes)                                        "
            if dry_run
            else "EXECUTE mode (will mutate the database)                         "
        )
        + "║"
    )
    log.info("╚" + "═" * 68 + "╝")

    if args.execute:
        log.warning("")
        log.warning("  Execute mode deletes rows. Back up first:")
        log.warning("    bash scripts/backup_db.sh pre_pages_cleanup")
        log.warning("")

    _open_log()

    merges = _identify_merges()
    phase_1_report(merges)

    if dry_run:
        log.info("  [dry-run] skipping execution. Re-run with --execute to apply.")
    else:
        phase_2_execute(merges)
        phase_3_verify()

    log.info("")
    log.info(f"Full log: {_log_file}")
    log.info("")


if __name__ == "__main__":
    main()
