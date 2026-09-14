"""Unit tests for backend.services.dq_gate -- the deterministic signal gate
that decides when a nightly sensor pass should fire an early full (Opus)
run. Pure unit tests: dq_runs_repo, dq_observations_repo, and
dq_adjudicator are all monkeypatched, no PG, no live LLM calls.

See the 2026-07-19 dqbot-tier2-role-split plan (private), spec.md
("Sensor pass" section) and the Task 4 brief
(.superpowers/sdd/task-4-brief.md) for the rules this module implements.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from backend.services import dq_gate


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _cand(scope, entity_type="cluster", entity_id="c1", issue_type="cluster_coherence"):
    return {
        "scope_citation": scope,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "issue_type": issue_type,
    }


class _FakeAdjudicator:
    """Stand-in for backend.services.dq_adjudicator's module interface --
    only the one function dq_gate calls."""

    def __init__(self, survivors=None, exc=None):
        self.survivors = survivors if survivors is not None else []
        self.exc = exc
        self.calls: list[tuple[list[dict], int]] = []

    def adjudicate(self, candidates, user_id):
        self.calls.append((candidates, user_id))
        if self.exc is not None:
            raise self.exc
        return {"survivors": self.survivors, "suppressed": [], "stats": {}}


def _wire(monkeypatch, *, pending=frozenset(), history=None, last_full=None, adjudicator=None):
    """Wire up dq_gate's three collaborators with test doubles.

    pending: entity_ids for which has_observation should return True (i.e.
        NOT novel). Everything else is novel by default.
    history: recent_sensor_metrics(user_id, limit=...) return value.
    last_full: last_full_run_completed_at(user_id) return value.
    adjudicator: object with an .adjudicate(candidates, user_id) method;
        defaults to a _FakeAdjudicator with zero survivors.
    """

    def fake_has_observation(user_id, entity_type, entity_id, issue_type):
        return entity_id in pending

    monkeypatch.setattr(dq_gate.dq_observations_repo, "has_observation", fake_has_observation)
    monkeypatch.setattr(
        dq_gate.dq_runs_repo,
        "recent_sensor_metrics",
        lambda user_id, limit=7: history if history is not None else [],
    )
    monkeypatch.setattr(
        dq_gate.dq_runs_repo, "last_full_run_completed_at", lambda user_id: last_full
    )
    fake_adj = adjudicator if adjudicator is not None else _FakeAdjudicator()
    monkeypatch.setattr(dq_gate, "dq_adjudicator", fake_adj, raising=False)
    return fake_adj


# ---------------------------------------------------------------------------
# Metrics: per-scope counts + novel subset
# ---------------------------------------------------------------------------


def test_metrics_counts_per_scope_and_novel_subset(monkeypatch):
    candidates = [
        _cand("S2", entity_id="c1"),  # novel
        _cand("S2", entity_id="c2"),  # not novel (pending)
        _cand("S3", entity_type="cluster", entity_id="c3"),  # novel
        _cand("S4", entity_id="c4"),  # not novel (pending)
    ]
    _wire(monkeypatch, pending={"c2", "c4"})

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["metrics"]["counts"] == {"S2": 2, "S3": 1, "S4": 1}
    assert result["metrics"]["novel_counts"] == {"S2": 1, "S3": 1}
    assert result["metrics"]["novel_total"] == 2


def test_no_signal_does_not_trip(monkeypatch):
    candidates = [_cand("S1", entity_id="c1")]
    fake_adj = _wire(monkeypatch, pending={"c1"})  # not novel -> nothing trips

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is False
    assert result["confirmed"] is False
    assert result["reasons"] == []
    assert result["confirm_cost_note"] is None
    assert fake_adj.calls == []  # confirm step never runs when nothing trips


# ---------------------------------------------------------------------------
# Rule: no baseline -> only the novel-count rule can trip
# ---------------------------------------------------------------------------


def test_no_baseline_trips_only_via_novel_count_rule(monkeypatch):
    # 12 novel S2 candidates -- would also look like a huge S2 delta, but
    # with zero sensor history there's nothing to compute a baseline from.
    candidates = [_cand("S2", entity_id=f"c{i}") for i in range(12)]
    _wire(monkeypatch, history=[])  # explicit: no baseline

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True
    assert "novel candidate count 12 >= threshold 10" in result["reasons"]
    assert not any(r.startswith("S2 raw count") for r in result["reasons"])


def test_novel_min_trips_independent_of_irrelevant_baseline(monkeypatch):
    # A baseline exists, but only for a scope (S2) unrelated to these S6
    # candidates -- proves the novel-count rule fires on its own.
    candidates = [_cand("S6", entity_id=f"c{i}") for i in range(10)]
    _wire(monkeypatch, history=[{"counts": {"S2": 0}}])

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True
    assert "novel candidate count 10 >= threshold 10" in result["reasons"]


# ---------------------------------------------------------------------------
# Rule: S2/S4 raw count > 2x rolling baseline mean
# ---------------------------------------------------------------------------


def test_delta_rule_trips_on_over_2x_baseline(monkeypatch):
    candidates = [_cand("S2", entity_id=f"c{i}") for i in range(34)]
    pending = {f"c{i}" for i in range(34)}  # not novel -> isolates the delta rule
    history = [{"counts": {"S2": 12}}, {"counts": {"S2": 12}}, {"counts": {"S2": 12}}]
    _wire(monkeypatch, pending=pending, history=history)

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True
    # Verbatim reason format (renders in the History tab).
    assert "S2 raw count 34 > 2x baseline 12" in result["reasons"]
    assert not any(r.startswith("novel candidate count") for r in result["reasons"])
    assert not any(r.startswith("novel systemic silo") for r in result["reasons"])


def test_delta_rule_does_not_trip_at_or_below_2x_baseline(monkeypatch):
    candidates = [_cand("S2", entity_id=f"c{i}") for i in range(24)]  # exactly 2x12
    pending = {f"c{i}" for i in range(24)}
    history = [{"counts": {"S2": 12}}]
    _wire(monkeypatch, pending=pending, history=history)

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is False
    assert result["reasons"] == []


def test_delta_factor_env_override(monkeypatch):
    monkeypatch.setenv("DQ_GATE_DELTA_FACTOR", "1.5")
    candidates = [_cand("S4", entity_id=f"c{i}") for i in range(20)]
    pending = {f"c{i}" for i in range(20)}
    history = [{"counts": {"S4": 12}}]  # 1.5x12 = 18; 20 > 18
    _wire(monkeypatch, pending=pending, history=history)

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True
    assert "S4 raw count 20 > 1.5x baseline 12" in result["reasons"]


# ---------------------------------------------------------------------------
# Rule: novel systemic S3 (entity_type == "global") trips regardless of counts
# ---------------------------------------------------------------------------


def test_new_systemic_entity_trips_regardless_of_counts(monkeypatch):
    candidates = [
        _cand(
            "S3",
            entity_type="global",
            entity_id="domain_silo:claude.ai",
            issue_type="domain_silo",
        )
    ]
    _wire(monkeypatch)  # single candidate: nowhere near the novel-count threshold

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True
    assert "novel systemic silo: domain_silo:claude.ai" in result["reasons"]


def test_already_observed_systemic_entity_does_not_trip_that_rule(monkeypatch):
    candidates = [
        _cand(
            "S3",
            entity_type="global",
            entity_id="domain_silo:claude.ai",
            issue_type="domain_silo",
        )
    ]
    _wire(monkeypatch, pending={"domain_silo:claude.ai"})  # already tracked -> not novel

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is False
    assert result["reasons"] == []


# ---------------------------------------------------------------------------
# Confirm step: tripped + adjudicator survivors >= threshold -> confirmed
# ---------------------------------------------------------------------------


def test_confirmed_when_adjudicator_confirms_enough_novel(monkeypatch):
    candidates = [_cand("S6", entity_id=f"c{i}") for i in range(10)]
    fake_adj = _FakeAdjudicator(survivors=[{"id": i} for i in range(5)])  # == DQ_GATE_CONFIRM_MIN
    _wire(monkeypatch, adjudicator=fake_adj)

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True
    assert result["confirmed"] is True
    assert result["confirm_cost_note"] is not None
    assert len(fake_adj.calls) == 1
    called_candidates, called_user_id = fake_adj.calls[0]
    assert called_user_id == 1
    assert len(called_candidates) == 10


def test_not_confirmed_when_adjudicator_confirms_too_few(monkeypatch):
    candidates = [_cand("S6", entity_id=f"c{i}") for i in range(10)]
    fake_adj = _FakeAdjudicator(survivors=[{"id": 1}])  # < DQ_GATE_CONFIRM_MIN
    _wire(monkeypatch, adjudicator=fake_adj)

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True
    assert result["confirmed"] is False
    assert any("survivor" in r for r in result["reasons"])


def test_confirm_min_env_override(monkeypatch):
    monkeypatch.setenv("DQ_GATE_CONFIRM_MIN", "2")
    candidates = [_cand("S6", entity_id=f"c{i}") for i in range(10)]
    fake_adj = _FakeAdjudicator(survivors=[{"id": 1}, {"id": 2}])
    _wire(monkeypatch, adjudicator=fake_adj)

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["confirmed"] is True


# ---------------------------------------------------------------------------
# Cooldown: recent full run forces confirmed=False even when tripped
# ---------------------------------------------------------------------------


def test_cooldown_blocks_confirm_even_when_tripped(monkeypatch):
    candidates = [_cand("S6", entity_id=f"c{i}") for i in range(10)]
    recent_full_run = datetime.now(timezone.utc) - timedelta(days=1)  # < 2-day default cooldown
    fake_adj = _wire(monkeypatch, last_full=recent_full_run)

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True
    assert result["confirmed"] is False
    assert any(r.startswith("cooldown:") for r in result["reasons"])
    assert fake_adj.calls == []  # confirm step skipped entirely during cooldown
    assert result["confirm_cost_note"] is None


def test_no_cooldown_when_last_full_run_outside_window(monkeypatch):
    candidates = [_cand("S6", entity_id=f"c{i}") for i in range(10)]
    old_full_run = datetime.now(timezone.utc) - timedelta(days=5)  # outside 2-day cooldown
    fake_adj = _wire(
        monkeypatch, last_full=old_full_run, adjudicator=_FakeAdjudicator(survivors=[])
    )

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert not any(r.startswith("cooldown:") for r in result["reasons"])
    assert len(fake_adj.calls) == 1


def test_cooldown_days_env_override(monkeypatch):
    monkeypatch.setenv("DQ_GATE_COOLDOWN_DAYS", "7")
    candidates = [_cand("S6", entity_id=f"c{i}") for i in range(10)]
    recent_full_run = datetime.now(timezone.utc) - timedelta(days=3)  # < 7-day override
    fake_adj = _wire(monkeypatch, last_full=recent_full_run)

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["confirmed"] is False
    assert any(r.startswith("cooldown:") for r in result["reasons"])
    assert fake_adj.calls == []


# ---------------------------------------------------------------------------
# DQ_GATE_DISABLED kill switch
# ---------------------------------------------------------------------------


def test_gate_disabled_short_circuits_but_still_computes_metrics(monkeypatch):
    monkeypatch.setenv("DQ_GATE_DISABLED", "1")
    candidates = [
        _cand("S3", entity_type="global", entity_id="domain_silo:x", issue_type="domain_silo")
    ]
    fake_adj = _wire(monkeypatch)  # would otherwise trip the systemic-novelty rule

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is False
    assert result["confirmed"] is False
    assert result["reasons"] == []
    assert result["confirm_cost_note"] is None
    assert result["metrics"]["counts"] == {"S3": 1}
    assert result["metrics"]["novel_total"] == 1
    assert fake_adj.calls == []


# ---------------------------------------------------------------------------
# Fail-closed: a broken confirm step never fires Opus early
# ---------------------------------------------------------------------------


def test_adjudicator_exception_fails_closed(monkeypatch):
    candidates = [_cand("S6", entity_id=f"c{i}") for i in range(10)]
    fake_adj = _FakeAdjudicator(exc=RuntimeError("boom"))
    _wire(monkeypatch, adjudicator=fake_adj)

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True
    assert result["confirmed"] is False
    assert any("confirm step failed" in r for r in result["reasons"])
    assert result["confirm_cost_note"] is None


def test_missing_adjudicator_module_fails_closed(monkeypatch):
    # Simulates the state before Task 3 (adjudicator) lands: dq_gate falls
    # back to dq_adjudicator = None rather than crashing at import time.
    candidates = [_cand("S6", entity_id=f"c{i}") for i in range(10)]
    monkeypatch.setattr(dq_gate, "dq_adjudicator", None, raising=False)
    monkeypatch.setattr(
        dq_gate.dq_observations_repo, "has_observation", lambda *a, **k: False
    )
    monkeypatch.setattr(dq_gate.dq_runs_repo, "recent_sensor_metrics", lambda *a, **k: [])
    monkeypatch.setattr(
        dq_gate.dq_runs_repo, "last_full_run_completed_at", lambda *a, **k: None
    )

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True
    assert result["confirmed"] is False
    assert any("confirm step failed" in r for r in result["reasons"])


# ---------------------------------------------------------------------------
# Confirm step: skipped-unjudged survivors don't count (orchestrator review fix)
# ---------------------------------------------------------------------------


def test_skipped_marked_survivors_do_not_count_toward_confirm(monkeypatch):
    """DQ_ADJUDICATION_DISABLED (or a failed batch) marks pass-throughs
    adjudication="skipped"; those must not rubber-stamp the confirm step."""
    candidates = [_cand("S2", entity_id=f"c{i}") for i in range(10)]
    skipped_survivors = [
        {"id": i, "adjudication": "skipped"} for i in range(10)
    ]
    _wire(monkeypatch, adjudicator=_FakeAdjudicator(survivors=skipped_survivors))

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True  # novel_total 10 >= 10
    assert result["confirmed"] is False
    assert any("0 counted survivor" in r for r in result["reasons"])
    assert "skipped-unjudged excluded" in result["confirm_cost_note"]


def test_unmarked_pass_through_survivors_count_toward_confirm(monkeypatch):
    """Scope pass-throughs (e.g. novel S3 candidates) carry no adjudication
    marker and legitimately count toward the confirm threshold."""
    candidates = [
        _cand("S3", entity_type="global", entity_id=f"domain_silo:d{i}")
        for i in range(5)
    ] + [_cand("S2", entity_id=f"c{i}") for i in range(5)]
    survivors = [{"id": i} for i in range(5)] + [
        {"id": 100 + i, "adjudication": {"verdict": "confirm"}} for i in range(2)
    ]
    _wire(monkeypatch, adjudicator=_FakeAdjudicator(survivors=survivors))

    result = dq_gate.evaluate(user_id=1, candidates=candidates)

    assert result["tripped"] is True
    assert result["confirmed"] is True  # 5 unmarked + 2 confirm-marked >= 5
