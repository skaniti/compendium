"""Phase 0 diagnostic: audit duplicate pages and page_content rows.

Answers the question the plan hinges on: are the duplicates we're seeing
(a) historical residue from a previous pipeline bug that has since been fixed,
or (b) ongoing leakage from a pipeline that is still producing dups?

The answer determines scope:
    - (a) historical only → one-off cleanup is sufficient, Phases 2-3 optional.
    - (b) ongoing → full plan applies.

This script is read-only. It never mutates the database.

Usage::

    uv run python scripts/_archive/diagnostics/dedup_audit.py
    uv run python scripts/_archive/diagnostics/dedup_audit.py --user-id 152
    uv run python scripts/_archive/diagnostics/dedup_audit.py --recent-days 14

What it reports:

    1. page_content dup groups under future-state normalization.
       For each group: count, domain, first/last fetched_at, sample raw URLs
       to show exactly what varied (tracking params, casing, trailing slash).

    2. pages table: near-consecutive same-URL visits within a single capture,
       bucketed by transition_type. Confirms/refutes the SPA-bouncing hypothesis.

    3. Historical vs recent bucketing: for each page_content dup group,
       was the most recent fetched_at before or after the cutoff?
       Tells us whether the pipeline is still leaking today.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Allow running as `uv run python scripts/_archive/diagnostics/dedup_audit.py`
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from backend.db.connection import get_conn
from backend.utils.url_normalize import normalize_url

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("dedup_audit")


def _is_rag_chunk_url(url: str) -> bool:
    """Rows created by the RAG indexer at backend/db/vector_store.py:71.

    The RAG pipeline needs to store multiple chunks per source URL, but
    page_content.url has a UNIQUE constraint. To work around it, the indexer
    appends ``#chunk-<hash>`` to the base URL (or uses ``chunk://<id>`` for
    truly synthetic content). These rows are NOT user-visited pages — they
    are retrieval chunks, and collapsing them via URL normalization would
    destroy the chunk → embedding mapping. They must be excluded from any
    user-facing dedup analysis.
    """
    if not url:
        return False
    return url.startswith("chunk://") or "#chunk-" in url


# ─── Section 1: page_content dup groups ─────────────────────────────────────


def audit_page_content_dups() -> dict:
    """Group page_content rows by normalized URL; return summary + top groups.

    page_content is not user-scoped (shared across users), so no RLS filter.
    Reports two parallel counts: "all rows" (which is contaminated by RAG
    chunks) and "user pages only" (the number that matters for this plan).
    """
    log.info("─" * 70)
    log.info("SECTION 1 — page_content dup groups (future-state normalization)")
    log.info("─" * 70)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, url, domain, fetched_at FROM page_content ORDER BY id")
            rows = cur.fetchall()

    # Separate RAG chunk rows from real user pages.
    rag_chunk_rows = [r for r in rows if _is_rag_chunk_url(r[1])]
    user_rows = [r for r in rows if not _is_rag_chunk_url(r[1])]

    # Group user rows only by normalized URL.
    groups: dict[str, list[tuple[int, str, str | None, datetime]]] = defaultdict(list)
    for row in user_rows:
        pc_id, url, domain, fetched_at = row
        norm = normalize_url(url)
        groups[norm].append((pc_id, url, domain, fetched_at))

    dup_groups = {k: v for k, v in groups.items() if len(v) > 1}
    dup_row_count = sum(len(v) for v in dup_groups.values())

    log.info(f"Total page_content rows:             {len(rows)}")
    log.info(f"  ├─ RAG chunk rows (excluded):      {len(rag_chunk_rows)}")
    log.info(f"  └─ User-visited page rows:         {len(user_rows)}")
    log.info(f"Distinct normalized user URLs:       {len(groups)}")
    log.info(f"User-facing dup group count:         {len(dup_groups)}")
    log.info(f"User-facing rows involved in dups:   {dup_row_count}")
    if dup_groups:
        log.info(f"Wasted rows (dup rows − groups):     {dup_row_count - len(dup_groups)}")
    log.info("")

    if not dup_groups:
        log.info("No user-facing page_content dup groups found.")
        return {
            "total_rows": len(rows),
            "user_rows": len(user_rows),
            "rag_chunk_rows": len(rag_chunk_rows),
            "distinct_normalized": len(groups),
            "dup_group_count": 0,
            "dup_rows": 0,
            "groups": [],
        }

    # Top 15 dup groups by count
    sorted_groups = sorted(dup_groups.items(), key=lambda kv: -len(kv[1]))
    log.info("Top dup groups by count:")
    log.info("")
    for norm, members in sorted_groups[:15]:
        count = len(members)
        domains = Counter(m[2] for m in members if m[2])
        domain_label = ", ".join(f"{d}×{c}" for d, c in domains.most_common(3))
        first = min(m[3] for m in members if m[3] is not None)
        last = max(m[3] for m in members if m[3] is not None)
        log.info(f"  [{count}×] {norm}")
        log.info(f"          domain: {domain_label}")
        log.info(f"          first:  {first.isoformat()}")
        log.info(f"          last:   {last.isoformat()}")
        # Show what varied in the raw URLs
        unique_raw = sorted({m[1] for m in members})
        for raw in unique_raw[:3]:
            log.info(f"          raw:    {raw}")
        if len(unique_raw) > 3:
            log.info(f"          raw:    … and {len(unique_raw) - 3} more")
        log.info("")

    return {
        "total_rows": len(rows),
        "user_rows": len(user_rows),
        "rag_chunk_rows": len(rag_chunk_rows),
        "distinct_normalized": len(groups),
        "dup_group_count": len(dup_groups),
        "dup_rows": dup_row_count,
        "groups": sorted_groups,  # full list for section 3
    }


# ─── Section 2: pages within-capture near-consecutive dups ──────────────────


def audit_pages_within_capture_dups(user_id: int | None) -> None:
    """Find page rows where the same normalized URL appears within N positions
    inside the same capture, and bucket them by transition_type.

    Near-consecutive means: within the last 10 pages of the capture relative to
    an earlier visit. This mirrors the extension's (proposed) last-10 dedup
    window — the threshold the fix is meant to enforce.
    """
    log.info("─" * 70)
    log.info("SECTION 2 — pages: near-consecutive same-URL within a capture")
    log.info("─" * 70)

    user_filter = ""
    params: tuple = ()
    if user_id is not None:
        user_filter = "WHERE c.user_id = %s"
        params = (user_id,)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT p.id, p.capture_id, p.url, p.transition_type, p.visited_at
                FROM pages p
                JOIN captures c ON c.id = p.capture_id
                {user_filter}
                ORDER BY p.capture_id, p.visited_at
                """,
                params,
            )
            rows = cur.fetchall()

    # Group by capture_id preserving in-capture order (already sorted by visited_at)
    captures_pages: dict[int, list[tuple]] = defaultdict(list)
    for r in rows:
        pid, cap_id, url, ttype, visited_at = r
        captures_pages[cap_id].append((pid, url, ttype, visited_at))

    WINDOW = 10
    transition_hits: Counter = Counter()
    total_dups = 0
    captures_with_dups = 0
    recent_offenders_by_transition: dict[str, list[tuple]] = defaultdict(list)

    for cap_id, pages in captures_pages.items():
        norms = [normalize_url(p[1]) for p in pages]
        capture_had_dup = False
        for i, norm in enumerate(norms):
            # Was this URL seen in the previous WINDOW positions?
            lo = max(0, i - WINDOW)
            for j in range(lo, i):
                if norms[j] == norm:
                    ttype = pages[i][2] or "(none)"
                    transition_hits[ttype] += 1
                    total_dups += 1
                    if len(recent_offenders_by_transition[ttype]) < 3:
                        recent_offenders_by_transition[ttype].append((cap_id, pages[i][3], norm))
                    capture_had_dup = True
                    break  # count each dup once per position
        if capture_had_dup:
            captures_with_dups += 1

    scope = f"user_id={user_id}" if user_id is not None else "ALL users"
    log.info(f"Scope: {scope}")
    log.info(f"Captures scanned:             {len(captures_pages)}")
    log.info(f"Captures containing a dup:    {captures_with_dups}")
    log.info(f"Total within-capture dups:    {total_dups}")
    log.info(f"(dedup window = last {WINDOW} pages)")
    log.info("")

    if not transition_hits:
        log.info("No within-capture dups found.")
        return

    log.info("Dups by transition_type:")
    for ttype, count in transition_hits.most_common():
        log.info(f"  {ttype:<25} {count:>6}")
    log.info("")

    log.info("Sample offenders:")
    for ttype, samples in recent_offenders_by_transition.items():
        log.info(f"  {ttype}:")
        for cap_id, visited_at, norm in samples:
            when = visited_at.isoformat() if visited_at else "(no ts)"
            log.info(f"    capture={cap_id}  at={when}  url={norm}")
    log.info("")


# ─── Section 3: historical vs recent bucketing ──────────────────────────────


def audit_historical_vs_recent(
    section1_result: dict,
    recent_days: int,
) -> None:
    """For each page_content dup group, classify by the most recent fetched_at.

    - historical: newest row in the group is older than the cutoff
    - recent: newest row in the group is within the cutoff window

    "Recent" groups are the smoking gun — the pipeline is still producing dups.
    "Historical" groups are residue from before any earlier fix landed.
    """
    log.info("─" * 70)
    log.info(f"SECTION 3 — historical vs recent dup groups (cutoff = {recent_days}d)")
    log.info("─" * 70)

    groups = section1_result["groups"]
    if not groups:
        log.info("No dup groups to classify.")
        return

    cutoff = datetime.now(timezone.utc) - timedelta(days=recent_days)

    historical_only = 0
    recent_only = 0  # newest ≥ cutoff AND oldest ≥ cutoff
    spanning = 0  # oldest < cutoff AND newest ≥ cutoff
    historical_rows = 0
    recent_rows = 0
    recent_samples: list[tuple[str, int, datetime]] = []

    for norm, members in groups:
        timestamps = [m[3] for m in members if m[3] is not None]
        if not timestamps:
            continue
        oldest = min(timestamps)
        newest = max(timestamps)
        n = len(members)

        if newest < cutoff:
            historical_only += 1
            historical_rows += n
        elif oldest >= cutoff:
            recent_only += 1
            recent_rows += n
            if len(recent_samples) < 10:
                recent_samples.append((norm, n, newest))
        else:
            spanning += 1
            historical_rows += n  # mostly old, but has recent addition
            if len(recent_samples) < 10:
                recent_samples.append((norm, n, newest))

    log.info(f"Historical-only groups (newest < {recent_days}d): {historical_only}")
    log.info(f"Recent-only groups     (all ≥ {recent_days}d):     {recent_only}")
    log.info(f"Spanning groups        (oldest old, newest recent): {spanning}")
    log.info("")

    if recent_only == 0 and spanning == 0:
        log.info(">>> VERDICT: Dups appear to be HISTORICAL RESIDUE only.")
        log.info(">>> The pipeline is no longer producing new dups (under future-state")
        log.info(">>> normalization). A one-off cleanup script is sufficient; Phases 2-3")
        log.info(">>> (extension widening + backend collapse) are still desirable for")
        log.info(">>> robustness but not urgent.")
    else:
        log.info(
            f">>> VERDICT: Pipeline is STILL LEAKING dups ({recent_only + spanning} groups with recent activity)."
        )
        log.info(">>> Full plan applies. Phases 2-3 are required.")
        log.info("")
        log.info("Recent offending groups (for targeted investigation):")
        for norm, n, newest in recent_samples:
            log.info(f"  [{n}×] newest={newest.isoformat()}  {norm}")
    log.info("")


# ─── CLI ───────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--user-id",
        type=int,
        default=None,
        help="Restrict pages/captures queries to a single user. "
        "Default: all users (page_content is always global).",
    )
    parser.add_argument(
        "--recent-days",
        type=int,
        default=7,
        help="How many days back counts as 'recent' for the historical/ongoing split.",
    )
    args = parser.parse_args()

    log.info("")
    log.info("╔" + "═" * 68 + "╗")
    log.info("║  DEDUP AUDIT — Phase 0 diagnostic                                  ║")
    log.info("║  Read-only; safe to run any time.                                  ║")
    log.info("╚" + "═" * 68 + "╝")
    log.info("")

    section1 = audit_page_content_dups()
    audit_pages_within_capture_dups(args.user_id)
    audit_historical_vs_recent(section1, args.recent_days)


if __name__ == "__main__":
    main()
