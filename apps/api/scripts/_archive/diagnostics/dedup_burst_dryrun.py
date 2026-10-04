"""Burst-based dedup: collapse rapid same-host visits within captures.

Detects chains of consecutive page visits to the same host where
visited_at deltas are small enough to indicate one continuous user
action (e.g., panning Google Maps, DuckDuckGo SPA URL rewrites).

Two rules, applied per consecutive pair:

    Rule 3a (global, 3s):  same host, delta <= 3 seconds, any status.
        Catches rapid SPA self-rewrites regardless of domain. Very
        tight window — legitimate cross-page clicks almost never
        happen faster than 3 seconds.

    Rule 3b (skip, 30s):  same host, delta <= 30 seconds,
        BOTH pages have status='archived'. Catches longer panning/
        scrolling sessions on skip-listed domains. Safe because
        archived pages don't contribute to clustering — these rows
        are just storage bloat.

Output: an Excel file at scripts/_archive/diagnostics/burst_dryrun_{ts}.xlsx
showing every chain, which pages would be kept/deleted, which rule
matched, and the recomputed dwell times.

Usage::

    uv run python scripts/_archive/diagnostics/dedup_burst_dryrun.py
    uv run python scripts/_archive/diagnostics/dedup_burst_dryrun.py --execute
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from backend.db.connection import get_conn

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("burst_dedup")

RULE_3A_WINDOW_S = 3
RULE_3B_WINDOW_S = 30


def _host(url: str) -> str:
    try:
        return urlsplit(url).netloc.lower()
    except Exception:
        return ""


def _detect_chains() -> list[list[dict]]:
    """Walk every capture's pages and detect burst chains."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, capture_id, page_content_id, url, title,
                       visited_at, dwell_time_seconds, status, archive_reason,
                       transition_type
                FROM pages
                ORDER BY capture_id, visited_at ASC NULLS LAST, id
                """
            )
            rows = cur.fetchall()

    from collections import defaultdict

    by_capture: dict[int, list[dict]] = defaultdict(list)
    for r in rows:
        by_capture[r[1]].append(
            {
                "id": r[0],
                "capture_id": r[1],
                "page_content_id": r[2],
                "url": r[3],
                "title": (r[4] or "")[:80],
                "visited_at": r[5],
                "dwell_time_seconds": r[6] or 0,
                "status": r[7],
                "archive_reason": r[8],
                "transition_type": r[9],
                "host": _host(r[3] or ""),
            }
        )

    all_chains: list[list[dict]] = []

    for cap_id, pages in by_capture.items():
        if len(pages) < 2:
            continue

        chain: list[dict] = [pages[0]]
        chain[0]["rule"] = None  # canonical — no rule

        for page in pages[1:]:
            prev = chain[-1]
            same_host = page["host"] and prev["host"] and page["host"] == prev["host"]

            rule = None
            delta = 0.0
            is_spa = page.get("transition_type") == "spa_navigation"
            if same_host and is_spa and prev["visited_at"] and page["visited_at"]:
                delta = (page["visited_at"] - prev["visited_at"]).total_seconds()
                if 0 <= delta <= RULE_3A_WINDOW_S:
                    rule = "3a_spa_3s"
                elif (
                    0 <= delta <= RULE_3B_WINDOW_S
                    and prev["status"] == "archived"
                    and page["status"] == "archived"
                ):
                    rule = "3b_spa_skip_30s"

            if rule:
                page["rule"] = rule
                page["delta_from_prev"] = round(delta, 3)
                chain.append(page)
            else:
                if len(chain) > 1:
                    all_chains.append(chain)
                chain = [page]
                chain[0]["rule"] = None
                chain[0].pop("delta_from_prev", None)

        if len(chain) > 1:
            all_chains.append(chain)

    return all_chains


def _build_excel_rows(chains: list[list[dict]]) -> list[dict]:
    """Flatten chains into one Excel row per page, with computed dwells.

    The ``batch_id`` column is a human-readable identifier for each chain
    built from ``{capture_id}-{host}-{chain_seq}``. Every row in a batch
    represents what the system considers "the same logical page" — the
    canonical (KEEP) and the losers (DELETE) that will merge into it.
    """
    excel_rows: list[dict] = []

    # Track per-capture + per-host sequence numbers so batch IDs are
    # unique and informative: "cap458-google.com-1", "cap458-google.com-2".
    host_seq: dict[tuple[int, str], int] = {}

    for chain in chains:
        canonical = chain[0]
        last = chain[-1]
        cap = canonical["capture_id"]
        host = canonical["host"] or "unknown"

        # Build a readable batch_id
        key = (cap, host)
        seq = host_seq.get(key, 0) + 1
        host_seq[key] = seq
        # Shorten the host for readability (drop www.)
        short_host = host.replace("www.", "")
        batch_id = f"cap{cap}-{short_host}-{seq}"

        # Recomputed dwell: total duration from first to last + last's own dwell
        first_ts = canonical["visited_at"]
        last_ts = last["visited_at"]
        if first_ts and last_ts:
            total_dwell = round((last_ts - first_ts).total_seconds()) + last["dwell_time_seconds"]
        else:
            total_dwell = sum(p["dwell_time_seconds"] for p in chain)

        for i, page in enumerate(chain):
            role = "KEEP" if i == 0 else "ARCHIVE"
            excel_rows.append(
                {
                    "batch_id": batch_id,
                    "role": role,
                    "rule": page.get("rule") or "",
                    "capture_id": page["capture_id"],
                    "pages_id": page["id"],
                    "page_content_id": page["page_content_id"],
                    "host": page["host"],
                    "title": page["title"],
                    "url": (page["url"] or "")[:200],
                    "visited_at": str(page["visited_at"]) if page["visited_at"] else "",
                    "delta_s": page.get("delta_from_prev", ""),
                    "dwell_before": page["dwell_time_seconds"],
                    "dwell_after": total_dwell if i == 0 else "(deleted)",
                    "status": page["status"],
                    "archive_reason": page["archive_reason"] or "",
                    "transition_type": page["transition_type"] or "",
                }
            )
    return excel_rows


def _write_excel(excel_rows: list[dict], output_path: Path) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    wb = Workbook()

    # Sheet 1: all rows
    ws = wb.active
    ws.title = "Burst Chains"

    headers = list(excel_rows[0].keys()) if excel_rows else []
    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.font = Font(bold=True)

    archive_fill = PatternFill(start_color="FFCCCC", end_color="FFCCCC", fill_type="solid")
    keep_fill = PatternFill(start_color="CCFFCC", end_color="CCFFCC", fill_type="solid")

    for row_idx, row_data in enumerate(excel_rows, 2):
        fill = archive_fill if row_data["role"] == "ARCHIVE" else keep_fill
        for col, h in enumerate(headers, 1):
            cell = ws.cell(row=row_idx, column=col, value=row_data[h])
            cell.fill = fill

    # Auto-width
    for col in range(1, len(headers) + 1):
        max_len = max(
            len(str(ws.cell(row=r, column=col).value or ""))
            for r in range(1, min(len(excel_rows) + 2, 50))
        )
        ws.column_dimensions[ws.cell(row=1, column=col).column_letter].width = min(max_len + 2, 60)

    # Sheet 2: summary
    ws2 = wb.create_sheet("Summary")
    summary_data = {}
    total_delete = 0
    batch_ids_seen = set()
    for r in excel_rows:
        if r["role"] == "DELETE":
            rule = r["rule"]
            summary_data[rule] = summary_data.get(rule, 0) + 1
            total_delete += 1
        batch_ids_seen.add(r["batch_id"])

    ws2.cell(row=1, column=1, value="Metric").font = Font(bold=True)
    ws2.cell(row=1, column=2, value="Value").font = Font(bold=True)
    ws2.cell(row=2, column=1, value="Total batches (logical pages)")
    ws2.cell(row=2, column=2, value=len(batch_ids_seen))
    ws2.cell(row=3, column=1, value="Total rows to ARCHIVE")
    ws2.cell(row=3, column=2, value=total_delete)
    row = 4
    for rule, count in sorted(summary_data.items()):
        ws2.cell(row=row, column=1, value=f"  via {rule}")
        ws2.cell(row=row, column=2, value=count)
        row += 1
    ws2.cell(row=row, column=1, value="Total rows to KEEP (canonicals)")
    ws2.cell(row=row, column=2, value=len(batch_ids_seen))

    wb.save(str(output_path))
    log.info(f"  Excel written to: {output_path}")


def _execute_merges(chains: list[list[dict]]) -> dict:
    """Archive the losers (soft-delete) and update canonical dwells.

    Prior to 2026-04-06 this function hard-deleted loser rows. Changed to
    archive semantics (UPDATE status='archived', archive_reason='dedup')
    so all data is recoverable during the pipeline tuning phase. No
    page_content rows are orphaned or deleted because the pages rows
    still exist — they're just archived.
    """
    pages_archived = 0

    for chain in chains:
        canonical = chain[0]
        losers = chain[1:]
        loser_ids = [l["id"] for l in losers]

        # Compute dwell from timestamps
        first_ts = canonical["visited_at"]
        last = losers[-1] if losers else canonical
        last_ts = last["visited_at"]
        if first_ts and last_ts:
            total_dwell = round((last_ts - first_ts).total_seconds()) + last["dwell_time_seconds"]
        else:
            total_dwell = sum(p["dwell_time_seconds"] for p in chain)

        with get_conn() as conn:
            with conn.cursor() as cur:
                # Update canonical's dwell
                cur.execute(
                    "UPDATE pages SET dwell_time_seconds = %s WHERE id = %s",
                    (total_dwell, canonical["id"]),
                )
                # Archive losers instead of deleting
                cur.execute(
                    """
                    UPDATE pages SET status = 'archived', archive_reason = 'dedup'
                    WHERE id = ANY(%s) AND status != 'archived'
                    """,
                    (loser_ids,),
                )
                pages_archived += cur.rowcount

    return {"pages_archived": pages_archived}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually delete rows. Default: dry-run + Excel only.",
    )
    args = parser.parse_args()

    log.info("")
    log.info("╔" + "═" * 68 + "╗")
    log.info("║  Burst dedup — same-host rapid-visit chain detection              ║")
    log.info("║  Rule 3a: any domain, same host, <= 3s                            ║")
    log.info("║  Rule 3b: archived only, same host, <= 30s                        ║")
    log.info("╚" + "═" * 68 + "╝")
    log.info("")

    chains = _detect_chains()
    total_losers = sum(len(c) - 1 for c in chains)

    log.info(f"  Chains found:       {len(chains)}")
    log.info(f"  Rows to ARCHIVE:    {total_losers}")
    log.info(f"  Rows to KEEP:       {len(chains)} (one canonical per chain)")
    log.info("")

    # Build and write Excel
    excel_rows = _build_excel_rows(chains)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_path = Path(__file__).parent / f"burst_dryrun_{ts}.xlsx"
    _write_excel(excel_rows, output_path)

    if not args.execute:
        log.info("")
        log.info("  DRY-RUN complete. Review the Excel, then re-run with --execute.")
        return

    log.info("")
    log.info("  EXECUTING merges (archive, not delete)...")
    result = _execute_merges(chains)
    log.info(f"  Pages archived:         {result['pages_archived']}")

    # Verify
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM pages WHERE status = 'active'")
            log.info(f"  Active pages:           {cur.fetchone()[0]}")
            cur.execute("SELECT COUNT(*) FROM pages WHERE archive_reason = 'dedup'")
            log.info(f"  Dedup-archived pages:   {cur.fetchone()[0]}")
            cur.execute("SELECT COUNT(*) FROM pages")
            log.info(f"  Total pages:            {cur.fetchone()[0]}")
    log.info("")


if __name__ == "__main__":
    main()
