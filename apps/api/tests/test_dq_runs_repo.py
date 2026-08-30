"""Integration tests for dq_runs repo."""

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import dq_runs_repo, user_repo
from backend.db.connection import get_conn


@pytest.fixture
def user_id():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE dq_runs CASCADE")
        cur.execute("TRUNCATE users CASCADE")
    return user_repo.create_user(email="t@example.com", name="t")["id"]


def test_start_run_creates_running_row(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    assert run["id"] is not None
    assert run["status"] == "running"
    assert run["trigger"] == "manual"


def test_complete_run_updates_status_and_counts(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    updated = dq_runs_repo.complete_run(
        run_id=run["id"],
        observations_written=7,
        recommendations_written=3,
        llm_cost_usd=0.42,
    )
    assert updated["status"] == "completed"
    assert updated["observations_written"] == 7
    assert updated["llm_cost_usd"] == pytest.approx(0.42)


# ---------------------------------------------------------------------------
# has_active_run_for_user — transition + isolation coverage
# (supplements the queued/running case in the job-queue block below;
#  adapted from the deleted has_running_run_for_user tests, Task 6.1)
# ---------------------------------------------------------------------------


def test_has_active_run_false_after_complete(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    dq_runs_repo.complete_run(
        run_id=run["id"],
        observations_written=0,
        recommendations_written=0,
        llm_cost_usd=0.0,
    )
    assert dq_runs_repo.has_active_run_for_user(user_id) is False


def test_has_active_run_false_after_fail(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    dq_runs_repo.fail_run(run["id"], "test failure")
    assert dq_runs_repo.has_active_run_for_user(user_id) is False


# ---------------------------------------------------------------------------
# fail_run / get_run / list_runs_for_user — failure_reason (migration 040)
# ---------------------------------------------------------------------------


def test_fail_run_persists_reason(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    dq_runs_repo.fail_run(run["id"], "boom: something broke")
    fetched = dq_runs_repo.get_run(run_id=run["id"], user_id=user_id)
    assert fetched["status"] == "failed"
    assert fetched["failure_reason"] == "boom: something broke"


def test_fail_run_truncates_long_reason(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    long_reason = "x" * 5000
    dq_runs_repo.fail_run(run["id"], long_reason)
    fetched = dq_runs_repo.get_run(run_id=run["id"], user_id=user_id)
    assert len(fetched["failure_reason"]) == 2000
    assert fetched["failure_reason"] == long_reason[:2000]


def test_fail_run_none_reason_is_null_safe(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    dq_runs_repo.fail_run(run["id"], None)
    fetched = dq_runs_repo.get_run(run_id=run["id"], user_id=user_id)
    assert fetched["status"] == "failed"
    assert fetched["failure_reason"] is None


def test_list_runs_for_user_includes_failure_reason(user_id):
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    dq_runs_repo.fail_run(run["id"], "listed reason")
    rows = dq_runs_repo.list_runs_for_user(user_id=user_id)
    by_id = {r["id"]: r for r in rows}
    assert by_id[run["id"]]["failure_reason"] == "listed reason"


# ---------------------------------------------------------------------------
# reap_stale_runs — stale 'queued' rows (migration 040 / Tier 0 run forensics)
# ---------------------------------------------------------------------------


def test_reap_stale_runs_fails_old_queued_rows(user_id):
    run = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE dq_runs SET started_at = now() - INTERVAL '25 hours' WHERE id = %s",
            (run["id"],),
        )
    reaped = dq_runs_repo.reap_stale_runs()
    assert reaped >= 1
    fetched = dq_runs_repo.get_run(run_id=run["id"], user_id=user_id)
    assert fetched["status"] == "failed"
    assert "queued" in fetched["failure_reason"]


def test_reap_stale_runs_leaves_fresh_queued_rows(user_id):
    run = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule")
    dq_runs_repo.reap_stale_runs()
    fetched = dq_runs_repo.get_run(run_id=run["id"], user_id=user_id)
    assert fetched["status"] == "queued"
    assert fetched["failure_reason"] is None


def test_has_active_run_isolates_by_user(user_id):
    """An active row for another user must not surface for this user."""
    from backend.db import user_repo
    from backend.db.connection import set_current_user_id

    other = user_repo.create_user(email="other@example.com", name="other")["id"]
    set_current_user_id(other)
    dq_runs_repo.start_run(user_id=other, trigger="manual")
    set_current_user_id(user_id)

    assert dq_runs_repo.has_active_run_for_user(user_id) is False
    assert dq_runs_repo.has_active_run_for_user(other) is True


# ---------------------------------------------------------------------------
# Job-queue: enqueue / claim / has_active / abort  (DQ worker runtime)
# ---------------------------------------------------------------------------


def test_enqueue_creates_queued_row(user_id):
    run = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule")
    assert run["id"] is not None
    assert run["status"] == "queued"
    assert run["trigger"] == "schedule"


def test_claim_promotes_queued_to_running(user_id):
    enq = dq_runs_repo.enqueue(user_id=user_id, trigger="manual")
    claimed = dq_runs_repo.claim_next_queued_run()
    assert claimed is not None
    assert claimed["id"] == enq["id"]
    assert claimed["status"] == "running"


def test_claim_returns_none_when_nothing_queued(user_id):
    assert dq_runs_repo.claim_next_queued_run() is None


def test_claim_serializes_per_user(user_id):
    """Two queued rows for one user: claim one, the second waits until the first finishes."""
    first = dq_runs_repo.enqueue(user_id=user_id, trigger="manual")
    second = dq_runs_repo.enqueue(user_id=user_id, trigger="schedule")

    claimed1 = dq_runs_repo.claim_next_queued_run()
    assert claimed1["id"] == first["id"]

    # User now has a running row -> the second queued row must NOT be claimable yet.
    assert dq_runs_repo.claim_next_queued_run() is None

    dq_runs_repo.complete_run(
        run_id=first["id"], observations_written=0, recommendations_written=0, llm_cost_usd=0.0
    )
    claimed2 = dq_runs_repo.claim_next_queued_run()
    assert claimed2["id"] == second["id"]


def test_claim_is_cross_user(user_id):
    """The worker claims any user's queued run (owner role bypasses RLS)."""
    other = user_repo.create_user(email="other2@example.com", name="other2")["id"]
    dq_runs_repo.enqueue(user_id=other, trigger="schedule")
    claimed = dq_runs_repo.claim_next_queued_run()
    assert claimed is not None
    assert claimed["user_id"] == other


def test_has_active_run_true_for_queued_and_running(user_id):
    assert dq_runs_repo.has_active_run_for_user(user_id) is False
    dq_runs_repo.enqueue(user_id=user_id, trigger="schedule")
    assert dq_runs_repo.has_active_run_for_user(user_id) is True  # queued counts
    dq_runs_repo.claim_next_queued_run()
    assert dq_runs_repo.has_active_run_for_user(user_id) is True  # now running


def test_abort_flag_roundtrip(user_id):
    enq = dq_runs_repo.enqueue(user_id=user_id, trigger="manual")
    assert dq_runs_repo.is_abort_requested(enq["id"]) is False
    dq_runs_repo.request_abort(enq["id"])
    assert dq_runs_repo.is_abort_requested(enq["id"]) is True
