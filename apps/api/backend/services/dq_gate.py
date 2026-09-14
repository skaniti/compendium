"""Deterministic signal gate for dqBot Tier 2 sensor passes.

The nightly sensor pass (recluster_event trigger) runs the structural
detectors (S2/S3/S4/S6) with no LLM calls and hands the raw candidates to
`evaluate()` here. The gate decides -- deterministically, FP-robust, never
on raw S2 counts alone -- whether the signal is strong enough to justify a
mini-model confirm step, and whether that confirm step in turn justifies
enqueuing a full (Opus) run. See
the 2026-07-19 dqbot-tier2-role-split plan (private), spec.md,
"Sensor pass" section, for the design rationale.

Three independent trip rules feed `tripped` (any one is enough):
  - a brand-new systemic S3 finding (entity_type == "global" with no
    existing pending observation) -- a domain silo is worth a look the
    moment it appears, counts aside;
  - an S2 or S4 raw candidate count more than DQ_GATE_DELTA_FACTOR times
    its rolling baseline mean over the last few sensor runs (skipped
    entirely when there's no baseline yet -- see `_baseline_means`);
  - total novel candidate count >= DQ_GATE_NOVEL_MIN.

`tripped` alone does not enqueue a full run -- `confirmed` does, and is
`False` unless the mini-model confirm step (batched adjudication over the
novel candidates only) survives at least DQ_GATE_CONFIRM_MIN of them.
Confirm is skipped -- fail-closed, `confirmed=False` -- during the post-
full-run cooldown window (DQ_GATE_COOLDOWN_DAYS) and on any confirm-step
exception: a broken adjudicator must never fire Opus early.

Env flags are read at CALL time (not import time) so callers/tests can set
os.environ per-call without a module reload. The module-level names below
are the env var NAMES, not their values -- `_DEFAULT_*` are the fallbacks.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

from backend.db import dq_observations_repo, dq_runs_repo
from backend.services import dq_adjudicator

logger = logging.getLogger(__name__)

# --- Env var names (values read at call time via os.environ.get) ---------
DQ_GATE_DISABLED = "DQ_GATE_DISABLED"
DQ_GATE_DELTA_FACTOR = "DQ_GATE_DELTA_FACTOR"
DQ_GATE_NOVEL_MIN = "DQ_GATE_NOVEL_MIN"
DQ_GATE_CONFIRM_MIN = "DQ_GATE_CONFIRM_MIN"
DQ_GATE_COOLDOWN_DAYS = "DQ_GATE_COOLDOWN_DAYS"

_DEFAULT_DELTA_FACTOR = 2.0
_DEFAULT_NOVEL_MIN = 10
_DEFAULT_CONFIRM_MIN = 5
_DEFAULT_COOLDOWN_DAYS = 2

# Scope citations the delta-baseline rule watches (spec: S2/S4 raw-count
# deltas vs. the rolling sensor baseline -- S1/S3/S5/S6 aren't part of this
# particular rule; S3 has its own systemic-novelty rule above).
_DELTA_SCOPES = ("S2", "S4")

# How many recent sensor runs feed the rolling baseline mean.
_BASELINE_WINDOW = 7


def _is_disabled() -> bool:
    return os.environ.get(DQ_GATE_DISABLED, "0") == "1"


def _delta_factor() -> float:
    return float(os.environ.get(DQ_GATE_DELTA_FACTOR, _DEFAULT_DELTA_FACTOR))


def _novel_min() -> int:
    return int(os.environ.get(DQ_GATE_NOVEL_MIN, _DEFAULT_NOVEL_MIN))


def _confirm_min() -> int:
    return int(os.environ.get(DQ_GATE_CONFIRM_MIN, _DEFAULT_CONFIRM_MIN))


def _cooldown_days() -> int:
    return int(os.environ.get(DQ_GATE_COOLDOWN_DAYS, _DEFAULT_COOLDOWN_DAYS))


def _fmt(n: float) -> str:
    """Render a number for a human-readable reason string, dropping a
    trailing '.0' so reasons read '2x baseline 12', not '2.0x baseline
    12.0'. Reasons render verbatim in the History tab."""
    f = float(n)
    if f == int(f):
        return str(int(f))
    return f"{f:.1f}"


def _counts_by_scope(candidates: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for c in candidates:
        scope = c.get("scope_citation") or "unscoped"
        counts[scope] = counts.get(scope, 0) + 1
    return counts


def _novel(candidates: list[dict], user_id: int) -> list[dict]:
    """Candidates whose (entity_type, entity_id, issue_type) has no pending
    observation in the ledger yet -- has_observation is pending-only dedup
    (a regression re-files as new), so this is genuinely "not already
    being tracked", not just "never seen"."""
    out = []
    for c in candidates:
        entity_type = c.get("entity_type")
        entity_id = c.get("entity_id")
        issue_type = c.get("issue_type")
        if not dq_observations_repo.has_observation(
            user_id, entity_type, str(entity_id), issue_type
        ):
            out.append(c)
    return out


def _baseline_means(user_id: int) -> dict[str, float]:
    """Mean per-scope raw candidate count across the user's recent sensor
    runs, for the scopes the delta rule watches (_DELTA_SCOPES).

    Returns {} when there's no sensor history yet -- the delta rule then
    has nothing to compare against and is skipped entirely (the
    novel-count and systemic-novelty rules still apply). A scope absent
    from a historical run's metrics counts as 0 for that run, not
    excluded, so one quiet run correctly pulls the mean down.
    """
    history = dq_runs_repo.recent_sensor_metrics(user_id, limit=_BASELINE_WINDOW)
    if not history:
        return {}
    means: dict[str, float] = {}
    for scope in _DELTA_SCOPES:
        total = sum((h.get("counts") or {}).get(scope, 0) for h in history)
        means[scope] = total / len(history)
    return means


def _cooldown_reason(last_full_run_completed_at, cooldown_days: int) -> str | None:
    """None when there's no active cooldown; otherwise a human-readable
    reason naming how recently the last full run completed."""
    if last_full_run_completed_at is None:
        return None
    completed = last_full_run_completed_at
    if completed.tzinfo is None:
        completed = completed.replace(tzinfo=timezone.utc)
    elapsed = datetime.now(timezone.utc) - completed
    if elapsed >= timedelta(days=cooldown_days):
        return None
    elapsed_days = elapsed.total_seconds() / 86400
    return (
        f"cooldown: last full run completed {_fmt(elapsed_days)}d ago "
        f"(< {cooldown_days}d cooldown)"
    )


def evaluate(user_id: int, candidates: list[dict]) -> dict:
    """Decide whether a sensor pass's candidates should fire an early full
    (Opus) run.

    Returns {"metrics": {...}, "tripped": bool, "confirmed": bool,
    "reasons": [str, ...], "confirm_cost_note": str | None}.
    `confirmed=True` means "enqueue a full run" -- the caller (Task 8's
    sensor executor) does that; this function never enqueues anything
    itself.
    """
    novel = _novel(candidates, user_id)
    counts = _counts_by_scope(candidates)
    metrics = {
        "counts": counts,
        "novel_counts": _counts_by_scope(novel),
        "novel_total": len(novel),
    }

    if _is_disabled():
        logger.info("dq_gate: disabled via %s=1 for user %s", DQ_GATE_DISABLED, user_id)
        return {
            "metrics": metrics,
            "tripped": False,
            "confirmed": False,
            "reasons": [],
            "confirm_cost_note": None,
        }

    reasons: list[str] = []

    # Rule 1: brand-new systemic S3 finding -- tripped regardless of counts.
    for c in novel:
        if c.get("entity_type") == "global":
            reasons.append(f"novel systemic silo: {c.get('entity_id')}")

    # Rule 2: S2/S4 raw count > delta_factor x rolling baseline mean.
    delta_factor = _delta_factor()
    baselines = _baseline_means(user_id)
    for scope in _DELTA_SCOPES:
        baseline = baselines.get(scope)
        if not baseline:  # no baseline yet, or a genuine 0 mean -- skip
            continue
        current = counts.get(scope, 0)
        if current > baseline * delta_factor:
            reasons.append(
                f"{scope} raw count {current} > {_fmt(delta_factor)}x "
                f"baseline {_fmt(baseline)}"
            )

    # Rule 3: total novel candidate count over threshold.
    novel_min = _novel_min()
    if metrics["novel_total"] >= novel_min:
        reasons.append(
            f"novel candidate count {metrics['novel_total']} >= threshold {novel_min}"
        )

    tripped = bool(reasons)
    confirmed = False
    confirm_cost_note = None

    if tripped:
        cooldown_reason = _cooldown_reason(
            dq_runs_repo.last_full_run_completed_at(user_id), _cooldown_days()
        )
        if cooldown_reason is not None:
            # Fail closed: never enqueue on top of the existing active-run
            # guard's cousin case -- a full run just finished.
            reasons.append(cooldown_reason)
        else:
            confirm_min = _confirm_min()
            try:
                result = dq_adjudicator.adjudicate(novel, user_id)
                survivors = result.get("survivors", []) if isinstance(result, dict) else []
            except Exception as exc:  # noqa: BLE001 - fail-closed by design
                logger.warning(
                    "dq_gate: confirm step failed for user %s: %s", user_id, exc
                )
                reasons.append(f"confirm step failed ({exc}); gate fail-closed")
            else:
                # Survivors that were never actually judged because
                # adjudication was disabled or their batch failed carry
                # adjudication == "skipped" -- they must not count toward
                # the confirm threshold, or disabling the cheap model would
                # make the gate MORE trigger-happy (rubber-stamp confirm).
                # Scope pass-throughs (S1/S3/S5/S6 on the normal path)
                # carry no marker and still count: an S3-systemic-heavy
                # novelty burst is a legitimate confirm.
                effective = [
                    s for s in survivors
                    if not (isinstance(s, dict) and s.get("adjudication") == "skipped")
                ]
                confirm_cost_note = (
                    f"confirm step adjudicated {len(novel)} novel candidate(s), "
                    f"{len(effective)} counted survivor(s)"
                    + (
                        f" ({len(survivors) - len(effective)} skipped-unjudged excluded)"
                        if len(survivors) != len(effective)
                        else ""
                    )
                )
                if len(effective) >= confirm_min:
                    confirmed = True
                else:
                    reasons.append(
                        f"confirm step: {len(effective)} counted survivor(s) < "
                        f"threshold {confirm_min}"
                    )

    return {
        "metrics": metrics,
        "tripped": tripped,
        "confirmed": confirmed,
        "reasons": reasons,
        "confirm_cost_note": confirm_cost_note,
    }
