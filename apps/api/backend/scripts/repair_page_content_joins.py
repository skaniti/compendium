"""Repair ``pages`` rows joined to another page's ``page_content`` row.

Why: before the identity-pairing fix in ``process_captures.update_pages_from_response``,
results were zipped to DB rows by position. ``insert_pages`` collapses consecutive
duplicate visits, so every page after a collapsed/reordered one received its
neighbour's ``page_content_id``, ``content_summary`` and skip verdict.

A page is *mismatched* when ``pages.page_content_id`` points at a ``page_content`` row
whose ``normalized_url`` differs from the page's own ``normalized_url`` (if the page's
column is NULL it is derived from ``pages.url`` with ``normalize_url``).

Per mismatched page:
  * own content row exists -> re-point ``page_content_id`` to it and refresh the
    denormalised ``content_summary`` / ``extracted_text`` from it (clustering reads
    ``pages.content_summary`` first, so a stale wrong summary would stay in play).
    ``extracted_text`` is only overwritten when the content row has text, because the
    page's own copy came from the capture request and may be the only good one.
  * otherwise -> ``page_content_id = NULL``, ``content_summary = NULL``,
    ``status = 'pending'``, ``archive_reason / processing_depth / skip_reasoning /
    skip_category = NULL`` so the pending sweep re-fetches and re-gates the page.

``human_status`` is never touched. Mismatched pages archived by ``skip_gate`` were
gated on another page's text; they are listed (``--regate-list``) and, with
``--apply --regate``, reset to ``pending`` so the sweep re-gates them.

Embedding caches (``page_embeddings``, ``clustering_embeddings``) are keyed by
``page_content_id``; with ``--apply`` the rows for every content id involved (old wrong
target and new target) are deleted so they re-embed from the right text.

Usage (the DEFAULT IS A DRY RUN; nothing is written without --apply):
    python -m backend.scripts.repair_page_content_joins
    python -m backend.scripts.repair_page_content_joins --user-id 1 --report r.json
    python -m backend.scripts.repair_page_content_joins --apply --regate \\
        --report r.json --regate-list regate.json

Apply mode runs in a single transaction. ``--report`` / ``--regate-list`` write CSV
when the path ends in ``.csv``, JSON otherwise. After applying, let the pending sweep
(``sweep_pending_once``) run to re-fetch/re-gate the pages set to ``pending``.
"""

import argparse
import csv
import json
import logging
import sys
from collections import Counter
from pathlib import Path

# repo root = two levels up (this file lives at backend/scripts/)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db.connection import get_conn
from backend.utils.url_normalize import normalize_url

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

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

_REPORT_FIELDS = [
    "page_id",
    "user_id",
    "url",
    "action",
    "old_content_id",
    "new_content_id",
    "old_status",
    "old_archive_reason",
    "regate",
]


def find_mismatches(cur, user_id: int | None = None) -> list[dict]:
    """Return one dict per mismatched page, with the repair action decided."""
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
    if not rows:
        return rows

    # Own content row, looked up by normalized_url (unique via md5 index).
    cur.execute(
        "SELECT normalized_url, id FROM page_content WHERE normalized_url = ANY(%s)",
        (sorted({r["normalized_url"] for r in rows}),),
    )
    own = dict(cur.fetchall())
    for r in rows:
        r["new_content_id"] = own.get(r["normalized_url"])
        r["action"] = "repoint" if r["new_content_id"] is not None else "null_and_refetch"
        r["regate"] = r["old_status"] == "archived" and r["old_archive_reason"] == "skip_gate"
    return rows


def _cache_rows(cur, content_ids: list[int]) -> int:
    if not content_ids:
        return 0
    total = 0
    for table in ("page_embeddings", "clustering_embeddings"):
        cur.execute(f"SELECT COUNT(*) FROM {table} WHERE page_content_id = ANY(%s)", (content_ids,))
        total += cur.fetchone()[0]
    return total


def _apply(cur, rows: list[dict], content_ids: list[int], regate: bool) -> int:
    repoint = [r for r in rows if r["action"] == "repoint"]
    refetch = [r["page_id"] for r in rows if r["action"] == "null_and_refetch"]

    for r in repoint:
        cur.execute(
            """
            UPDATE pages p SET
                page_content_id = c.id,
                content_summary = c.content_summary,
                extracted_text = COALESCE(c.extracted_text, p.extracted_text)
            FROM page_content c
            WHERE c.id = %s AND p.id = %s
            """,
            (r["new_content_id"], r["page_id"]),
        )
    if refetch:
        cur.execute(
            """
            UPDATE pages SET page_content_id = NULL, content_summary = NULL,
                status = 'pending', archive_reason = NULL, processing_depth = NULL,
                skip_reasoning = NULL, skip_category = NULL
            WHERE id = ANY(%s)
            """,
            (refetch,),
        )
    if regate:
        ids = [r["page_id"] for r in rows if r["regate"]]
        if ids:
            cur.execute(
                """
                UPDATE pages SET status = 'pending', archive_reason = NULL,
                    skip_reasoning = NULL, skip_category = NULL
                WHERE id = ANY(%s)
                """,
                (ids,),
            )

    deleted = 0
    if content_ids:
        for table in ("page_embeddings", "clustering_embeddings"):
            cur.execute(f"DELETE FROM {table} WHERE page_content_id = ANY(%s)", (content_ids,))
            deleted += cur.rowcount
    return deleted


def run(
    *, apply: bool = False, regate: bool = False, user_id: int | None = None
) -> tuple[dict, list[dict]]:
    """Find (and with ``apply`` repair) mismatched pages. Returns (summary, rows).

    Dry run issues only SELECTs. Apply mode does all writes in one transaction
    (``get_conn`` commits on clean exit and rolls back on error).
    """
    with get_conn() as conn, conn.cursor() as cur:
        rows = find_mismatches(cur, user_id)
        content_ids = sorted(
            {r["old_content_id"] for r in rows}
            | {r["new_content_id"] for r in rows if r["new_content_id"] is not None}
        )
        summary = {
            "mode": "apply" if apply else "dry-run",
            "mismatched": len(rows),
            "repairable": sum(r["action"] == "repoint" for r in rows),
            "null_and_refetch": sum(r["action"] == "null_and_refetch" for r in rows),
            "skip_gate_regate_needed": sum(r["regate"] for r in rows),
            "regate_applied": bool(apply and regate),
            "embedding_cache_rows": _cache_rows(cur, content_ids),
            "by_user": dict(Counter(str(r["user_id"]) for r in rows)),
        }
        if apply:
            summary["embedding_cache_rows_deleted"] = _apply(cur, rows, content_ids, regate)
    return summary, rows


def _write_rows(path: str, rows: list[dict]) -> None:
    out = [{k: r.get(k) for k in _REPORT_FIELDS} for r in rows]
    with open(path, "w", newline="") as f:
        if path.endswith(".csv"):
            w = csv.DictWriter(f, fieldnames=_REPORT_FIELDS)
            w.writeheader()
            w.writerows(out)
        else:
            json.dump(out, f, indent=2)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--regate", action="store_true", help="with --apply: reset skip_gate pages")
    ap.add_argument("--user-id", type=int, default=None, help="limit to one user (default: all)")
    ap.add_argument("--report", help="write all affected pages (.json or .csv)")
    ap.add_argument("--regate-list", help="write skip-gate pages needing re-gating")
    args = ap.parse_args(argv)
    if args.regate and not args.apply:
        ap.error("--regate requires --apply")

    summary, rows = run(apply=args.apply, regate=args.regate, user_id=args.user_id)

    log.info(f"[{summary['mode']}] mismatched pages:        {summary['mismatched']}")
    log.info(f"  repairable (own content exists): {summary['repairable']}")
    log.info(f"  to null + re-fetch (pending):    {summary['null_and_refetch']}")
    log.info(f"  skip-gate re-runs needed:        {summary['skip_gate_regate_needed']}")
    log.info(f"  embedding cache rows affected:   {summary['embedding_cache_rows']}")
    for uid, n in sorted(summary["by_user"].items()):
        log.info(f"  user {uid}: {n}")
    if args.apply:
        log.info(f"  embedding cache rows deleted:    {summary['embedding_cache_rows_deleted']}")
        if not args.regate and summary["skip_gate_regate_needed"]:
            log.info("  (skip-gate pages listed only; pass --regate to reset them to pending)")
    else:
        log.info("dry run -- no changes written; pass --apply to repair")

    if args.report:
        _write_rows(args.report, rows)
        log.info(f"report written: {args.report}")
    if args.regate_list:
        _write_rows(args.regate_list, [r for r in rows if r["regate"]])
        log.info(f"regate list written: {args.regate_list}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
