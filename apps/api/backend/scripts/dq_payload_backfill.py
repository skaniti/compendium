"""Backfill split-rec action_payloads + re-key a dead-subject override.

Companion to the runs 58-60 pre-annotation
(``docs/project-plans/2026-07-19-132251-dq-runs-58-60-pre-annotation/``).
Two operations, both driven by the committed manifest
``dq_payload_backfill_manifest_2026_07_19.json``:

1. **Payload backfills** -- recs 267/276/301 shipped ``split_cluster``
   payloads with ``stable_id`` only, so a UI approve is record-only
   (``_apply_split_cluster`` requires ``remove_page_content_ids``). This
   fills in the eviction lists so the user's approve actually evicts.
   NO status change and NO ``dq_apply`` call here -- unlike
   ``dq_rec_sweep``, the human's UI click stays the verdict AND the
   trigger; this script only completes the payload it acts on.

2. **Override re-key** -- retire the permanently-dormant override whose
   subject stable_id died at a recluster, and seed a replacement keyed to
   the successor identity with the identical eviction payload and the same
   ``source_rec_id`` provenance.

Guards (all skip-and-report, never clobber):
- backfill only while the rec is still ``pending``, belongs to
  ``--user-id``, and its action_type matches the manifest's expectation;
- idempotent: a rec whose payload already carries
  ``remove_page_content_ids`` is skipped (re-run safe);
- the retire only fires while the override is ``active`` AND its subject
  matches the manifest's guard stable_id; the create is skipped when an
  active override with the successor subject already exists.

Dry-run by default; ``--apply`` to execute. ``--user-id`` is required and
must match the manifest (server safety: the manifest is user-specific).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from backend.db import dq_overrides_repo
from backend.db.connection import get_conn, set_current_user_id

logger = logging.getLogger(__name__)

_MANIFEST_PATH = Path(__file__).parent / "dq_payload_backfill_manifest_2026_07_19.json"


def _load_manifest() -> dict:
    with open(_MANIFEST_PATH, encoding="utf-8") as f:
        return json.load(f)


def _get_rec(rec_id: int, user_id: int) -> dict | None:
    """Fetch the fields the guards need (no by-id getter exists in the repo)."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT user_id, status, action_type, action_payload"
            " FROM dq_recommendations WHERE id = %s AND user_id = %s",
            (rec_id, user_id),
        )
        r = cur.fetchone()
    if r is None:
        return None
    return {"user_id": r[0], "status": r[1], "action_type": r[2], "action_payload": r[3]}


def _backfill_one(entry: dict, user_id: int, apply: bool) -> str:
    """Process one payload backfill. Returns a status string for the summary."""
    rec_id = entry["rec_id"]
    rec = _get_rec(rec_id, user_id)
    if rec is None:
        return "missing"
    if rec["status"] != "pending":
        return f"status_mismatch({rec['status']})"
    if rec["action_type"] != entry["expected_action_type"]:
        return f"action_type_mismatch({rec['action_type']})"
    current = rec.get("action_payload") or {}
    if current.get("remove_page_content_ids"):
        return "already_backfilled"
    new_payload = entry["action_payload"]
    if current.get("stable_id") and current["stable_id"] != new_payload["stable_id"]:
        return f"stable_id_mismatch({current['stable_id']})"
    if not apply:
        return "would_backfill"
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE dq_recommendations SET action_payload = %s"
            " WHERE id = %s AND status = 'pending'",
            (json.dumps(new_payload), rec_id),
        )
        if cur.rowcount != 1:
            return "raced(status changed mid-run)"
    return "backfilled"


def _rekey_override(spec: dict, user_id: int, apply: bool) -> list[str]:
    """Retire the dead-subject override and seed its replacement."""
    results: list[str] = []
    retire_id = spec["retire_override_id"]
    guard_sid = spec["retire_guard_subject_stable_id"]
    create = spec["create"]
    new_sid = create["subject"]["stable_id"]

    all_overrides = {o["id"]: o for o in dq_overrides_repo.list_all(user_id)}
    old = all_overrides.get(retire_id)

    if old is None:
        results.append(f"retire {retire_id}: missing")
    elif (old.get("subject") or {}).get("stable_id") != guard_sid:
        results.append(f"retire {retire_id}: subject_guard_mismatch")
    elif old["status"] != "active":
        results.append(f"retire {retire_id}: already_{old['status']}")
    elif not apply:
        results.append(f"retire {retire_id}: would_retire")
    else:
        dq_overrides_repo.retire(retire_id, user_id)
        results.append(f"retire {retire_id}: retired")

    existing_active = [
        o for o in all_overrides.values()
        if o["status"] == "active"
        and (o.get("subject") or {}).get("stable_id") == new_sid
    ]
    if existing_active:
        results.append(f"create: skipped (active override {existing_active[0]['id']} already keyed to {new_sid[:8]})")
    elif not apply:
        results.append(f"create: would_create exclude_from_cluster on {new_sid[:8]}")
    else:
        row = dq_overrides_repo.create_override(
            user_id=user_id,
            override_type=create["override_type"],
            subject=create["subject"],
            payload=create["payload"],
            source_rec_id=create.get("source_rec_id"),
        )
        results.append(f"create: override {row['id']} active on {new_sid[:8]}")
    return results


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--user-id", type=int, required=True)
    parser.add_argument("--apply", action="store_true", help="execute (default: dry-run)")
    args = parser.parse_args()

    manifest = _load_manifest()
    if args.user_id != manifest["user_id"]:
        print(f"ABORT: --user-id {args.user_id} != manifest user_id {manifest['user_id']}")
        return 1
    set_current_user_id(args.user_id)

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] {_MANIFEST_PATH.name}")

    print("\npayload backfills:")
    for entry in manifest["payload_backfills"]:
        outcome = _backfill_one(entry, args.user_id, args.apply)
        print(f"  rec {entry['rec_id']}: {outcome} -- {entry['note'][:80]}")

    print("\noverride re-key:")
    for line in _rekey_override(manifest["override_rekey"], args.user_id, args.apply):
        print(f"  {line}")

    print("\ndone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
