"""Repository for the pages table.

Ports time-window query patterns from the SQLite-based PageStore,
converting strftime() → to_char() for PostgreSQL.
"""

import json
import logging
import re
from collections import Counter
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from backend.db.connection import get_conn
from backend.utils.url_normalize import normalize_url

logger = logging.getLogger(__name__)


# Keep in sync with extension/modules/tracker-core.js::DEDUP_WINDOW and
# SPA_MUTATION_WINDOW_MS. The extension and the backend should catch
# the same class of dup; the backend is the authoritative safety net
# for anything the extension missed (older extensions still deployed,
# bugs, edge cases).
_DEDUP_WINDOW = 10
_SPA_MUTATION_WINDOW_SECONDS = 5


def _slugify(text: str) -> str:
    """Convert text to a URL-safe slug (mirrors graph_builder._slugify)."""
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _host_path_key(url: str) -> str:
    """Return the ``host + path`` portion of a URL for SPA-mutation dedup.

    Used alongside normalized_url comparison: if the normalized URLs
    differ but the host+path matches AND the visits happened within
    ``_SPA_MUTATION_WINDOW_SECONDS`` of each other, the helper treats
    them as duplicates (same logical page, different query params
    produced by the page's own JavaScript via pushState/replaceState).
    """
    if not url:
        return ""
    try:
        parts = urlsplit(url)
        return f"{parts.netloc.lower()}{parts.path}"
    except Exception:
        return ""


def _visited_at_seconds(page: dict) -> float | None:
    """Extract a comparable timestamp from a page dict.

    ``visited_at`` is typically a ``datetime`` object on the path from
    the API endpoints, but can be an ISO string on other code paths
    (notebook tooling, historical imports). Returns None if neither
    form is usable.
    """
    v = page.get("visited_at")
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.timestamp()
    if isinstance(v, str):
        try:
            from dateutil.parser import isoparse

            return isoparse(v).timestamp()
        except Exception:
            return None
    return None


def _collapse_consecutive_duplicates(pages: list[dict]) -> list[dict]:
    """Collapse near-consecutive same-page visits within a capture.

    Applies two rules in sequence. Both rules search the last
    ``_DEDUP_WINDOW`` entries of the result list, so the runtime is
    O(n · window), trivial at capture sizes.

    RULE 1 — Exact normalized URL match. Catches SPA bouncing between
    previously-visited URLs, tab cycling, fragment-routed app state
    (Gmail, ChatGPT, Wikipedia image viewer), and tracking-param drift.
    The URL normalizer strips fragments, tracking params, and sorts
    query params, so surface variations collapse.

    RULE 2 — Same host+path within ``_SPA_MUTATION_WINDOW_SECONDS``.
    Catches the harder case where a page's JavaScript mutates its own
    URL via pushState/replaceState, producing a chain of visits with
    genuinely different normalized URLs that all represent the same
    logical page. Example: DuckDuckGo search
    (``?q=X&we_feature_name=...`` → ``?q=X`` → ``?q=X&ia=web``) within
    1 second of each other — the normalized URLs differ because the
    mutated params aren't in the tracking list, but the host+path is
    identical and the time gap proves it's JS self-rewrite.

    Preservation rules for the surviving row:
      - ``visited_at``: earliest (the canonical row's original value)
      - ``dwell_time_seconds``: sum across the collapsed run
      - ``extracted_text``: longest non-null across the run
      - ``transition_type``: the canonical row's (ignored on the loser)
      - ``normalized_url``: stamped on every row for fast downstream queries

    This is the backend's safety net for duplicates the extension missed.
    Both rules mirror the extension-side rules in
    ``extension/modules/tracker-core.js::recordPageVisit`` — the
    extension is the primary layer, the backend covers older extension
    versions and the ``/api/passive-captures`` path.

    Returns a new list — does not mutate the input beyond stamping
    ``normalized_url`` and ``_host_path`` for reuse downstream.
    """
    if not pages:
        return []

    # Pre-compute derived keys once per page.
    for p in pages:
        if "normalized_url" not in p:
            p["normalized_url"] = normalize_url(p.get("url", "") or "")
        if "_host_path" not in p:
            p["_host_path"] = _host_path_key(p.get("url", "") or "")

    result: list[dict] = []
    for page in pages:
        norm = page["normalized_url"]
        host_path = page["_host_path"]
        incoming_ts = _visited_at_seconds(page)

        match_idx = None
        match_reason = None

        # Scan the last N entries of the result list for either rule.
        for i in range(len(result) - 1, max(-1, len(result) - 1 - _DEDUP_WINDOW), -1):
            prev = result[i]

            # RULE 1: exact normalized URL match
            if prev["normalized_url"] == norm:
                match_idx = i
                match_reason = "normalized_url"
                break

            # RULE 2: same host+path within the SPA mutation window
            if host_path and prev["_host_path"] == host_path and incoming_ts is not None:
                prev_ts = _visited_at_seconds(prev)
                if (
                    prev_ts is not None
                    and abs(incoming_ts - prev_ts) <= _SPA_MUTATION_WINDOW_SECONDS
                ):
                    match_idx = i
                    match_reason = "host_path_5s"
                    break

        if match_idx is None:
            result.append(page)
            continue

        # Merge the current page into the earlier canonical.
        canonical = result[match_idx]
        incoming_dwell = page.get("dwell_time_seconds") or 0
        canonical_dwell = canonical.get("dwell_time_seconds") or 0
        canonical["dwell_time_seconds"] = canonical_dwell + incoming_dwell

        inc_text = page.get("extracted_text") or ""
        can_text = canonical.get("extracted_text") or ""
        if len(inc_text) > len(can_text):
            canonical["extracted_text"] = inc_text

        logger.debug(
            f"collapse: merged dup visit ({match_reason}) at position {match_idx} "
            f"for host_path={host_path[:80]}"
        )

    if len(result) < len(pages):
        logger.info(
            f"_collapse_consecutive_duplicates: {len(pages)} → {len(result)} pages "
            f"({len(pages) - len(result)} collapsed)"
        )

    # Clean the internal helper field before returning so callers don't
    # see it (insert_pages would not expect it in the INSERT values).
    for p in result:
        p.pop("_host_path", None)

    return result


# ── Write ───────────────────────────────────────────────────────────────


def insert_pages(capture_db_id: int, pages: list[dict]) -> list[int]:
    """Bulk-insert pages for a capture. Returns list of new page IDs.

    Each dict in *pages* should have keys matching the pages table columns:
    url, title, domain, dwell_time_seconds, visited_at, transition_type,
    transition_qualifiers, is_tracked_domain, extracted_text.

    Applies ``_collapse_consecutive_duplicates`` before inserting so the
    backend is a safety net for dups the extension missed. The
    denormalized user_id is auto-populated from the capture row for RLS.

    Note: the returned id list may be shorter than the input list if
    collapsing occurred — this is by design. Callers must not assume
    one-id-per-input-page.
    """
    if not pages:
        return []

    pages = _collapse_consecutive_duplicates(pages)
    if not pages:
        return []

    ids: list[int] = []
    with get_conn() as conn:
        with conn.cursor() as cur:
            # Look up user_id from the capture for RLS denormalization
            cur.execute("SELECT user_id FROM captures WHERE id = %s", (capture_db_id,))
            row = cur.fetchone()
            user_id = row[0] if row else None

            for p in pages:
                # _collapse_consecutive_duplicates stamps normalized_url,
                # but defend against direct callers that bypass it.
                norm = p.get("normalized_url") or normalize_url(p.get("url", "") or "")
                # NOTE: pages.extracted_text is denormalized from
                # page_content.extracted_text. It's copied here at insert
                # time, but page_content may be backfilled later (Plan 01's
                # "keep richer" logic), making the pages copy stale. Hot-
                # path queries (get_active_pages) LEFT JOIN page_content
                # and prefer the canonical value. This column is kept for
                # backward compat and as a fallback — do NOT rely on it as
                # source of truth. Same applies to pages.content_summary.
                # Removal deferred to a future session (requires auditing
                # all readers). See 2026-04-06 schema audit.
                cur.execute(
                    """
                    INSERT INTO pages
                        (capture_id, user_id, url, normalized_url, title, domain,
                         dwell_time_seconds, visited_at, transition_type,
                         transition_qualifiers, is_tracked_domain,
                         extracted_text, status)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')
                    RETURNING id
                    """,
                    (
                        capture_db_id,
                        user_id,
                        p.get("url"),
                        norm,
                        p.get("title"),
                        p.get("domain"),
                        p.get("dwell_time_seconds"),
                        p.get("visited_at"),
                        p.get("transition_type"),
                        json.dumps(p["transition_qualifiers"])
                        if p.get("transition_qualifiers")
                        else None,
                        p.get("is_tracked_domain", True),
                        p.get("extracted_text"),
                    ),
                )
                ids.append(cur.fetchone()[0])
    return ids


def update_page_status(
    page_id: int,
    status: str,
    *,
    archive_reason: str | None = None,
    skip_reasoning: str | None = None,
    processing_depth: str | None = None,
    processing_metadata: dict | None = None,
    content_summary: str | None = None,
    page_content_id: int | None = None,
) -> None:
    """Update a page's processing status and related fields."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE pages SET
                    status = %s,
                    archive_reason = %s,
                    skip_reasoning = %s,
                    processing_depth = %s,
                    processing_metadata = %s,
                    content_summary = %s,
                    page_content_id = %s
                WHERE id = %s
                """,
                (
                    status,
                    archive_reason,
                    skip_reasoning,
                    processing_depth,
                    json.dumps(processing_metadata) if processing_metadata else None,
                    content_summary,
                    page_content_id,
                    page_id,
                ),
            )


def redact_page_extracted_text(page_id: int) -> None:
    """NULL a page's extracted_text (sensitive-skip retention carve-out).

    Companion to update_page_status for skip-gate rows whose content must not
    be retained; see backend/utils/skip_retention.py.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE pages SET extracted_text = NULL WHERE id = %s",
                (page_id,),
            )


def archive_page(page_id: int, reason: str) -> None:
    """Archive a page with the given reason."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE pages SET status = 'archived', archive_reason = %s WHERE id = %s",
                (reason, page_id),
            )


def restore_page(page_id: int) -> None:
    """Restore an archived page to active status."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE pages SET status = 'active', archive_reason = NULL WHERE id = %s",
                (page_id,),
            )


# ── Human overrides ────────────────────────────────────────────────────


def override_page_status(
    page_id: int,
    human_status: str | None,
    user_id: int,
    *,
    note: str | None = None,
) -> dict:
    """Set (or clear) a human override on a page's status.

    Pass human_status=None to clear the override (revert to LLM decision).
    Creates an audit annotation and returns the updated effective values.
    """
    from backend.db.annotation_repo import create_annotation

    with get_conn() as conn:
        with conn.cursor() as cur:
            # Read current values for the audit trail
            cur.execute(
                "SELECT status, human_status FROM pages WHERE id = %s",
                (page_id,),
            )
            row = cur.fetchone()
            if row is None:
                return {}
            old_effective = row[1] if row[1] is not None else row[0]

            cur.execute(
                "UPDATE pages SET human_status = %s WHERE id = %s",
                (human_status, page_id),
            )

    action = "override_status" if human_status is not None else "clear_override"
    create_annotation(
        user_id,
        "page",
        page_id,
        action,
        old_value=old_effective,
        new_value=human_status,
        note=note,
    )

    new_effective = human_status if human_status is not None else row[0]
    return {"page_id": page_id, "effective_status": new_effective}


def override_page_depth(
    page_id: int,
    human_processing_depth: str | None,
    user_id: int,
    *,
    note: str | None = None,
) -> dict:
    """Set (or clear) a human override on a page's processing depth.

    Creates an audit annotation and returns the updated effective values.
    """
    from backend.db.annotation_repo import create_annotation

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT processing_depth, human_processing_depth FROM pages WHERE id = %s",
                (page_id,),
            )
            row = cur.fetchone()
            if row is None:
                return {}
            old_effective = row[1] if row[1] is not None else row[0]

            cur.execute(
                "UPDATE pages SET human_processing_depth = %s WHERE id = %s",
                (human_processing_depth, page_id),
            )

    action = "override_depth" if human_processing_depth is not None else "clear_override"
    create_annotation(
        user_id,
        "page",
        page_id,
        action,
        old_value=old_effective,
        new_value=human_processing_depth,
        note=note,
    )

    new_effective = human_processing_depth if human_processing_depth is not None else row[0]
    return {"page_id": page_id, "effective_processing_depth": new_effective}


def flag_page_for_review(page_id: int, flagged: bool = True) -> None:
    """Toggle the review queue flag on a page."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE pages SET flagged_for_review = %s WHERE id = %s",
                (flagged, page_id),
            )


def get_flagged_pages(user_id: int) -> list[dict]:
    """Pages flagged for human review."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.url, p.title, p.domain, p.status, p.processing_depth,
                       p.skip_reasoning, p.human_status, p.human_processing_depth,
                       p.visited_at
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s AND p.flagged_for_review = TRUE
                ORDER BY p.visited_at DESC NULLS LAST
                """,
                (user_id,),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_pages_with_overrides(user_id: int) -> list[dict]:
    """All pages where a human override differs from the LLM decision."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.url, p.title, p.domain,
                       p.status, p.human_status,
                       p.processing_depth, p.human_processing_depth,
                       p.skip_reasoning, p.visited_at
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s
                  AND (p.human_status IS NOT NULL OR p.human_processing_depth IS NOT NULL)
                ORDER BY p.visited_at DESC NULLS LAST
                """,
                (user_id,),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def batch_override_by_domain(
    user_id: int,
    domain: str,
    human_status: str,
    *,
    note: str | None = None,
) -> int:
    """Override status for all pages matching a domain. Returns count affected."""
    from backend.db.annotation_repo import create_annotation

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE pages SET human_status = %s
                WHERE user_id = %s AND domain = %s
                RETURNING id
                """,
                (human_status, user_id, domain),
            )
            ids = [r[0] for r in cur.fetchall()]

    for pid in ids:
        create_annotation(
            user_id,
            "page",
            pid,
            "override_status",
            new_value=human_status,
            note=f"Batch override for domain={domain}" + (f": {note}" if note else ""),
        )

    return len(ids)


# ── Read ────────────────────────────────────────────────────────────────


def get_pages_for_capture(capture_db_id: int) -> list[dict]:
    """All pages for a capture, ordered by visited_at."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, url, title, domain, dwell_time_seconds, visited_at,
                       transition_type, transition_qualifiers, is_tracked_domain,
                       extracted_text, status, archive_reason, skip_reasoning,
                       processing_depth, processing_metadata, content_summary,
                       page_content_id, created_at
                FROM pages
                WHERE capture_id = %s
                ORDER BY visited_at ASC NULLS LAST
                """,
                (capture_db_id,),
            )
            return [_row_to_dict(r) for r in cur.fetchall()]


def get_active_pages(user_id: int) -> list[dict]:
    """All active pages for a user (across all captures), with page_content joined."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.url, p.title, p.domain, p.dwell_time_seconds,
                       p.visited_at, p.status, p.processing_depth, p.content_summary,
                       p.page_content_id, p.capture_id,
                       pc.extracted_text AS content_extracted_text,
                       pc.fetched_content, pc.content_summary AS content_level_summary,
                       pc.tool_selected,
                       c.capture_id AS capture_text_id,
                       pc.is_learning
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                LEFT JOIN page_content pc ON p.page_content_id = pc.id
                WHERE c.user_id = %s
                  AND COALESCE(p.human_status, p.status) = 'active'
                ORDER BY p.visited_at ASC NULLS LAST
                """,
                (user_id,),
            )
            rows = cur.fetchall()

    return [
        {
            "id": r[0],
            "url": r[1],
            "title": r[2],
            "domain": r[3],
            "dwell_time_seconds": r[4],
            "visited_at": r[5],
            "status": r[6],
            "processing_depth": r[7],
            "content_summary": r[8],
            "page_content_id": r[9],
            "capture_id": r[10],
            "content_extracted_text": r[11],
            "fetched_content": r[12],
            "content_level_summary": r[13],
            "tool_selected": r[14],
            "capture_text_id": r[15],
            "is_learning": r[16],
        }
        for r in rows
    ]


def get_visit_history(user_id: int, page_ids: list[int]) -> dict[int, list[dict]]:
    """Full visit history for the given pages' canonical URLs, keyed by member page.

    For each input page id, returns EVERY visit row (any capture, any time)
    sharing that page's ``page_content_id`` — cross-capture revisits are
    deliberately separate ``pages`` rows ("revisits are real data"), which is
    what makes temporal-recurrence interest evidence computable. Read-only;
    clustering-rethink increment 3 (interest scoring).

    Returns {input_page_id: [{"visit_id", "page_content_id", "visited_at",
    "dwell_seconds"}, ...]}. Input pages without a page_content_id or without
    timestamped visits map to an empty list. Visits are scoped to the user via
    the captures join.
    """
    if not page_ids:
        return {}

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                WITH members AS (
                    SELECT p.id AS member_id, p.page_content_id
                    FROM pages p
                    JOIN captures c ON p.capture_id = c.id
                    WHERE p.id = ANY(%s) AND c.user_id = %s
                      AND p.page_content_id IS NOT NULL
                )
                SELECT m.member_id, v.id, v.page_content_id, v.visited_at,
                       v.dwell_time_seconds
                FROM members m
                JOIN pages v ON v.page_content_id = m.page_content_id
                JOIN captures vc ON v.capture_id = vc.id
                WHERE vc.user_id = %s AND v.visited_at IS NOT NULL
                """,
                (page_ids, user_id, user_id),
            )
            rows = cur.fetchall()

    result: dict[int, list[dict]] = {pid: [] for pid in page_ids}
    for member_id, visit_id, content_id, visited_at, dwell in rows:
        result[member_id].append(
            {
                "visit_id": visit_id,
                "page_content_id": content_id,
                "visited_at": visited_at,
                "dwell_seconds": dwell,
            }
        )
    return result


def get_pending_captures(user_id: int) -> list[dict]:
    """Return captures that have pages still in 'pending' status."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT c.id, c.capture_id, c.source, c.started_at, c.ended_at,
                       c.is_trivial, c.title
                FROM captures c
                JOIN pages p ON p.capture_id = c.id
                WHERE c.user_id = %s AND p.status = 'pending'
                ORDER BY c.started_at ASC
                """,
                (user_id,),
            )
            return [
                {
                    "id": r[0],
                    "capture_id": r[1],
                    "source": r[2],
                    "started_at": r[3],
                    "ended_at": r[4],
                    "is_trivial": r[5],
                    "title": r[6],
                }
                for r in cur.fetchall()
            ]


# ── Pipeline monitor queries ──────────────────────────────────────────


def get_page_status_counts(user_id: int) -> dict[str, int]:
    """Count pages by status for a user."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.status, COUNT(*)
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s
                GROUP BY p.status
                """,
                (user_id,),
            )
            return dict(cur.fetchall())


def get_processing_depth_counts(user_id: int) -> dict[str, int]:
    """Count pages by processing_depth for a user."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COALESCE(p.processing_depth, 'null'), COUNT(*)
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s
                GROUP BY p.processing_depth
                """,
                (user_id,),
            )
            return dict(cur.fetchall())


def get_null_depth_breakdown(user_id: int) -> dict[str, int]:
    """Break down pages with NULL processing_depth by reason.

    Returns a dict like {"Pending": 42, "Trivial Capture": 15}.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    CASE
                        WHEN p.status = 'active' THEN 'legacy_active'
                        WHEN p.status = 'pending' THEN 'Pending'
                        WHEN p.archive_reason = 'trivial_capture' THEN 'Trivial Capture'
                        ELSE 'Other'
                    END AS reason,
                    COUNT(*)
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s AND p.processing_depth IS NULL
                GROUP BY reason
                """,
                (user_id,),
            )
            return dict(cur.fetchall())


def get_skip_reasoning_counts(user_id: int, limit: int = 15) -> list[tuple[str, int]]:
    """Top skip reasons for archived pages (truncated to first 80 chars)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT LEFT(COALESCE(p.skip_reasoning, '(none)'), 80) AS reason,
                       COUNT(*)
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s AND p.status = 'archived'
                GROUP BY reason
                ORDER BY COUNT(*) DESC
                LIMIT %s
                """,
                (user_id, limit),
            )
            return cur.fetchall()


def get_skip_method_counts(user_id: int) -> dict[str, int]:
    """Count archived pages by skip method (domain_skip vs skip_gate)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COALESCE(p.archive_reason, 'other') AS method,
                       COUNT(*)
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s AND p.status = 'archived'
                GROUP BY method
                ORDER BY COUNT(*) DESC
                """,
                (user_id,),
            )
            return dict(cur.fetchall())


def get_archive_health_summary(
    user_id: int, since: datetime | None = None
) -> dict[str, Any]:
    """Snapshot of archive-pipeline health.

    Returns counts by archive_reason with top-5 domains each, active vs
    archived totals, and per-capture archive rates. Backs the Archive Health
    dev view.

    When ``since`` is provided, every aggregate (totals, by-reason,
    per-capture) is windowed to captures whose ``started_at >= since``.
    The ``%s::timestamptz IS NULL`` guard lets us inline the same SQL for
    both the "all time" (None) and windowed cases.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            # Active vs archived totals.
            # "active_count" covers both 'pending' and 'active' — any page
            # that has not been archived yet is considered in-flight/active
            # for health-monitoring purposes.
            cur.execute(
                """
                SELECT
                    COUNT(*) FILTER (WHERE p.status <> 'archived') AS active_count,
                    COUNT(*) FILTER (WHERE p.status = 'archived') AS archived_count
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s
                  AND (%s::timestamptz IS NULL OR c.started_at >= %s::timestamptz)
                """,
                (user_id, since, since),
            )
            totals = cur.fetchone()

            # Counts by reason
            cur.execute(
                """
                SELECT archive_reason, COUNT(*) AS cnt
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s
                  AND p.status = 'archived'
                  AND p.archive_reason IS NOT NULL
                  AND (%s::timestamptz IS NULL OR c.started_at >= %s::timestamptz)
                GROUP BY archive_reason
                ORDER BY cnt DESC
                """,
                (user_id, since, since),
            )
            reason_rows = cur.fetchall()

            # Top 5 domains per reason (one query per reason — small N)
            by_reason = []
            for reason, count in reason_rows:
                cur.execute(
                    """
                    SELECT domain, COUNT(*) AS cnt
                    FROM pages p
                    JOIN captures c ON p.capture_id = c.id
                    WHERE c.user_id = %s
                      AND p.archive_reason = %s
                      AND (%s::timestamptz IS NULL OR c.started_at >= %s::timestamptz)
                    GROUP BY domain
                    ORDER BY cnt DESC
                    LIMIT 5
                    """,
                    (user_id, reason, since, since),
                )
                top_domains = [
                    {"domain": r[0] or "(null)", "count": r[1]} for r in cur.fetchall()
                ]
                by_reason.append(
                    {"reason": reason, "count": count, "top_domains": top_domains}
                )

            # Per-capture archive rate
            cur.execute(
                """
                SELECT
                    c.capture_id,
                    c.started_at,
                    COUNT(*) FILTER (WHERE p.status = 'archived') AS archived,
                    COUNT(*) AS total
                FROM captures c
                LEFT JOIN pages p ON p.capture_id = c.id
                WHERE c.user_id = %s
                  AND (%s::timestamptz IS NULL OR c.started_at >= %s::timestamptz)
                GROUP BY c.id, c.capture_id, c.started_at
                ORDER BY c.started_at ASC
                """,
                (user_id, since, since),
            )
            per_capture = [
                {
                    "capture_id": r[0],
                    "started_at": r[1].isoformat() if r[1] else None,
                    "archived": r[2],
                    "total": r[3],
                    "rate": (r[2] / r[3]) if r[3] else 0.0,
                }
                for r in cur.fetchall()
            ]

    return {
        "active_count": totals[0],
        "archived_count": totals[1],
        "by_reason": by_reason,
        "per_capture": per_capture,
    }


DEFAULT_VALIDATION_CONFIG = {
    "skip_gate": 10,
    "domain_skip": 5,
    "dedup": 5,
    "trivial_capture": 3,
    "manual_exclusion": 2,
}


def generate_validation_batch(
    user_id: int,
    config: dict[str, int] | None = None,
) -> list[dict]:
    """Sample archived pages stratified by archive_reason for human review.

    Skips pages already reviewed (annotations.action='validate_archive').
    Returns per-reason caps — requested size or available pool, whichever
    is smaller. Reasons in ``config`` that match no archived pages
    contribute nothing to the output (no error is raised), so typo'd
    reason keys in a custom config are silently ignored.
    """
    cfg = config or DEFAULT_VALIDATION_CONFIG
    out: list[dict] = []

    with get_conn() as conn:
        with conn.cursor() as cur:
            for reason, size in cfg.items():
                if size <= 0:
                    continue
                cur.execute(
                    """
                    SELECT p.id, p.url, p.title, p.domain, p.archive_reason,
                           p.skip_reasoning, p.processing_depth, p.visited_at,
                           p.page_content_id, p.normalized_url, p.dwell_time_seconds,
                           p.transition_type, p.capture_id,
                           pc.extracted_text,
                           COALESCE(LENGTH(pc.extracted_text), 0) AS content_length,
                           COALESCE(pc.raw_html_usable, FALSE) AS raw_html_usable
                    FROM pages p
                    JOIN captures c ON p.capture_id = c.id
                    LEFT JOIN page_content pc ON p.page_content_id = pc.id
                    WHERE c.user_id = %s
                      AND p.status = 'archived'
                      AND p.archive_reason = %s
                      AND p.id NOT IN (
                          SELECT entity_id FROM annotations
                          WHERE user_id = %s
                            AND entity_type = 'page'
                            AND action = 'validate_archive'
                      )
                    ORDER BY RANDOM()
                    LIMIT %s
                    """,
                    (user_id, reason, user_id, size),
                )
                cols = [d[0] for d in cur.description]
                for row in cur.fetchall():
                    rec = dict(zip(cols, row))
                    if rec.get("visited_at"):
                        rec["visited_at"] = rec["visited_at"].isoformat()
                    out.append(rec)

    return out


def get_dedup_pair(archived_page_id: int) -> dict | None:
    """Find the canonical page for a dedup-archived page.

    Returns ``{"archived": {...}, "canonical": {...}}`` if the archived
    page was soft-deleted by the dedup rule AND an active page with a
    matching ``page_content_id`` or ``normalized_url`` (within the same
    capture) exists.

    Returns ``None`` if the page is not dedup-archived or no canonical
    is found.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, url, title, domain, archive_reason, page_content_id,
                       normalized_url, capture_id, visited_at,
                       dwell_time_seconds, transition_type
                FROM pages
                WHERE id = %s
                """,
                (archived_page_id,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            cols = [d[0] for d in cur.description]
            archived = dict(zip(cols, row))

            if archived.get("archive_reason") != "dedup":
                return None

            # Prefer a canonical sharing page_content_id (strong match);
            # fall back to normalized_url within the same capture.
            canonical = None
            if archived.get("page_content_id") is not None:
                cur.execute(
                    """
                    SELECT id, url, title, domain, page_content_id,
                           normalized_url, capture_id, visited_at,
                           dwell_time_seconds, transition_type
                    FROM pages
                    WHERE page_content_id = %s
                      AND id != %s
                      AND status != 'archived'
                    ORDER BY visited_at ASC
                    LIMIT 1
                    """,
                    (archived["page_content_id"], archived_page_id),
                )
                r = cur.fetchone()
                if r is not None:
                    c_cols = [d[0] for d in cur.description]
                    canonical = dict(zip(c_cols, r))

            if canonical is None and archived.get("normalized_url"):
                cur.execute(
                    """
                    SELECT id, url, title, domain, page_content_id,
                           normalized_url, capture_id, visited_at,
                           dwell_time_seconds, transition_type
                    FROM pages
                    WHERE normalized_url = %s
                      AND capture_id = %s
                      AND id != %s
                      AND status != 'archived'
                    ORDER BY visited_at ASC
                    LIMIT 1
                    """,
                    (
                        archived["normalized_url"],
                        archived["capture_id"],
                        archived_page_id,
                    ),
                )
                r = cur.fetchone()
                if r is not None:
                    c_cols = [d[0] for d in cur.description]
                    canonical = dict(zip(c_cols, r))

    if canonical is None:
        return None

    for obj in (archived, canonical):
        if obj.get("visited_at"):
            obj["visited_at"] = obj["visited_at"].isoformat()

    return {"archived": archived, "canonical": canonical}


def get_recent_pages(
    user_id: int,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Paginated pages for a user, newest first.

    Returns (rows, total_count).
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s
                """,
                (user_id,),
            )
            total = cur.fetchone()[0]

            cur.execute(
                """
                SELECT p.id, p.title, p.domain, p.status, p.processing_depth,
                       p.archive_reason, p.skip_reasoning,
                       p.visited_at, p.created_at
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE c.user_id = %s
                ORDER BY p.created_at DESC
                LIMIT %s OFFSET %s
                """,
                (user_id, limit, offset),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()], total


def page_content_owned_by_user(page_content_id: int, user_id: int) -> bool:
    """Return True if some pages row links to page_content_id under user_id.

    ``render_archived_preview`` (backend/services/preview_renderer.py) is
    NOT itself user-scoped -- it will render any page_content row's
    archived HTML given a bare id. This is the ownership gate the
    ``GET /api/pages/{pid}/preview`` endpoint runs before calling it:
    ``pid`` (a page_content id) must be linked from a pages row whose
    capture belongs to user_id. Callers should treat a False result as a
    404, not a 403 -- returning 403 would confirm the row exists at all.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM pages p
                    JOIN captures c ON p.capture_id = c.id
                    WHERE p.page_content_id = %s AND c.user_id = %s
                )
                """,
                (page_content_id, user_id),
            )
            return bool(cur.fetchone()[0])


# ── Time-window queries (ported from PageStore) ────────────────────────


def get_time_windows(
    user_id: int,
    granularity: str = "day",
    filter_node_id: str | None = None,
) -> list[dict]:
    """Group active pages into time windows for the diary panel.

    Ported from PageStore.get_time_windows(), using PostgreSQL to_char()
    instead of SQLite strftime().

    TZ-DEBT: ``to_char(p.visited_at, ...)`` formats according to the DB
    session's timezone, which is UTC. This means a page captured at
    23:30 EDT on Apr 18 (= 03:30 UTC on Apr 19) gets bucketed into the
    Apr 19 window, even though the user perceives it as "yesterday".
    Fix requires either:
      1. ``SET TIMEZONE`` per-session from a user-TZ preference, OR
      2. ``to_char(p.visited_at AT TIME ZONE %s, ...)`` parameterized
         on user TZ (would need a TZ field on users + frontend detection
         of the browser's IANA TZ name like "America/New_York").
    See docs/project-plans/_shelved/2026-04-19-local-time-followup/followup.md

    ``filter_node_id`` id-vocabulary contract (2026-07-17, rethink R7.2
    fix): a page-dot tap on the D3 canvas sends the GRAPH node id, which
    for a page leaf is ``graph_builder._slugify(title)`` (see
    ``backend/services/graph_builder.py`` -- ``leaf_id = _slugify(title)``,
    identical to the ``_slugify`` defined at the top of this module). A
    cluster tap or a diary tag-pill click sends a ``cluster_slug``
    instead. The filter therefore has to match against THREE
    id-vocabularies a caller might send: the page's own numeric id (as
    text, for older/direct callers), its title slug (page-dot taps), or
    its cluster's slug (cluster taps / tag pills). The matching used to
    happen in the SQL WHERE clause and only covered ``p.id::text`` and
    ``cluster_slug`` -- the title-slug case (the majority of real taps,
    since page dots vastly outnumber cluster labels) was never compared
    against anything, so every page-dot click filtered to zero rows and
    the diary showed "No pages yet." regardless of which page was
    clicked. Filtering now happens AFTER aggregation, against the same
    three per-window id sets/maps this function already builds for the
    windows themselves (node_ids / graph_node_ids / cluster_freq keys),
    so the filter can never drift out of sync with what the diary
    actually renders as those ids.

    GRANULARITY CHANGE (deliberate, applies to ALL THREE vocabularies):
    the old SQL filter was ROW-level -- a window only surfaced the
    specific rows matching ``p.id::text`` / ``cluster_slug``, so a
    matched window rendered only its matching pages/tags. The
    post-aggregation filter is WINDOW-level: a window that contains at
    least one match is returned WHOLE, with all of its pages, tags, and
    counts intact. That is the semantics the single consumer actually
    documents -- ``render_session_diary`` (frontend/dash/layouts/
    session_diary.py): "filter_node_id: If set, only show windows
    containing this node" -- windows are the filter unit, not rows.
    This is pinned by the multi-page-window tests in
    tests/test_page_repo_time_windows.py; do not "fix" it back to
    row-level without revisiting that contract.
    """
    fmt = _to_char_fmt(granularity)

    # The page_clusters / clusters tables retain history across reclusters
    # (cleanup_old_runs uses archive semantics, not DELETE -- see
    # backend/db/recluster_repo.py:112), so a page that has been clustered
    # multiple times has multiple cluster_ids. Without scoping, the diary's
    # tag pills show fallback names like "Cluster 41" from prior runs whose
    # LLM naming pre-flight failed. Scope the JOIN to the LATEST completed
    # run only so each page contributes at most one current cluster slug.
    #
    # Always fetch unfiltered, then filter per-window in Python below --
    # a deliberate scale trade-off (fine at this app's low-thousands of
    # pages per user; revisit if that assumption breaks).
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT to_char(p.visited_at, '{fmt}') AS window_key,
                       p.id, p.title, p.domain, pc.cluster_slug, pc.cluster_name
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                LEFT JOIN (
                    SELECT pcl.page_id, cl.cluster_slug, cl.cluster_name
                    FROM page_clusters pcl
                    JOIN clusters cl ON pcl.cluster_id = cl.id
                    WHERE cl.recluster_run = (
                        SELECT id FROM recluster_runs
                        WHERE user_id = %s AND status = 'completed'
                        ORDER BY completed_at DESC LIMIT 1
                    )
                ) pc ON pc.page_id = p.id
                WHERE c.user_id = %s
                  AND COALESCE(p.human_status, p.status) = 'active'
                ORDER BY window_key DESC
                """,
                (user_id, user_id),
            )
            rows = cur.fetchall()

    # Aggregate into window dicts (same logic as old PageStore)
    windows: dict[str, dict] = {}
    for row in rows:
        wk = row[0]
        if wk is None:
            continue
        if wk not in windows:
            windows[wk] = {
                "key": wk,
                "label": _window_label(wk, granularity),
                "node_ids": set(),
                "graph_node_ids": set(),
                "cluster_freq": Counter(),
                "cluster_names": {},
                "page_count": 0,
            }
        w = windows[wk]
        w["node_ids"].add(str(row[1]))
        title = row[2]
        if title:
            w["graph_node_ids"].add(_slugify(title))
        if row[4]:  # cluster_slug
            w["cluster_freq"][row[4]] += 1
            w["cluster_names"][row[4]] = row[5]
        w["page_count"] += 1

    result = []
    for w in windows.values():
        # WINDOW-level filter (see the GRANULARITY CHANGE note in the
        # docstring): one match in any of the three id vocabularies keeps
        # the WHOLE window -- all pages/tags/counts -- per
        # render_session_diary's "only show windows containing this node"
        # contract. Non-matching windows are dropped entirely.
        if filter_node_id and not (
            filter_node_id in w["node_ids"]
            or filter_node_id in w["graph_node_ids"]
            or filter_node_id in w["cluster_freq"]
        ):
            continue
        w["node_ids"] = list(w["node_ids"])
        w["graph_node_ids"] = list(w["graph_node_ids"])
        result.append(w)
    result.sort(key=lambda w: w["key"], reverse=True)
    return result


# ── Helpers ─────────────────────────────────────────────────────────────


def _row_to_dict(row: tuple) -> dict:
    """Convert a pages query row to a dict."""
    return {
        "id": row[0],
        "url": row[1],
        "title": row[2],
        "domain": row[3],
        "dwell_time_seconds": row[4],
        "visited_at": row[5],
        "transition_type": row[6],
        "transition_qualifiers": row[7],
        "is_tracked_domain": row[8],
        "extracted_text": row[9],
        "status": row[10],
        "archive_reason": row[11],
        "skip_reasoning": row[12],
        "processing_depth": row[13],
        "processing_metadata": row[14],
        "content_summary": row[15],
        "page_content_id": row[16],
        "created_at": row[17],
    }


def _to_char_fmt(granularity: str) -> str:
    """PostgreSQL to_char() format for a time granularity."""
    if granularity == "week":
        return 'IYYY-"W"IW'
    if granularity == "month":
        return "YYYY-MM"
    return "YYYY-MM-DD"


def _window_label(key: str, granularity: str) -> str:
    """Human-readable label for a window key (same as old PageStore).

    TZ-DEBT: receives a window key (e.g. "2026-04-19") that was bucketed
    in UTC by ``get_time_windows()``. The label here just renders that
    key — fixing the bucket fixes this label automatically.
    """
    if granularity == "week":
        year, week = int(key[:4]), int(key.split("W")[1])
        monday = datetime.strptime(f"{year}-W{week:02d}-1", "%G-W%V-%u")
        sunday = monday + timedelta(days=6)
        if monday.month == sunday.month:
            return f"{monday.strftime('%b %d')}–{sunday.strftime('%d, %Y')}"
        return f"{monday.strftime('%b %d')} – {sunday.strftime('%b %d, %Y')}"
    if granularity == "month":
        dt = datetime.strptime(key, "%Y-%m")
        return dt.strftime("%B %Y")
    dt = datetime.strptime(key, "%Y-%m-%d")
    return dt.strftime("%b %d, %Y")
