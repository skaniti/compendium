"""Applies the executive-triage disposition manifest to the dqBot queue.

Reads the frozen manifest at ``backend/scripts/dq_triage_manifest.json``
(provided by the orchestrator -- see
``docs/project-plans/2026-07-17-120945-dq-queue-executive-triage/spec.md``
for the full disposition rationale) and, for each entry:

  - ``recommendations[]``: ``{rec_id, obs_id, expected_prior_status, status,
    bucket, user_note}`` -> ``UPDATE dq_recommendations SET status,
    user_note, reviewed_at = NOW() WHERE id = rec_id AND status =
    expected_prior_status``.
  - ``handoffs[]``: ``{obs_id, handoff_status, note_bucket}`` ->
    ``UPDATE dq_observations SET handoff_status = 'dismissed' WHERE id =
    obs_id AND handoff_status = 'draft'``.

A row whose current status (or handoff_status) no longer matches the
expected prior value -- already reviewed through another path, superseded,
or missing entirely -- is SKIPPED and reported individually. A pending row
is never clobbered by an unexpected write.

Idempotent: a second ``--apply`` run applies 0 rows and reports every entry
as skipped (status already moved off the expected value).

RLS note: ``dq_recommendations`` / ``dq_observations`` carry a
``user_id = current_setting('app.current_user_id', true)::INTEGER`` RLS
policy (migration 019). The local/server app DB role (``tbd``) is a
superuser with BYPASSRLS, so this script sees every user's rows regardless
of whether ``app.current_user_id`` is set -- confirmed empirically against
the local mirror. The ``--user-id`` filter below is therefore implemented
as an explicit ``WHERE user_id = %s`` guard (correct regardless of role
privileges), not a reliance on RLS. When a user filter is active, this
script also calls ``set_current_user_id`` before touching rows, matching
the pattern in ``suggest_vocab_descriptions.py`` / ``dq_vocab_repo.py`` --
belt-and-braces if a future non-superuser app role is ever introduced.

Usage:
    python -m backend.scripts.dq_queue_triage                     # dry run
    python -m backend.scripts.dq_queue_triage --apply
    python -m backend.scripts.dq_queue_triage --apply --user-id 152
"""

import argparse
import json
import logging
import sys
from collections import Counter
from pathlib import Path

# repo root = two levels up (this file lives at backend/scripts/)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db.connection import get_conn, set_current_user_id

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

MANIFEST_PATH = Path(__file__).parent / "dq_triage_manifest.json"
CHUNK_SIZE = 50
PREVIEW_ROWS = 10


def _load_manifest() -> dict:
    with MANIFEST_PATH.open() as f:
        return json.load(f)


def _truncate(text: str | None, width: int = 70) -> str:
    if not text:
        return ""
    text = text.replace("\n", " ")
    return text if len(text) <= width else text[: width - 3] + "..."


# ── recommendations ──────────────────────────────────────────────────────


def _process_recommendations(
    recs: list[dict],
    apply: bool,
    user_id_filter: int | None,
) -> tuple[list[dict], list[dict], set[int]]:
    """Apply (or dry-run) every recommendations[] entry.

    Returns (applied, skipped, user_ids_seen). ``applied``/``skipped`` are
    lists of the manifest entries annotated with an outcome; skipped
    entries additionally carry ``skip_reason`` and ``found_status``.
    """
    applied: list[dict] = []
    skipped: list[dict] = []
    user_ids_seen: set[int] = set()
    total = len(recs)

    for i, rec in enumerate(recs, 1):
        rec_id = rec["rec_id"]
        expected = rec["expected_prior_status"]

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT status, user_id FROM dq_recommendations WHERE id = %s",
                (rec_id,),
            )
            row = cur.fetchone()

        if row is None:
            skipped.append({**rec, "skip_reason": "not_found", "found_status": None})
        else:
            current_status, row_user_id = row
            if row_user_id is not None:
                user_ids_seen.add(row_user_id)

            if user_id_filter is not None and row_user_id != user_id_filter:
                skipped.append(
                    {
                        **rec,
                        "skip_reason": "user_id_mismatch",
                        "found_status": current_status,
                        "row_user_id": row_user_id,
                    }
                )
            elif current_status != expected:
                skipped.append(
                    {**rec, "skip_reason": "status_mismatch", "found_status": current_status}
                )
            else:
                if apply:
                    with get_conn() as conn, conn.cursor() as cur:
                        if user_id_filter is not None:
                            set_current_user_id(user_id_filter)
                        cur.execute(
                            """
                            UPDATE dq_recommendations
                            SET status = %s, user_note = %s, reviewed_at = NOW()
                            WHERE id = %s AND status = %s
                            """,
                            (rec["status"], rec["user_note"], rec_id, expected),
                        )
                applied.append(rec)

        if i % CHUNK_SIZE == 0 or i == total:
            log.info(f"  recommendations: {i}/{total} processed")

    return applied, skipped, user_ids_seen


# ── handoffs ──────────────────────────────────────────────────────────────


def _process_handoffs(
    handoffs: list[dict],
    apply: bool,
    user_id_filter: int | None,
) -> tuple[list[dict], list[dict], set[int]]:
    """Apply (or dry-run) every handoffs[] entry (dismiss draft handoffs)."""
    applied: list[dict] = []
    skipped: list[dict] = []
    user_ids_seen: set[int] = set()
    total = len(handoffs)

    for i, h in enumerate(handoffs, 1):
        obs_id = h["obs_id"]

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT handoff_status, user_id FROM dq_observations WHERE id = %s",
                (obs_id,),
            )
            row = cur.fetchone()

        if row is None:
            skipped.append({**h, "skip_reason": "not_found", "found_status": None})
        else:
            current_status, row_user_id = row
            if row_user_id is not None:
                user_ids_seen.add(row_user_id)

            if user_id_filter is not None and row_user_id != user_id_filter:
                skipped.append(
                    {
                        **h,
                        "skip_reason": "user_id_mismatch",
                        "found_status": current_status,
                        "row_user_id": row_user_id,
                    }
                )
            elif current_status != "draft":
                skipped.append(
                    {**h, "skip_reason": "status_mismatch", "found_status": current_status}
                )
            else:
                if apply:
                    with get_conn() as conn, conn.cursor() as cur:
                        if user_id_filter is not None:
                            set_current_user_id(user_id_filter)
                        cur.execute(
                            """
                            UPDATE dq_observations
                            SET handoff_status = 'dismissed'
                            WHERE id = %s AND handoff_status = 'draft'
                            """,
                            (obs_id,),
                        )
                applied.append(h)

        if i % CHUNK_SIZE == 0 or i == total:
            log.info(f"  handoffs: {i}/{total} processed")

    return applied, skipped, user_ids_seen


# ── reporting ─────────────────────────────────────────────────────────────


def _print_bucket_summary(label: str, entries: list[dict], skipped: list[dict], field: str) -> None:
    all_entries = entries + skipped
    if not all_entries:
        return
    applied_by_bucket = Counter(e[field] for e in entries)
    skipped_by_bucket = Counter(e[field] for e in skipped)
    buckets = sorted(set(applied_by_bucket) | set(skipped_by_bucket))
    log.info(f"\n{label} by bucket:")
    for b in buckets:
        log.info(f"  {b:<16} applied={applied_by_bucket.get(b, 0):<4} skipped={skipped_by_bucket.get(b, 0)}")


def _print_preview(label: str, entries: list[dict], columns: list[str]) -> None:
    if not entries:
        return
    log.info(f"\n{label} preview (first {min(PREVIEW_ROWS, len(entries))} of {len(entries)}):")
    for e in entries[:PREVIEW_ROWS]:
        parts = [f"{c}={e.get(c)}" for c in columns]
        log.info("  " + " ".join(parts))


def _print_skips(label: str, skipped: list[dict], id_field: str) -> None:
    if not skipped:
        return
    log.info(f"\n{label} skipped ({len(skipped)}):")
    for s in skipped:
        reason = s["skip_reason"]
        if reason == "user_id_mismatch":
            log.info(
                f"  id={s[id_field]} skipped: user_id_mismatch "
                f"(row user_id={s.get('row_user_id')})"
            )
        else:
            log.info(f"  id={s[id_field]} skipped: {reason} (found_status={s['found_status']})")


# ── main ──────────────────────────────────────────────────────────────────


def main(apply: bool, user_id_filter: int | None) -> None:
    log.info(f"{'APPLYING' if apply else 'DRY RUN'} — dq queue executive triage")
    log.info(f"Manifest: {MANIFEST_PATH}")

    manifest = _load_manifest()
    recs = manifest["recommendations"]
    handoffs = manifest["handoffs"]
    log.info(f"Loaded {len(recs)} recommendations, {len(handoffs)} handoffs")
    if user_id_filter is not None:
        log.info(f"user-id filter active: only touching rows with user_id={user_id_filter}")

    applied_recs, skipped_recs, rec_user_ids = _process_recommendations(recs, apply, user_id_filter)
    applied_handoffs, skipped_handoffs, handoff_user_ids = _process_handoffs(
        handoffs, apply, user_id_filter
    )

    _print_bucket_summary("Recommendations", applied_recs, skipped_recs, "bucket")
    _print_bucket_summary("Handoffs", applied_handoffs, skipped_handoffs, "note_bucket")

    if not apply:
        _print_preview(
            "Recommendations",
            recs,
            ["rec_id", "obs_id", "bucket", "status"],
        )
        _print_preview(
            "Handoffs",
            handoffs,
            ["obs_id", "note_bucket", "handoff_status"],
        )
        all_user_ids = sorted(rec_user_ids | handoff_user_ids)
        log.info(f"\nDistinct user_ids touched by this manifest: {all_user_ids}")

    log.info(
        f"\nRecommendations: {len(applied_recs)} applied, {len(skipped_recs)} skipped "
        f"(of {len(recs)} total)"
    )
    log.info(
        f"Handoffs: {len(applied_handoffs)} applied, {len(skipped_handoffs)} skipped "
        f"(of {len(handoffs)} total)"
    )

    _print_skips("Recommendations", skipped_recs, "rec_id")
    _print_skips("Handoffs", skipped_handoffs, "obs_id")

    if not apply:
        log.info("\nDry run — no changes written. Use --apply to write.")
    else:
        log.info("\nChanges written.")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Apply the dq queue executive-triage disposition manifest"
    )
    parser.add_argument("--apply", action="store_true", help="actually write changes")
    parser.add_argument(
        "--user-id",
        type=int,
        default=None,
        help="optional filter guard: only touch rows whose user_id matches",
    )
    return parser


if __name__ == "__main__":
    args = _build_parser().parse_args()
    main(apply=args.apply, user_id_filter=args.user_id)
