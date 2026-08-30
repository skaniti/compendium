"""Archive-only cleanup of three verified junk categories in ``pages``.

Three independent operations, each a status flip -- never a DELETE:

  (a) ``chrome``: claude.ai app-chrome pages (the '/', '/new', '/recents',
      '/settings', '/projects', '/downloads', '/login', '/logout',
      '/oauth', '/magic-link' shell -- NOT '/chat/<uuid>' transcripts) ->
      ``archive_reason = 'app_chrome_junk'``.
  (b) ``placeholder``: ``content_summary LIKE 'Page browsed outside API
      tool scope%%'`` (no usable content captured) ->
      ``archive_reason = 'placeholder_no_content'``.
  (c) ``dedupe``: the exact hardcoded id list below (verified duplicate
      groups from the 2026-07-17 executive triage sweep; see
      ``docs/project-plans/2026-07-17-120945-dq-queue-executive-triage/spec.md``)
      -> ``archive_reason = 'dedupe_fold'``.

Every operation is guarded by ``status = 'active' AND human_status IS
NULL`` -- a page with a human override is never touched, regardless of
which op or how it matches.

Reversal: each op is undone by
``UPDATE pages SET status = 'active', archive_reason = NULL WHERE archive_reason = '<reason>'``.

Usage:
    python -m backend.scripts.dq_junk_cleanup                    # dry run, all ops
    python -m backend.scripts.dq_junk_cleanup --apply
    python -m backend.scripts.dq_junk_cleanup --apply --only chrome

Schema dependency: the three archive reasons above are allowlisted in
``pages_archive_reason_check`` by migration 041 (they were missing from
migration 011's original list -- caught during this script's implementation;
``backend/process_captures.py``'s persist-time ``placeholder_no_content``
write shares the same dependency). Run ``backend.db.migrate`` before
``--apply`` on any database that predates 041.
"""

import argparse
import logging
import sys
from pathlib import Path

# repo root = two levels up (this file lives at backend/scripts/)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db.connection import get_conn

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

PREVIEW_ROWS = 10

# ── (a) claude.ai app-chrome junk ──────────────────────────────────────────
# Bare root, or one of the app-chrome path prefixes. '/chat/<uuid>'
# transcripts deliberately do not match either alternative.
CHROME_REASON = "app_chrome_junk"
_CHROME_ROOT_RE = r"^https?://(www\.)?claude\.ai/?$"
_CHROME_PREFIX_RE = (
    r"^https?://(www\.)?claude\.ai/"
    r"(new|recents|settings|projects|downloads|login|logout|oauth|magic-link)"
    r"(/|\?|#|$)"
)

# ── (b) placeholder / no-content captures ──────────────────────────────────
PLACEHOLDER_REASON = "placeholder_no_content"
_PLACEHOLDER_LIKE = "Page browsed outside API tool scope%"

# ── (c) verified dedupe folds ───────────────────────────────────────────────
# Groups of duplicate page rows to fold: ids to ARCHIVE and the id KEPT.
# Per-deployment data — populate against YOUR database after a manual triage
# sweep, then run. Ships empty: row ids are deployment-specific and verified
# fold groups from one corpus are meaningless (and unsafe) against another.
DEDUPE_REASON = "dedupe_fold"
DEDUPE_FOLD_GROUPS: list[dict] = []
# Flattened id -> {keep_id, note} lookup. Module-level so tests can
# monkeypatch this (and DEDUPE_FOLD_GROUPS) to a small test-id set rather
# than depend on real production ids existing in the test DB.
DEDUPE_FOLD_IDS: dict[int, dict] = {
    aid: {"keep_id": g["keep_id"], "note": g["note"]}
    for g in DEDUPE_FOLD_GROUPS
    for aid in g["archive_ids"]
}

_BASE_GUARD = "status = 'active' AND human_status IS NULL"


def _truncate(text: str | None, width: int = 60) -> str:
    if not text:
        return ""
    text = text.replace("\n", " ")
    return text if len(text) <= width else text[: width - 3] + "..."


def _chrome_where() -> tuple[str, list]:
    return (
        f"{_BASE_GUARD} AND (url ~ %s OR url ~ %s)",
        [_CHROME_ROOT_RE, _CHROME_PREFIX_RE],
    )


def _placeholder_where() -> tuple[str, list]:
    return (f"{_BASE_GUARD} AND content_summary LIKE %s", [_PLACEHOLDER_LIKE])


def _dedupe_where() -> tuple[str, list]:
    ids = list(DEDUPE_FOLD_IDS.keys())
    return (f"{_BASE_GUARD} AND id = ANY(%s)", [ids])


OPS: dict[str, dict] = {
    "chrome": {"reason": CHROME_REASON, "where": _chrome_where},
    "placeholder": {"reason": PLACEHOLDER_REASON, "where": _placeholder_where},
    "dedupe": {"reason": DEDUPE_REASON, "where": _dedupe_where},
}


def _candidate_count(where_sql: str, params: list) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT COUNT(*) FROM pages WHERE {where_sql}", params)
        return cur.fetchone()[0]


def _candidate_sample(where_sql: str, params: list, limit: int = PREVIEW_ROWS) -> list[tuple]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"SELECT id, title, url FROM pages WHERE {where_sql} ORDER BY id LIMIT %s",
            params + [limit],
        )
        return cur.fetchall()


def _apply_archive(where_sql: str, params: list, reason: str) -> list[int]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE pages SET status = 'archived', archive_reason = %s "
            f"WHERE {where_sql} RETURNING id",
            [reason] + params,
        )
        return [r[0] for r in cur.fetchall()]


def _dedupe_outcomes() -> list[dict]:
    """Per-id outcome for every id in DEDUPE_FOLD_IDS, regardless of dry-run/apply.

    Reports each id as a live archive candidate, or the reason it will be
    (or was) skipped -- missing row, human override, or already archived.
    """
    ids = list(DEDUPE_FOLD_IDS.keys())
    if not ids:
        return []
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, status, human_status FROM pages WHERE id = ANY(%s)",
            (ids,),
        )
        found = {r[0]: {"status": r[1], "human_status": r[2]} for r in cur.fetchall()}

    outcomes = []
    for pid, meta in DEDUPE_FOLD_IDS.items():
        base = {"id": pid, "keep_id": meta["keep_id"], "note": meta["note"]}
        if pid not in found:
            outcomes.append({**base, "outcome": "skip (not_found)"})
        elif found[pid]["human_status"] is not None:
            outcomes.append(
                {**base, "outcome": f"skip (human_status={found[pid]['human_status']})"}
            )
        elif found[pid]["status"] != "active":
            outcomes.append({**base, "outcome": f"skip (status={found[pid]['status']})"})
        else:
            outcomes.append({**base, "outcome": "candidate"})
    return outcomes


def _run_op(name: str, apply: bool) -> int:
    op = OPS[name]
    where_sql, params = op["where"]()
    reason = op["reason"]

    log.info(f"\n[{name}] scanning (archive_reason={reason})...")
    count = _candidate_count(where_sql, params)
    log.info(f"[{name}] {count} candidate row(s)")

    sample = _candidate_sample(where_sql, params)
    if sample:
        log.info(f"[{name}] sample (first {len(sample)}):")
        for pid, title, url in sample:
            log.info(f"  id={pid} title={_truncate(title)!r} url={_truncate(url)!r}")

    if name == "dedupe":
        outcomes = _dedupe_outcomes()
        log.info(f"[{name}] per-id outcomes ({len(outcomes)} ids in list):")
        for o in outcomes:
            log.info(
                f"  id={o['id']} keep={o['keep_id']} ({o['note']}): {o['outcome']}"
            )

    if not apply:
        log.info(f"[{name}] dry run — no changes written")
        return count

    archived_ids = _apply_archive(where_sql, params, reason)
    log.info(f"[{name}] archived {len(archived_ids)} row(s)")
    return len(archived_ids)


def main(apply: bool, only: str | None) -> None:
    ops_to_run = [only] if only else list(OPS.keys())
    log.info(f"{'APPLYING' if apply else 'DRY RUN'} — dq junk cleanup ({', '.join(ops_to_run)})")

    totals: dict[str, int] = {}
    for name in ops_to_run:
        totals[name] = _run_op(name, apply)

    log.info("\nSummary:")
    for name, n in totals.items():
        verb = "archived" if apply else "candidates"
        log.info(f"  {name}: {n} {verb}")

    if not apply:
        log.info("\nDry run — no changes written. Use --apply to write.")
    else:
        log.info("\nChanges written.")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Archive-only cleanup: claude.ai chrome, placeholder captures, dedupe folds"
    )
    parser.add_argument("--apply", action="store_true", help="actually write changes")
    parser.add_argument(
        "--only",
        choices=sorted(OPS.keys()),
        default=None,
        help="restrict to a single op (default: run all three)",
    )
    return parser


if __name__ == "__main__":
    args = _build_parser().parse_args()
    main(apply=args.apply, only=args.only)
