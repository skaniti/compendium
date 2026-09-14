"""Applies the executive rec-sweep disposition manifest to the dqBot queue.

Reads the frozen manifest at
``backend/scripts/dq_rec_sweep_manifest_2026_07_17.json`` (provided by the
orchestrator -- see
the 2026-07-17 dq-pending-recs-vocab-sweep plan (private), spec.md,
for the full disposition rationale) and, for each entry:

  - ``recommendations[]``: ``{rec_id, expected_prior_status, disposition,
    user_note, action?}``. The row is guarded on ``status = expected_prior_status``
    (and, when ``--user-id`` is active, on ``user_id`` matching) before any
    write. ``action`` is optional and, when present, has one of two shapes:

      * ``{"mode": "engine", "action_payload": {...}}`` -- this manifest's
        entries (runs 55-57) predate the Tier-1 apply engine (migration 042)
        and were filed with a NULL ``action_payload``. The remedy here is:
        (1) backfill ``action_payload`` on the row (guarded on the expected
        status), (2) flip status/user_note/reviewed_at (guarded again), (3)
        build the rec dict ``{id, user_id, action_type, action_payload}``
        (``action_type`` is SELECTed from the row -- it's whatever the
        original bot proposed) and call ``dq_apply.apply(rec, user_id)`` --
        the same function the PATCH-approve endpoint calls, so this mirrors
        a live approve exactly (it never raises; failures come back in the
        detail dict). (4) ``dq_recommendations_repo.mark_applied(rec_id,
        detail)`` persists the outcome. (5) the detail is logged.

      * ``{"mode": "override", "override": {override_type, subject,
        payload}}`` -- used when the manifest's chosen remedy doesn't match
        the rec's original ``action_type`` (so the engine dispatch would be
        wrong). Status/note are flipped first, then
        ``dq_overrides_repo.create_override(user_id, override_type, subject,
        payload, source_rec_id=rec_id)`` seeds a durable override directly
        (it applies at the next recluster, not now), then ``mark_applied``
        records ``{"action": "override_seeded", "override_id": ...,
        "applied": False, "reason": "applies at next recluster"}``.

      * No ``action`` key -- record-only: status/user_note/reviewed_at flip,
        nothing else.

  - ``handoffs[]``: ``{obs_id, note_bucket}`` -> ``UPDATE dq_observations SET
    handoff_status = 'dismissed' WHERE id = obs_id AND handoff_status =
    'draft'`` (same pattern as ``dq_queue_triage.py``).

A row whose current status (or handoff_status) no longer matches the
expected prior value -- already reviewed through another path, superseded,
or missing entirely -- is SKIPPED and reported individually
(``not_found`` / ``user_id_mismatch`` / ``status_mismatch``). A pending row
is never clobbered by an unexpected write.

Idempotent: a second ``--apply`` run finds every rec's status already moved
off ``expected_prior_status`` (this script's own first run moved it), so
every entry reports ``status_mismatch`` and 0 rows are touched -- no
double-backfill of ``action_payload``, no duplicate ``dq_apply.apply()``
call, no duplicate override row. (An override row is only ever created
once per successful first apply, since the status-flip guard blocks the
override branch from being reached on a re-run.)

RLS note: ``dq_recommendations`` / ``dq_observations`` carry a
``user_id = current_setting('app.current_user_id', true)::INTEGER`` RLS
policy (migration 019). The local/server app DB role (``tbd``) is a
superuser with BYPASSRLS, so this script sees every user's rows regardless
of whether ``app.current_user_id`` is set -- confirmed empirically against
the local mirror (see ``dq_queue_triage.py``). The required ``--user-id``
is therefore implemented as an explicit ``WHERE user_id = %s`` guard
(correct regardless of role privileges), not a reliance on RLS. This script
still calls ``set_current_user_id`` before every write, matching the
pattern in ``dq_queue_triage.py`` / ``dq_apply.py`` -- belt-and-braces if a
future non-superuser app role is ever introduced, and it's also what makes
``dq_apply.apply()``'s own internal ``get_conn()`` calls RLS-correct.

Unlike ``dq_queue_triage.py``, ``--user-id`` is REQUIRED here (not an
optional filter guard) -- every entry in this manifest targets a single
user's queue (152), and the engine path performs live cluster/page_clusters
mutations, so an unscoped run is not a safe default.

Usage:
    python -m backend.scripts.dq_rec_sweep --user-id 152              # dry run
    python -m backend.scripts.dq_rec_sweep --user-id 152 --apply
"""

import argparse
import json
import logging
import sys
from collections import Counter
from pathlib import Path

# repo root = two levels up (this file lives at backend/scripts/)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db import dq_overrides_repo, dq_recommendations_repo
from backend.db.connection import get_conn, set_current_user_id
from backend.services import dq_apply

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

MANIFEST_PATH = Path(__file__).parent / "dq_rec_sweep_manifest_2026_07_17.json"
CHUNK_SIZE = 50


def _load_manifest() -> dict:
    with MANIFEST_PATH.open() as f:
        return json.load(f)


def _format_action_plan(entry: dict) -> str:
    action = entry.get("action")
    if action is None:
        return "no-action (status/note flip only)"
    mode = action.get("mode")
    if mode == "engine":
        return f"engine action_payload={json.dumps(action.get('action_payload'))}"
    if mode == "override":
        return f"override={json.dumps(action.get('override'))}"
    return f"unrecognized mode={mode!r}"


# ── recommendations ──────────────────────────────────────────────────────


def _apply_engine_action(rec_id: int, expected: str, entry: dict, user_id: int, action_type: str) -> dict:
    payload = entry["action"]["action_payload"]

    # (1) backfill action_payload -- guarded on the expected prior status.
    set_current_user_id(user_id)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE dq_recommendations SET action_payload = %s WHERE id = %s AND status = %s",
            (json.dumps(payload), rec_id, expected),
        )

    # (2) flip status/user_note/reviewed_at -- same double guard.
    set_current_user_id(user_id)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE dq_recommendations
            SET status = %s, user_note = %s, reviewed_at = NOW()
            WHERE id = %s AND status = %s
            """,
            (entry["disposition"], entry["user_note"], rec_id, expected),
        )

    # (3) build the rec dict and call the same apply layer the PATCH-approve
    # endpoint calls -- never raises.
    rec = {"id": rec_id, "user_id": user_id, "action_type": action_type, "action_payload": payload}
    detail = dq_apply.apply(rec, user_id)

    # (4) persist the outcome.
    dq_recommendations_repo.mark_applied(rec_id, detail)

    # (5) surface it.
    log.info(f"  rec {rec_id}: engine applied -> {detail}")
    return detail


def _apply_override_action(rec_id: int, expected: str, entry: dict, user_id: int) -> dict:
    # flip status/note first, then seed the override.
    set_current_user_id(user_id)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE dq_recommendations
            SET status = %s, user_note = %s, reviewed_at = NOW()
            WHERE id = %s AND status = %s
            """,
            (entry["disposition"], entry["user_note"], rec_id, expected),
        )

    ov = entry["action"]["override"]
    set_current_user_id(user_id)
    override_row = dq_overrides_repo.create_override(
        user_id=user_id,
        override_type=ov["override_type"],
        subject=ov["subject"],
        payload=ov.get("payload"),
        source_rec_id=rec_id,
    )

    detail = {
        "action": "override_seeded",
        "override_id": override_row["id"],
        "applied": False,
        "reason": "applies at next recluster",
    }
    dq_recommendations_repo.mark_applied(rec_id, detail)
    log.info(f"  rec {rec_id}: override seeded -> {detail}")
    return detail


def _apply_no_action(rec_id: int, expected: str, entry: dict, user_id: int) -> None:
    set_current_user_id(user_id)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE dq_recommendations
            SET status = %s, user_note = %s, reviewed_at = NOW()
            WHERE id = %s AND status = %s
            """,
            (entry["disposition"], entry["user_note"], rec_id, expected),
        )
    log.info(f"  rec {rec_id}: {entry['disposition']} (status/note flip only)")


def _process_recommendations(
    recs: list[dict],
    apply: bool,
    user_id: int,
) -> tuple[list[dict], list[dict]]:
    """Apply (or dry-run) every recommendations[] entry against a single
    required user_id.

    Returns (applied, skipped). ``applied`` entries are annotated with
    ``detail`` when an engine/override action ran (absent for no-action /
    dry-run entries); ``skipped`` entries carry ``skip_reason`` and
    ``found_status``.
    """
    applied: list[dict] = []
    skipped: list[dict] = []
    total = len(recs)

    for i, entry in enumerate(recs, 1):
        rec_id = entry["rec_id"]
        expected = entry["expected_prior_status"]

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT status, user_id, action_type FROM dq_recommendations WHERE id = %s",
                (rec_id,),
            )
            row = cur.fetchone()

        if row is None:
            skipped.append({**entry, "skip_reason": "not_found", "found_status": None})
        else:
            current_status, row_user_id, action_type = row

            if row_user_id != user_id:
                skipped.append(
                    {
                        **entry,
                        "skip_reason": "user_id_mismatch",
                        "found_status": current_status,
                        "row_user_id": row_user_id,
                    }
                )
            elif current_status != expected:
                skipped.append(
                    {**entry, "skip_reason": "status_mismatch", "found_status": current_status}
                )
            else:
                outcome = dict(entry)
                if apply:
                    action = entry.get("action")
                    mode = action.get("mode") if action else None
                    if mode == "engine":
                        outcome["detail"] = _apply_engine_action(
                            rec_id, expected, entry, user_id, action_type
                        )
                    elif mode == "override":
                        outcome["detail"] = _apply_override_action(rec_id, expected, entry, user_id)
                    else:
                        _apply_no_action(rec_id, expected, entry, user_id)
                applied.append(outcome)

        if i % CHUNK_SIZE == 0 or i == total:
            log.info(f"  recommendations: {i}/{total} processed")

    return applied, skipped


# ── handoffs ──────────────────────────────────────────────────────────────


def _process_handoffs(
    handoffs: list[dict],
    apply: bool,
    user_id: int,
) -> tuple[list[dict], list[dict]]:
    """Apply (or dry-run) every handoffs[] entry (dismiss draft handoffs)."""
    applied: list[dict] = []
    skipped: list[dict] = []
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

            if row_user_id != user_id:
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
                    set_current_user_id(user_id)
                    with get_conn() as conn, conn.cursor() as cur:
                        cur.execute(
                            """
                            UPDATE dq_observations
                            SET handoff_status = 'dismissed'
                            WHERE id = %s AND handoff_status = 'draft'
                            """,
                            (obs_id,),
                        )
                    log.info(f"  handoff obs {obs_id}: dismissed")
                applied.append(h)

        if i % CHUNK_SIZE == 0 or i == total:
            log.info(f"  handoffs: {i}/{total} processed")

    return applied, skipped


# ── reporting ─────────────────────────────────────────────────────────────


def _print_bucket_summary(label: str, entries: list[dict], skipped: list[dict], field: str) -> None:
    all_entries = entries + skipped
    if not all_entries:
        return
    applied_by_bucket = Counter(e[field] for e in entries)
    skipped_by_bucket = Counter(e[field] for e in skipped)
    buckets = sorted(set(applied_by_bucket) | set(skipped_by_bucket))
    log.info(f"\n{label} by {field}:")
    for b in buckets:
        log.info(f"  {b:<16} applied={applied_by_bucket.get(b, 0):<4} skipped={skipped_by_bucket.get(b, 0)}")


def _print_plan(recs: list[dict]) -> None:
    """Dry-run only: the full per-rec plan, including payloads/overrides."""
    log.info(f"\nRecommendations plan ({len(recs)}):")
    for e in recs:
        log.info(
            f"  rec {e['rec_id']} expected={e['expected_prior_status']!r} "
            f"-> {e['disposition']} | {_format_action_plan(e)}"
        )
        log.info(f"    note: {e['user_note']}")


def _print_handoff_plan(handoffs: list[dict]) -> None:
    log.info(f"\nHandoffs plan ({len(handoffs)}):")
    for h in handoffs:
        log.info(f"  obs {h['obs_id']} -> dismissed | bucket={h.get('note_bucket')}")


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


def main(apply: bool, user_id: int) -> None:
    log.info(f"{'APPLYING' if apply else 'DRY RUN'} — dq rec sweep")
    log.info(f"Manifest: {MANIFEST_PATH}")
    log.info(f"user-id: {user_id} (required guard — only touching this user's rows)")

    manifest = _load_manifest()
    recs = manifest["recommendations"]
    handoffs = manifest["handoffs"]
    log.info(f"Loaded {len(recs)} recommendations, {len(handoffs)} handoffs")

    applied_recs, skipped_recs = _process_recommendations(recs, apply, user_id)
    applied_handoffs, skipped_handoffs = _process_handoffs(handoffs, apply, user_id)

    _print_bucket_summary("Recommendations", applied_recs, skipped_recs, "disposition")
    _print_bucket_summary("Handoffs", applied_handoffs, skipped_handoffs, "note_bucket")

    if not apply:
        _print_plan(recs)
        _print_handoff_plan(handoffs)

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
        description="Apply the dq rec-sweep disposition manifest (2026-07-17)"
    )
    parser.add_argument("--apply", action="store_true", help="actually write changes")
    parser.add_argument(
        "--user-id",
        type=int,
        required=True,
        help="required guard: only touch rows whose user_id matches",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="alternate manifest file (default: the frozen 2026-07-17 manifest)",
    )
    return parser


if __name__ == "__main__":
    args = _build_parser().parse_args()
    if args.manifest is not None:
        MANIFEST_PATH = args.manifest.resolve()
    main(apply=args.apply, user_id=args.user_id)
