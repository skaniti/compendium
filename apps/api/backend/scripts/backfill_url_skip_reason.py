"""Relabel Stage-0 URL-pattern skips stored as ``skip_gate`` to ``url_skip``.

Before migration 062, ``process_captures._persist_single_page`` stored a Stage-0
URL-pattern skip (summary "URL pattern skipped: ...", never seen by the LLM gate) with
``archive_reason = 'skip_gate'``. New captures now get ``url_skip``; this script fixes the
rows written before. It matches exactly:

    archive_reason = 'skip_gate' AND processing_depth = 'skipped'
    AND content_summary LIKE 'URL pattern skipped%'

and changes only ``archive_reason``. Run migration 062 first (``python -m backend.db.migrate``);
without it the ``pages_archive_reason_check`` constraint rejects the new value and the run
fails with nothing written.

Global across users by design (the data repair is the same for everyone); ``--user-id``
limits a run to one account. Dry run by default: prints the counts and writes nothing.
``--apply`` runs the whole update in one transaction. Re-running is safe (a relabelled row no
longer matches).

Undo (before any new ``url_skip`` rows exist, which is only true until the next capture):
    UPDATE pages SET archive_reason = 'skip_gate' WHERE archive_reason = 'url_skip';

Usage (from apps/api, or /app in the API container):
    python -m backend.scripts.backfill_url_skip_reason                 # dry run
    python -m backend.scripts.backfill_url_skip_reason --apply
    python -m backend.scripts.backfill_url_skip_reason --apply --user-id 1

Once the dry run reports 0 legacy rows on every database, ``_LEGACY_URL_PATTERN`` in
``backend/db/pipeline_repo.py`` can be deleted.
"""

import argparse
import sys
from dataclasses import dataclass, field
from pathlib import Path

# repo root = two levels up (this file lives at backend/scripts/)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db.connection import get_conn

TAG = "[backfill_url_skip_reason]"
SUMMARY_PREFIX = "URL pattern skipped"

# Shared WHERE for the count, the update and the "remaining" check.
_MATCH = (
    "archive_reason = 'skip_gate' AND processing_depth = 'skipped' "
    "AND content_summary LIKE %(like)s AND (%(uid)s::int IS NULL OR user_id = %(uid)s)"
)


@dataclass
class Stats:
    candidates: int = 0
    by_user: dict[int | None, int] = field(default_factory=dict)
    gate_rows_total: int = 0  # archived skip_gate rows in scope, for context
    updated: int = 0
    remaining: int = 0  # still matching the relabel (skip_gate + URL-pattern summary)
    other_reasons: dict[str | None, int] = field(default_factory=dict)  # same summary, other reason


def _check_sees_all_rows(cur) -> None:
    """Row-level security on pages would hide other users' rows and make a run report
    nothing to relabel (same guard as backfill_asset_page_urls.py)."""
    cur.execute("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")
    row = cur.fetchone()
    if not row or not row[0]:
        raise RuntimeError(
            "the connected database role is neither superuser nor BYPASSRLS; row-level "
            "security could hide rows and the script would wrongly report nothing to relabel"
        )


def backfill(cur, *, apply: bool, user_id: int | None = None) -> Stats:
    """Count the legacy rows; relabel them when ``apply``.

    The caller owns the transaction (commit after, roll back on error).
    """
    _check_sees_all_rows(cur)
    params = {"like": SUMMARY_PREFIX + "%", "uid": user_id}
    stats = Stats()

    cur.execute(
        "SELECT COUNT(*) FROM pages WHERE archive_reason = 'skip_gate' "
        "AND (%(uid)s::int IS NULL OR user_id = %(uid)s)",
        params,
    )
    stats.gate_rows_total = cur.fetchone()[0]

    cur.execute(f"SELECT user_id, COUNT(*) FROM pages WHERE {_MATCH} GROUP BY user_id", params)
    stats.by_user = {uid: n for uid, n in cur.fetchall()}
    stats.candidates = sum(stats.by_user.values())
    print(
        f"{TAG} {stats.candidates} page(s) stored as skip_gate are URL-pattern skips "
        f"(of {stats.gate_rows_total} skip_gate rows in scope)",
        flush=True,
    )
    for uid, n in sorted(stats.by_user.items(), key=lambda kv: (kv[0] is None, kv[0])):
        print(f"{TAG}   user {uid}: {n}", flush=True)

    if apply and stats.candidates:
        cur.execute(f"UPDATE pages SET archive_reason = 'url_skip' WHERE {_MATCH}", params)
        stats.updated = cur.rowcount
        print(f"{TAG} relabelled {stats.updated} page(s) to url_skip", flush=True)
    elif apply:
        print(f"{TAG} relabelled 0 page(s) to url_skip", flush=True)

    cur.execute(f"SELECT COUNT(*) FROM pages WHERE {_MATCH}", params)
    stats.remaining = cur.fetchone()[0]
    # Skipped rows with the URL-pattern summary but a different reason (e.g. NULL after a
    # restore) are not relabelled; report them so they are not a surprise.
    cur.execute(
        "SELECT archive_reason, COUNT(*) FROM pages WHERE processing_depth = 'skipped' "
        "AND content_summary LIKE %(like)s AND archive_reason IS DISTINCT FROM 'skip_gate' "
        "AND archive_reason IS DISTINCT FROM 'url_skip' "
        "AND (%(uid)s::int IS NULL OR user_id = %(uid)s) GROUP BY archive_reason",
        params,
    )
    stats.other_reasons = {reason: n for reason, n in cur.fetchall()}
    return stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true",
                    help="write the relabel (default: dry run, nothing written)")
    ap.add_argument("--user-id", type=int, default=None,
                    help="limit the run to one user (default: every user)")
    args = ap.parse_args(argv)

    print(f"{TAG} {'APPLY' if args.apply else 'DRY RUN'}"
          + (f" (user {args.user_id})" if args.user_id is not None else " (all users)"),
          flush=True)
    try:
        with get_conn() as conn, conn.cursor() as cur:
            stats = backfill(cur, apply=args.apply, user_id=args.user_id)
    except Exception as exc:  # noqa: BLE001 - report and exit non-zero, whatever failed
        print(f"{TAG} ERROR, nothing written: {exc}", file=sys.stderr)
        return 1

    print(f"{TAG} legacy URL-pattern skips remaining: {stats.remaining}")
    if stats.other_reasons:
        shown = ", ".join(f"{r if r is not None else 'NULL'}={n}"
                          for r, n in sorted(stats.other_reasons.items(), key=lambda kv: str(kv[0])))
        print(f"{TAG} not touched (URL-pattern summary, other archive_reason): {shown}")
    print(f"{TAG} " + ("applied" if args.apply
                       else "dry run, nothing written (rerun with --apply)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
