"""Page/content join integrity: the one definition of "mismatched", and the nightly check.

A page is *mismatched* when the ``page_content`` row it points at has a
``normalized_url`` different from the page's own ``normalized_url`` (if the page's
column is NULL it is derived from ``pages.url`` with ``normalize_url``). Rows whose
stored ``pages.normalized_url`` predates a normalizer change but whose join is right
under today's ``normalize_url`` are not mismatches.

Before the identity-pairing fix in ``process_captures.update_pages_from_response``
results were zipped to page rows by position, so pages inside a browsing burst got a
neighbour's content row. This module is the regression alarm: the nightly run records
the result in ``scheduled_runs.notes`` and the Pipeline dev view reads it back.

Everything here is read-only. Repair stays a manual run of
``python -m backend.scripts.repair_page_content_joins`` (which shares
:func:`find_mismatched_pages`, so there is exactly one definition of a mismatch).
"""

from __future__ import annotations

from backend.db.connection import get_conn
from backend.utils.url_normalize import normalize_url

NOTES_KEY = "content_join_mismatches"
"""Key under which the nightly run records the check in ``scheduled_runs.notes``."""

PAGE_ID_CAP = 20
"""Most page ids kept per user in the notes (the count is always the true total)."""

# Heavy comparison in SQL. Rows whose own normalized_url is NULL are returned too so
# Python can derive it from the url (the column is NOT NULL today; belt and braces).
_MISMATCH_SQL = """
    SELECT p.id, p.user_id, p.url, p.normalized_url, p.status, p.archive_reason,
           p.page_content_id, pc.normalized_url
    FROM pages p
    JOIN page_content pc ON pc.id = p.page_content_id
    WHERE (p.normalized_url IS NULL OR pc.normalized_url <> p.normalized_url)
      AND (%(uid)s::int IS NULL OR p.user_id = %(uid)s)
    ORDER BY p.id
"""


def find_mismatched_pages(cur, user_id: int | None = None) -> list[dict]:
    """Return one dict per mismatched page (ascending page id), read-only.

    Keys: ``page_id``, ``user_id``, ``url``, ``normalized_url`` (the page's own, derived
    from the url when the column is NULL), ``old_status``, ``old_archive_reason``,
    ``old_content_id`` (the content row it points at now).
    """
    cur.execute(_MISMATCH_SQL, {"uid": user_id})
    rows = []
    for pid, uid, url, norm, status, reason, old_cid, old_norm in cur.fetchall():
        if norm is None:
            norm = normalize_url(url or "")
            if norm == old_norm:
                continue  # not actually mismatched once normalized
        if normalize_url(url or "") == old_norm:
            # The stored pages.normalized_url predates a normalizer change but the
            # join is right under today's rules: not a mismatch, leave it alone.
            continue
        rows.append(
            {
                "page_id": pid,
                "user_id": uid,
                "url": url,
                "normalized_url": norm,
                "old_status": status,
                "old_archive_reason": reason,
                "old_content_id": old_cid,
            }
        )
    return rows


def check_content_joins(user_id: int | None = None, cap: int = PAGE_ID_CAP) -> dict:
    """Run the check over all users (or one) and return the notes payload.

    ``{"count": <int>, "by_user": {"<user_id>": {"count": <int>, "page_ids": [<=cap ids,
    ascending]}}}``. ``by_user`` holds only users with mismatches, so a clean database
    gives ``{"count": 0, "by_user": {}}`` -- still present, so "checked and clean" is
    distinguishable from "did not run". Never writes.
    """
    with get_conn() as conn, conn.cursor() as cur:
        rows = find_mismatched_pages(cur, user_id)
    by_user: dict[str, dict] = {}
    for r in rows:  # rows are ordered by page id, so each user's ids stay ascending
        entry = by_user.setdefault(str(r["user_id"]), {"count": 0, "page_ids": []})
        entry["count"] += 1
        if len(entry["page_ids"]) < cap:
            entry["page_ids"].append(r["page_id"])
    return {"count": len(rows), "by_user": by_user}


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def status_for_user(run: dict | None, user_id: int) -> dict:
    """The caller's view of the latest recorded check, for the Pipeline dev view.

    ``run`` is the latest ``nightly_maintenance`` row that carries :data:`NOTES_KEY`
    (``finished_at`` + ``notes``), or None when no run has recorded the check.
    Returns ``{"state": "never"|"clean"|"mismatches"|"error", "checked_at": iso|None,
    "count": int, "page_ids": [int]}``. Only the caller's own slice is returned, never
    other users' counts or ids, and an error carries no message text (it can hold DB
    detail; the full text stays in the run's notes and the logs). An entry that does not
    parse reads as ``error`` rather than raising.
    """
    if run is None:
        return {"state": "never", "checked_at": None, "count": 0, "page_ids": []}
    finished = run.get("finished_at")
    checked_at = finished.isoformat() if finished is not None else None
    entry = (run.get("notes") or {}).get(NOTES_KEY)

    def result(state: str, count: int = 0, page_ids: list[int] | None = None) -> dict:
        return {
            "state": state,
            "checked_at": checked_at,
            "count": count,
            "page_ids": page_ids or [],
        }

    if not isinstance(entry, dict) or "error" in entry:
        return result("error")
    by_user = entry.get("by_user")
    if not _is_int(entry.get("count")) or not isinstance(by_user, dict):
        return result("error")
    mine = by_user.get(str(user_id))
    if mine is None:
        return result("clean")
    ids = mine.get("page_ids") if isinstance(mine, dict) else None
    if (
        not isinstance(ids, list)
        or not _is_int(mine.get("count"))
        or not all(_is_int(i) for i in ids)
    ):
        return result("error")
    return result("mismatches", mine["count"], ids) if mine["count"] > 0 else result("clean")
