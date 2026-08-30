"""Integration tests for dq_runs run_kind / gate_metrics (migration 043,
dqBot Tier 2: docs/project-plans/2026-07-19-131356-dqbot-tier2-role-split/).

Covers: enqueue's run_kind default/override, claim surfacing run_kind,
set_gate_metrics + recent_sensor_metrics ordering, complete_run persisting
gate_metrics, last_full_run_completed_at ignoring sensor runs, and the
CHECK constraint rejecting an invalid run_kind.

Follows tests/test_dq_runs_repo.py's fixture pattern (same table) and
tests/test_dq_migration_042.py's note on CHECK-violation testing: psycopg2
puts the transaction into "aborted" state after a constraint violation, so
pytest.raises must be the OUTER context wrapping the repo call -- the
exception propagates through get_conn(), which rolls back cleanly before
re-raising.
"""

import pytest
from psycopg2.errors import CheckViolation

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import dq_runs_repo, user_repo
from backend.db.connection import get_conn


@pytest.fixture
def user_id():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE dq_runs CASCADE")
        cur.execute("TRUNCATE users CASCADE")
    return user_repo.create_user(email="runkind@example.com", name="runkind")["id"]


# ---------------------------------------------------------------------------
# enqueue / claim -- run_kind default + override
# ---------------------------------------------------------------------------


def test_enqueue_default_run_kind_is_full(user_id):
    run = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule")
    assert run["run_kind"] == "full"


def test_enqueue_sensor_run_kind(user_id):
    run = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule", run_kind="sensor")
    assert run["run_kind"] == "sensor"


def test_claim_returns_run_kind(user_id):
    dq_runs_repo.enqueue(user_id=user_id, trigger="manual", run_kind="sensor")
    claimed = dq_runs_repo.claim_next_queued_run()
    assert claimed is not None
    assert claimed["run_kind"] == "sensor"


def test_invalid_run_kind_raises_check_violation(user_id):
    with pytest.raises(CheckViolation):
        dq_runs_repo.enqueue(user_id=user_id, trigger="manual", run_kind="not_a_real_kind")


# ---------------------------------------------------------------------------
# complete_run(..., gate_metrics=...) persistence
# ---------------------------------------------------------------------------


def test_complete_run_with_gate_metrics_persists(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    metrics = {"signals_fired": 3, "adjudicated": True}
    dq_runs_repo.complete_run(
        run_id=run["id"],
        observations_written=0,
        recommendations_written=0,
        llm_cost_usd=0.0,
        gate_metrics=metrics,
    )
    fetched = dq_runs_repo.get_run(run_id=run["id"], user_id=user_id)
    assert fetched["gate_metrics"] == metrics


def test_complete_run_without_gate_metrics_leaves_it_null(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    dq_runs_repo.complete_run(
        run_id=run["id"],
        observations_written=0,
        recommendations_written=0,
        llm_cost_usd=0.0,
    )
    fetched = dq_runs_repo.get_run(run_id=run["id"], user_id=user_id)
    assert fetched["gate_metrics"] is None


# ---------------------------------------------------------------------------
# set_gate_metrics + recent_sensor_metrics ordering
# ---------------------------------------------------------------------------


def test_set_gate_metrics_persists(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    metrics = {"foo": "bar"}
    dq_runs_repo.set_gate_metrics(run["id"], metrics)
    fetched = dq_runs_repo.get_run(run_id=run["id"], user_id=user_id)
    assert fetched["gate_metrics"] == metrics


def test_recent_sensor_metrics_only_completed_sensor_runs_newest_first(user_id):
    # Sensor run, completed, with metrics -- should be included.
    sensor1 = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule", run_kind="sensor")
    dq_runs_repo.claim_next_queued_run()
    dq_runs_repo.complete_run(
        run_id=sensor1["id"],
        observations_written=0,
        recommendations_written=0,
        llm_cost_usd=0.0,
        gate_metrics={"n": 1},
    )

    # Sensor run, completed, with metrics -- newer, should sort first.
    sensor2 = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule", run_kind="sensor")
    dq_runs_repo.claim_next_queued_run()
    dq_runs_repo.complete_run(
        run_id=sensor2["id"],
        observations_written=0,
        recommendations_written=0,
        llm_cost_usd=0.0,
        gate_metrics={"n": 2},
    )

    # Sensor run, still queued (not completed) -- excluded even though
    # nothing sets gate_metrics on a non-completed row.
    dq_runs_repo.enqueue(user_id=user_id, trigger="schedule", run_kind="sensor")

    # Sensor run, completed, but no gate_metrics set -- excluded (NULL).
    sensor4 = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule", run_kind="sensor")
    dq_runs_repo.claim_next_queued_run()
    dq_runs_repo.complete_run(
        run_id=sensor4["id"],
        observations_written=0,
        recommendations_written=0,
        llm_cost_usd=0.0,
    )

    # Full run, completed, with gate_metrics -- excluded (wrong run_kind).
    full = dq_runs_repo.enqueue(user_id=user_id, trigger="manual", run_kind="full")
    dq_runs_repo.claim_next_queued_run()
    dq_runs_repo.complete_run(
        run_id=full["id"],
        observations_written=0,
        recommendations_written=0,
        llm_cost_usd=0.0,
        gate_metrics={"n": "full"},
    )

    result = dq_runs_repo.recent_sensor_metrics(user_id)
    assert result == [{"n": 2}, {"n": 1}]


def test_recent_sensor_metrics_respects_limit(user_id):
    for i in range(3):
        run = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule", run_kind="sensor")
        dq_runs_repo.claim_next_queued_run()
        dq_runs_repo.complete_run(
            run_id=run["id"],
            observations_written=0,
            recommendations_written=0,
            llm_cost_usd=0.0,
            gate_metrics={"i": i},
        )
    result = dq_runs_repo.recent_sensor_metrics(user_id, limit=2)
    assert result == [{"i": 2}, {"i": 1}]


# ---------------------------------------------------------------------------
# last_full_run_completed_at -- ignores sensor runs
# ---------------------------------------------------------------------------


def test_last_full_run_completed_at_ignores_sensor_runs(user_id):
    sensor = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule", run_kind="sensor")
    dq_runs_repo.claim_next_queued_run()
    dq_runs_repo.complete_run(
        run_id=sensor["id"], observations_written=0, recommendations_written=0, llm_cost_usd=0.0
    )
    assert dq_runs_repo.last_full_run_completed_at(user_id) is None


def test_last_full_run_completed_at_returns_completed_full_run(user_id):
    full = dq_runs_repo.enqueue(user_id=user_id, trigger="manual", run_kind="full")
    dq_runs_repo.claim_next_queued_run()
    dq_runs_repo.complete_run(
        run_id=full["id"], observations_written=0, recommendations_written=0, llm_cost_usd=0.0
    )
    result = dq_runs_repo.last_full_run_completed_at(user_id)
    assert result is not None


def test_last_full_run_completed_at_ignores_incomplete_full_run(user_id):
    dq_runs_repo.enqueue(user_id=user_id, trigger="manual", run_kind="full")
    dq_runs_repo.claim_next_queued_run()
    assert dq_runs_repo.last_full_run_completed_at(user_id) is None


# ---------------------------------------------------------------------------
# get_run / list_runs_for_user -- run_kind + gate_metrics surfaced
# ---------------------------------------------------------------------------


def test_get_run_includes_run_kind_and_gate_metrics(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    fetched = dq_runs_repo.get_run(run_id=run["id"], user_id=user_id)
    assert fetched["run_kind"] == "full"
    assert fetched["gate_metrics"] is None


def test_list_runs_for_user_includes_run_kind_and_gate_metrics(user_id):
    run = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule", run_kind="sensor")
    dq_runs_repo.claim_next_queued_run()
    dq_runs_repo.complete_run(
        run_id=run["id"],
        observations_written=0,
        recommendations_written=0,
        llm_cost_usd=0.0,
        gate_metrics={"listed": True},
    )
    rows = dq_runs_repo.list_runs_for_user(user_id=user_id)
    by_id = {r["id"]: r for r in rows}
    assert by_id[run["id"]]["run_kind"] == "sensor"
    assert by_id[run["id"]]["gate_metrics"] == {"listed": True}
