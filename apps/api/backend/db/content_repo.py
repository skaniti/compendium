"""Repository for the page_content table (URL-level content dedup)."""

import json
import logging
from urllib.parse import urlparse

from backend.db.connection import get_conn
from backend.utils.url_normalize import normalize_url

logger = logging.getLogger(__name__)


def get_or_create_content(
    url: str,
    *,
    extracted_text: str | None = None,
    fetched_content: dict | None = None,
    content_summary: str | None = None,
    tool_selected: str | None = None,
) -> dict:
    """Return existing content row for URL, or create one.

    Lookups are keyed off ``normalized_url`` (host-lowercased, fragment-
    stripped, tracking-params-removed, trailing-slash-trimmed, sorted
    query params) via ``backend.utils.url_normalize.normalize_url``. The
    raw ``url`` column is preserved as the first-seen URL for display
    and recovery — it is never overwritten on subsequent inserts.

    Returns dict with 'id', 'url', 'domain', 'is_new' (True if just created).

    Backfill semantics ("keep the richer value"):
        On re-visits to an existing URL (same normalized form, possibly
        different raw URL), each field is updated if the incoming value
        is strictly better than what's stored:

        - ``extracted_text``: backfill if NULL or strictly shorter (keep the longest).
        - ``fetched_content``: backfill if NULL or has fewer keys (keep the richest dict).
        - ``content_summary``: backfill if NULL or strictly shorter.
        - ``tool_selected``: backfill only if currently NULL (never overwrite a known tool).

    History:
        - Prior to Plan 01 (2026-04-04), only ``extracted_text`` was backfilled,
          silently discarding richer ``fetched_content`` updates on revisits.
        - Prior to Plan 04 (2026-04-04), lookups keyed on the raw ``url``,
          which meant e.g. ``example.com/page?utm_source=a`` and
          ``example.com/page?utm_source=b`` produced two distinct rows.
          Now they collapse to the same normalized form.
    """
    canonical = normalize_url(url)
    domain = urlparse(url).netloc or None

    with get_conn() as conn:
        with conn.cursor() as cur:
            # Try to fetch existing — SELECT everything we may need to
            # compare against for the "keep richer" logic below.
            cur.execute(
                """
                SELECT id, url, domain, extracted_text, fetched_content,
                       content_summary, tool_selected, fetched_at
                FROM page_content WHERE normalized_url = %s
                """,
                (canonical,),
            )
            row = cur.fetchone()

            if row is not None:
                (
                    existing_id,
                    existing_url,
                    existing_domain,
                    existing_extracted,
                    existing_fetched,
                    existing_summary,
                    existing_tool,
                    existing_fetched_at,
                ) = row

                # Compute per-field updates. None in a set means "don't update".
                updates: dict[str, object] = {}
                overwrites: list[str] = []  # fields where we replaced non-null existing values

                # extracted_text: backfill if NULL OR shorter than incoming
                if extracted_text:
                    if existing_extracted is None:
                        updates["extracted_text"] = extracted_text
                    elif len(extracted_text) > len(existing_extracted):
                        updates["extracted_text"] = extracted_text
                        overwrites.append("extracted_text")

                # fetched_content: backfill if NULL OR fewer keys than incoming
                if fetched_content:
                    if existing_fetched is None:
                        updates["fetched_content"] = json.dumps(fetched_content)
                    else:
                        # existing_fetched may arrive as str (old rows) or dict (pgvector auto-decode)
                        existing_fc = existing_fetched
                        if isinstance(existing_fc, str):
                            try:
                                existing_fc = json.loads(existing_fc)
                            except (json.JSONDecodeError, TypeError):
                                existing_fc = {}
                        if not isinstance(existing_fc, dict):
                            existing_fc = {}
                        if len(fetched_content) > len(existing_fc):
                            updates["fetched_content"] = json.dumps(fetched_content)
                            overwrites.append("fetched_content")

                # content_summary: backfill if NULL OR shorter
                if content_summary:
                    if existing_summary is None:
                        updates["content_summary"] = content_summary
                    elif len(content_summary) > len(existing_summary):
                        updates["content_summary"] = content_summary
                        overwrites.append("content_summary")

                # tool_selected: backfill only if NULL (never overwrite a known tool)
                if tool_selected and existing_tool is None:
                    updates["tool_selected"] = tool_selected

                if updates:
                    set_clause = ", ".join(f"{k} = %s" for k in updates)
                    cur.execute(
                        f"UPDATE page_content SET {set_clause} WHERE id = %s",
                        (*updates.values(), existing_id),
                    )
                    if overwrites:
                        logger.debug(
                            f"page_content backfill overwrote non-null fields "
                            f"{overwrites} for url={url[:100]} (id={existing_id})"
                        )

                return {
                    "id": existing_id,
                    "url": existing_url,
                    "domain": existing_domain,
                    "content_summary": updates.get("content_summary", existing_summary),
                    "tool_selected": updates.get("tool_selected", existing_tool),
                    "fetched_at": existing_fetched_at,
                    "is_new": False,
                }

            # Insert new — include normalized_url so the unique index
            # on md5(normalized_url) (migration 010) is satisfied.
            cur.execute(
                """
                INSERT INTO page_content
                    (url, normalized_url, domain, extracted_text,
                     fetched_content, content_summary, tool_selected)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id, fetched_at
                """,
                (
                    url,
                    canonical,
                    domain,
                    extracted_text,
                    json.dumps(fetched_content) if fetched_content else None,
                    content_summary,
                    tool_selected,
                ),
            )
            new_row = cur.fetchone()

    return {
        "id": new_row[0],
        "url": url,
        "domain": domain,
        "content_summary": content_summary,
        "tool_selected": tool_selected,
        "fetched_at": new_row[1],
        "is_new": True,
    }


def get_content_by_url(url: str) -> dict | None:
    """Fetch page_content by URL."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, url, domain, extracted_text, fetched_content,
                       content_summary, tool_selected, fetched_at
                FROM page_content WHERE url = %s
                """,
                (url,),
            )
            row = cur.fetchone()

    if row is None:
        return None

    return {
        "id": row[0],
        "url": row[1],
        "domain": row[2],
        "extracted_text": row[3],
        "fetched_content": row[4],
        "content_summary": row[5],
        "tool_selected": row[6],
        "fetched_at": row[7],
    }


def get_content_by_normalized_url(normalized_url: str) -> dict | None:
    """Fetch page_content by its already-normalized_url column value.

    Mirrors the query inside
    ``frontend/dash/layouts/topic_detail.py::_fetch_and_render_page_content``
    (line ~253) -- same columns, same WHERE clause. Callers must normalize
    the raw URL themselves via ``backend.utils.url_normalize.normalize_url``
    before calling this (this function does no normalization of its own,
    matching the Dash helper's structure where normalization happens once
    per candidate URL, outside the query).
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, url, domain, extracted_text, content_summary,
                       tool_selected,
                       (raw_html IS NOT NULL AND raw_html_usable)
                           AS has_usable_html
                FROM page_content
                WHERE normalized_url = %s
                """,
                (normalized_url,),
            )
            row = cur.fetchone()

    if row is None:
        return None

    return {
        "id": row[0],
        "url": row[1],
        "domain": row[2],
        "extracted_text": row[3],
        "content_summary": row[4],
        "tool_selected": row[5],
        "has_usable_html": row[6],
    }


def get_content_by_url_id(content_id: int) -> dict | None:
    """Fetch page_content by primary key ID."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, url, domain, extracted_text, fetched_content,
                       content_summary, tool_selected, fetched_at
                FROM page_content WHERE id = %s
                """,
                (content_id,),
            )
            row = cur.fetchone()

    if row is None:
        return None

    return {
        "id": row[0],
        "url": row[1],
        "domain": row[2],
        "extracted_text": row[3],
        "fetched_content": row[4],
        "content_summary": row[5],
        "tool_selected": row[6],
        "fetched_at": row[7],
    }


def update_content(content_id: int, **fields) -> None:
    """Update specific fields on a page_content row."""
    if not fields:
        return

    set_clauses = []
    values = []
    for key, val in fields.items():
        set_clauses.append(f"{key} = %s")
        if key == "fetched_content":
            values.append(json.dumps(val) if val else None)
        else:
            values.append(val)
    values.append(content_id)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE page_content SET {', '.join(set_clauses)} WHERE id = %s",
                values,
            )
