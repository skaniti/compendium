"""Applies the vocabulary canonicalization manifest to the dqBot issue_type registry.

Reads the frozen manifest at
``backend/scripts/dq_vocab_manifest_2026_07_17.json`` (a frozen orchestrator
judgment -- see
the 2026-07-17 dq-pending-recs-vocab-sweep plan (private), spec.md,
"Vocabulary sweep" section, for the full disposition rationale) and, for
``--user-id``, disposes every entry in this load-bearing order:

  1. ``canonicalize[]`` -- promote an EXISTING ``proposed``/``rejected`` entry
     to canonical via ``dq_vocab_repo.canonicalize`` (description + SBERT
     embedding). A row that does not already exist is skipped (``not_found``)
     rather than created -- this section is for the deterministic-investigator
     constants and judgment picks that were already proposed at least once.
  2. ``create_and_canonicalize[]`` -- insert a brand-new row via
     ``dq_vocab_repo.insert_proposal``, then canonicalize it the same way.
     Used for vocabulary introduced by this sweep itself (e.g.
     ``detector_calibration``) that never appeared as a proposal.
  3. ``alias[]`` -- reject the source entry and point it at ``target`` via
     ``dq_vocab_repo.alias_to``. The target must already be canonical --
     steps 1-2 run first specifically so every alias target in this manifest
     is canonical by the time this section runs. A target that is not (yet)
     canonical is a clean per-row error (``target_not_canonical``), not a
     crash and not a write.
  4. ``reject[]`` -- plain reject (no alias) via ``dq_vocab_repo.reject``.
     Entries are plain ``issue_type`` strings, not objects.

Embeddings are computed exactly the way the
``/vocab/{issue_type}/canonicalize`` endpoint does it (see
``backend/api/routers/dq_bot.py::vocab_canonicalize``):
``get_sbert_model().encode(description).tolist()``. The same >=10-character
description validation applies (``description_too_short`` outcome) before
any write. SBERT is expensive to load (~1.5s) and is only ever imported from
inside an ``--apply`` branch that has already decided it needs an embedding
-- a dry run never touches ``backend.services.sbert_loader``.

Idempotent: a second ``--apply`` run finds every entry already in its target
state and reports it as ``already_done``, writing nothing. Idempotency rule
per section:
  - canonicalize / create_and_canonicalize: current ``status == 'canonical'``.
  - alias: current ``status == 'rejected' and aliased_to == target``.
  - reject: current ``status == 'rejected'`` (regardless of ``aliased_to`` --
    re-running plain reject on an aliased-rejected row would otherwise wipe
    the alias, which is not a no-op).

A post-apply safety check reports any rows for ``--user-id`` still
``status = 'proposed'`` -- expected zero once this manifest's 52 entries are
fully applied. A dry run shows the same check as a preview: which
currently-proposed rows are NOT named anywhere in the manifest (so they
would still be proposed after ``--apply``).

RLS note: like ``dq_vocab_repo``'s own functions, every DB touch in this
script (including the raw safety-check query) sets
``app.current_user_id`` locally rather than relying on an external
``set_current_user_id`` call -- see the RLS note in
``backend/db/dq_vocab_repo.py``.

Usage:
    python -m backend.scripts.dq_vocab_canonicalize --user-id 152           # dry run
    python -m backend.scripts.dq_vocab_canonicalize --user-id 152 --apply
"""

import argparse
import json
import logging
import sys
from collections import Counter
from pathlib import Path

# repo root = two levels up (this file lives at backend/scripts/)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db import dq_vocab_repo
from backend.db.connection import get_conn

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

MANIFEST_PATH = Path(__file__).parent / "dq_vocab_manifest_2026_07_17.json"
MIN_DESCRIPTION_LEN = 10


def _load_manifest() -> dict:
    with MANIFEST_PATH.open() as f:
        return json.load(f)


def _get_embedding(description: str) -> list[float]:
    """Encode via the shared SBERT singleton -- same call as the endpoint.

    Imported lazily so that no code path reachable from a dry run ever
    triggers the ~1.5s model load.
    """
    from backend.services.sbert_loader import get_sbert_model

    return get_sbert_model().encode(description).tolist()


def _validate_description(description: str | None) -> str | None:
    """Same >=10-char rule as the canonicalize endpoint. None if valid."""
    if not description or len(description.strip()) < MIN_DESCRIPTION_LEN:
        return "description_too_short"
    return None


# ── section processors ──────────────────────────────────────────────────
# Each returns a list of {action, issue_type, outcome, ...} dicts, one per
# manifest entry, whether or not apply=True actually wrote anything.


def _process_canonicalize(entries: list[dict], apply: bool, user_id: int) -> list[dict]:
    results = []
    for e in entries:
        issue_type = e["issue_type"]
        description = e["description"]
        row = {"action": "canonicalize", "issue_type": issue_type}

        entry = dq_vocab_repo.lookup(user_id, issue_type)
        if entry is None:
            results.append({**row, "outcome": "not_found"})
            continue
        if entry.status == "canonical":
            results.append({**row, "outcome": "already_done"})
            continue

        err = _validate_description(description)
        if err:
            results.append({**row, "outcome": err})
            continue

        if apply:
            embedding = _get_embedding(description)
            dq_vocab_repo.canonicalize(
                user_id=user_id,
                issue_type=issue_type,
                description=description,
                embedding=embedding,
                canonicalized_by=user_id,
            )
        results.append({**row, "outcome": "applied"})
    return results


def _process_create_and_canonicalize(entries: list[dict], apply: bool, user_id: int) -> list[dict]:
    results = []
    for e in entries:
        issue_type = e["issue_type"]
        description = e["description"]
        rationale = e.get("proposal_rationale")
        row = {"action": "create_and_canonicalize", "issue_type": issue_type}

        entry = dq_vocab_repo.lookup(user_id, issue_type)
        if entry is not None and entry.status == "canonical":
            results.append({**row, "outcome": "already_done"})
            continue

        err = _validate_description(description)
        if err:
            results.append({**row, "outcome": err})
            continue

        if apply:
            # insert_proposal is itself idempotent (ON CONFLICT bumps the
            # counter) whether or not `entry` already existed as 'proposed'.
            dq_vocab_repo.insert_proposal(user_id, issue_type, rationale, None)
            embedding = _get_embedding(description)
            dq_vocab_repo.canonicalize(
                user_id=user_id,
                issue_type=issue_type,
                description=description,
                embedding=embedding,
                canonicalized_by=user_id,
            )
        results.append({**row, "outcome": "applied"})
    return results


def _process_alias(
    entries: list[dict],
    apply: bool,
    user_id: int,
    planned_canonical: set[str] | None = None,
) -> list[dict]:
    """``planned_canonical``: issue_types the SAME manifest canonicalizes in
    its earlier sections. In a dry run those writes haven't happened, so a
    target that is not yet canonical in the DB but IS planned reports
    ``applied`` (with a detail note) instead of a false ``target_not_canonical``.
    In apply mode the DB check is authoritative -- the earlier sections have
    actually run by the time this one does."""
    planned_canonical = planned_canonical or set()
    results = []
    for e in entries:
        issue_type = e["issue_type"]
        target = e["target"]
        row = {"action": "alias", "issue_type": issue_type, "target": target}

        entry = dq_vocab_repo.lookup(user_id, issue_type)
        if entry is None:
            results.append({**row, "outcome": "not_found"})
            continue
        if entry.status == "rejected" and entry.aliased_to == target:
            results.append({**row, "outcome": "already_done"})
            continue

        target_entry = dq_vocab_repo.lookup(user_id, target)
        if target_entry is None or target_entry.status != "canonical":
            if not apply and target in planned_canonical:
                results.append(
                    {**row, "outcome": "applied", "detail": "target canonicalized earlier this run"}
                )
                continue
            found = target_entry.status if target_entry else "missing"
            results.append(
                {**row, "outcome": "target_not_canonical", "detail": f"target status={found}"}
            )
            continue

        if apply:
            dq_vocab_repo.alias_to(user_id=user_id, issue_type=issue_type, target=target)
        results.append({**row, "outcome": "applied"})
    return results


def _process_reject(entries: list[str], apply: bool, user_id: int) -> list[dict]:
    results = []
    for issue_type in entries:
        row = {"action": "reject", "issue_type": issue_type}

        entry = dq_vocab_repo.lookup(user_id, issue_type)
        if entry is None:
            results.append({**row, "outcome": "not_found"})
            continue
        if entry.status == "rejected":
            results.append({**row, "outcome": "already_done"})
            continue

        if apply:
            dq_vocab_repo.reject(user_id=user_id, issue_type=issue_type)
        results.append({**row, "outcome": "applied"})
    return results


# ── safety check ─────────────────────────────────────────────────────────


def _manifest_covered_issue_types(manifest: dict) -> set[str]:
    covered: set[str] = set()
    covered.update(e["issue_type"] for e in manifest.get("canonicalize", []))
    covered.update(e["issue_type"] for e in manifest.get("create_and_canonicalize", []))
    covered.update(e["issue_type"] for e in manifest.get("alias", []))
    covered.update(manifest.get("reject", []))
    return covered


def _proposed_issue_types(user_id: int) -> list[str]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            SELECT issue_type FROM dq_vocab_issue_types
            WHERE user_id = %s AND status = 'proposed'
            ORDER BY issue_type
            """,
            (user_id,),
        )
        return [r[0] for r in cur.fetchall()]


def _safety_check(user_id: int, manifest: dict, apply: bool) -> list[str]:
    """Rows still status='proposed' -- actual (apply) or predicted (dry run)."""
    proposed = _proposed_issue_types(user_id)
    if apply:
        return proposed
    covered = _manifest_covered_issue_types(manifest)
    return [it for it in proposed if it not in covered]


# ── reporting ─────────────────────────────────────────────────────────────


def _print_section(label: str, results: list[dict]) -> None:
    if not results:
        return
    counts = Counter(r["outcome"] for r in results)
    summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
    log.info(f"\n{label} ({len(results)} entries): {summary}")
    for r in results:
        line = f"  {r['issue_type']}"
        if "target" in r:
            line += f" -> {r['target']}"
        line += f": {r['outcome']}"
        if r.get("detail"):
            line += f" ({r['detail']})"
        log.info(line)


# ── main ──────────────────────────────────────────────────────────────────


def main(apply: bool, user_id: int) -> None:
    log.info(f"{'APPLYING' if apply else 'DRY RUN'} — dq vocab canonicalization sweep (user_id={user_id})")
    log.info(f"Manifest: {MANIFEST_PATH}")

    manifest = _load_manifest()
    canon = manifest.get("canonicalize", [])
    create_canon = manifest.get("create_and_canonicalize", [])
    alias = manifest.get("alias", [])
    reject = manifest.get("reject", [])
    log.info(
        f"Loaded {len(canon)} canonicalize, {len(create_canon)} create_and_canonicalize, "
        f"{len(alias)} alias, {len(reject)} reject entries"
    )

    # Load-bearing order: canonicalize -> create_and_canonicalize -> alias ->
    # reject. Aliases validate their target's canonical status against
    # whatever the first two sections just wrote.
    canon_results = _process_canonicalize(canon, apply, user_id)
    _print_section("Canonicalize", canon_results)

    create_results = _process_create_and_canonicalize(create_canon, apply, user_id)
    _print_section("Create + canonicalize", create_results)

    planned_canonical = {e["issue_type"] for e in canon} | {e["issue_type"] for e in create_canon}
    alias_results = _process_alias(alias, apply, user_id, planned_canonical=planned_canonical)
    _print_section("Alias", alias_results)

    reject_results = _process_reject(reject, apply, user_id)
    _print_section("Reject", reject_results)

    all_results = canon_results + create_results + alias_results + reject_results
    totals = Counter(r["outcome"] for r in all_results)
    log.info(f"\nTotals: {len(all_results)} entries -- " + ", ".join(f"{k}={v}" for k, v in sorted(totals.items())))

    remaining = _safety_check(user_id, manifest, apply)
    verb = "remain" if apply else "would remain"
    if remaining:
        log.warning("\n" + "!" * 70)
        log.warning(f"SAFETY CHECK: {len(remaining)} row(s) {verb} status='proposed' for user_id={user_id}:")
        for it in remaining:
            log.warning(f"  {it}")
        log.warning("!" * 70)
    else:
        log.info(f"\nSafety check passed: 0 rows {verb} status='proposed' for user_id={user_id}.")

    if not apply:
        log.info("\nDry run — no changes written. Use --apply to write.")
    else:
        log.info("\nChanges written.")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Apply the dq vocab canonicalization manifest"
    )
    parser.add_argument("--apply", action="store_true", help="actually write changes")
    parser.add_argument("--user-id", type=int, required=True, help="user_id to canonicalize vocab for")
    return parser


if __name__ == "__main__":
    args = _build_parser().parse_args()
    main(apply=args.apply, user_id=args.user_id)
