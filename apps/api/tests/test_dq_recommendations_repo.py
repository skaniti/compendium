"""Integration tests for dq_recommendations repo."""

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(), reason="Test PostgreSQL not reachable"
)

from backend.db import (
    dq_observations_repo,
    dq_recommendations_repo,
    dq_runs_repo,
    user_repo,
)
from backend.db.connection import get_conn


@pytest.fixture
def ctx():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE dq_recommendations CASCADE")
        cur.execute("TRUNCATE dq_observations CASCADE")
        cur.execute("TRUNCATE dq_runs CASCADE")
        cur.execute("TRUNCATE users CASCADE")
    uid = user_repo.create_user(email="r@r.com", name="r")["id"]
    run = dq_runs_repo.start_run(user_id=uid, trigger="manual")
    # Migration 028 added a FK from dq_observations.issue_type to the vocab
    # table. Seed the labels this test references (the TRUNCATE wiped the
    # bootstrap-seeded constants for this user).
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (uid,))
        cur.execute(
            """
            INSERT INTO dq_vocab_issue_types (user_id, issue_type, status)
            VALUES (%s, 'reversal_pattern', 'proposed')
            ON CONFLICT (user_id, issue_type) DO NOTHING
            """,
            (uid,),
        )
    obs = dq_observations_repo.create_observation(
        user_id=uid, run_id=run["id"], tag="core",
        entity_type="page", entity_id="42",
        issue_type="reversal_pattern",
        observation="Skip-gate overfits.", severity="warning",
        scope_citation="S1",
    )
    return {"user_id": uid, "run_id": run["id"], "obs_id": obs["id"]}


def test_create_recommendation(ctx):
    rec = dq_recommendations_repo.create_recommendation(
        user_id=ctx["user_id"],
        run_id=ctx["run_id"],
        observation_id=ctx["obs_id"],
        action_type="edit_prompt",
        headline="Revise skip-gate prompt phrasing",
        rationale="11/14 substack pages marked incorrect.",
        self_classification="judgment",
        rank_in_run=1,
        affected_entity_type="global",
        affected_entity_ids=["skip_gate_prompt"],
    )
    assert rec["id"] is not None
    assert rec["status"] == "pending"
    assert rec["rank_in_run"] == 1
    assert rec["affected_entity_ids"] == ["skip_gate_prompt"]


def _make_rec(ctx, rank, status=None):
    rec = dq_recommendations_repo.create_recommendation(
        user_id=ctx["user_id"],
        run_id=ctx["run_id"],
        observation_id=ctx["obs_id"],
        action_type="edit_prompt",
        headline=f"rec {rank}",
        rationale="...",
        self_classification="judgment",
        rank_in_run=rank,
        affected_entity_type="global",
        affected_entity_ids=["x"],
    )
    if status and status != "pending":
        dq_recommendations_repo.update_status(rec_id=rec["id"], new_status=status)
    return rec


def test_list_pending_respects_limit(ctx):
    for rank in range(1, 8):
        _make_rec(ctx, rank)
    top5 = dq_recommendations_repo.list_pending(user_id=ctx["user_id"], limit=5)
    assert len(top5) == 5
    assert [r["rank_in_run"] for r in top5] == [1, 2, 3, 4, 5]


def test_list_pending_default_excludes_superseded(ctx):
    """Default list_pending must skip status='superseded' rows -- inbox contract."""
    # 3 pending + 2 superseded
    for rank in range(1, 4):
        _make_rec(ctx, rank)
    sup_a = _make_rec(ctx, 10)
    sup_b = _make_rec(ctx, 11)
    # Use raw UPDATE: update_status doesn't take 'superseded' from outside the
    # supersede() flow, but the schema accepts it and we're testing the SELECT.
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE dq_recommendations SET status='superseded', superseded_by=%s WHERE id=%s",
            (sup_b["id"], sup_a["id"]),
        )
        cur.execute(
            "UPDATE dq_recommendations SET status='superseded', superseded_by=%s WHERE id=%s",
            (sup_a["id"], sup_b["id"]),
        )

    rows = dq_recommendations_repo.list_pending(user_id=ctx["user_id"], limit=20)
    assert len(rows) == 3
    assert all(r["status"] == "pending" for r in rows)


def test_list_pending_with_include_superseded_returns_both(ctx):
    """include_superseded=True returns pending + superseded; superseded_by populated."""
    for rank in range(1, 4):
        _make_rec(ctx, rank)
    sup_a = _make_rec(ctx, 10)
    sup_b = _make_rec(ctx, 11)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE dq_recommendations SET status='superseded', superseded_by=%s WHERE id=%s",
            (sup_b["id"], sup_a["id"]),
        )

    rows = dq_recommendations_repo.list_pending(
        user_id=ctx["user_id"], limit=20, include_superseded=True,
    )
    statuses = sorted({r["status"] for r in rows})
    assert statuses == ["pending", "superseded"]

    # Confirm the superseded rec carries a non-null superseded_by
    sup_row = next(r for r in rows if r["id"] == sup_a["id"])
    assert sup_row["status"] == "superseded"
    assert sup_row["superseded_by"] == sup_b["id"]


def test_list_all_for_run_orders_by_rank(ctx):
    _make_rec(ctx, 3)
    _make_rec(ctx, 1)
    _make_rec(ctx, 2)
    rows = dq_recommendations_repo.list_all_for_run(run_id=ctx["run_id"])
    assert [r["rank_in_run"] for r in rows] == [1, 2, 3]


def test_update_status_approved(ctx):
    rec = _make_rec(ctx, 1)
    updated = dq_recommendations_repo.update_status(
        rec_id=rec["id"], new_status="approved"
    )
    assert updated["status"] == "approved"
    assert updated["reviewed_at"] is not None


def test_update_status_with_note(ctx):
    rec = _make_rec(ctx, 1)
    updated = dq_recommendations_repo.update_status(
        rec_id=rec["id"], new_status="rejected",
        user_note="legitimately cross-domain",
    )
    assert updated["status"] == "rejected"
    assert updated["user_note"] == "legitimately cross-domain"


def test_update_status_invalid_raises(ctx):
    rec = _make_rec(ctx, 1)
    with pytest.raises(ValueError, match="status"):
        dq_recommendations_repo.update_status(rec_id=rec["id"], new_status="bogus")


def test_supersede_marks_old_and_creates_new(ctx):
    old = _make_rec(ctx, 1)
    new_payload = {
        "user_id": ctx["user_id"],
        "run_id": ctx["run_id"],
        "observation_id": ctx["obs_id"],
        "action_type": "edit_prompt",
        "headline": "Revised headline",
        "rationale": "updated reasoning",
        "self_classification": "judgment",
        "rank_in_run": 1,
        "affected_entity_type": "global",
        "affected_entity_ids": ["skip_gate_prompt"],
    }
    new = dq_recommendations_repo.supersede(old_rec_id=old["id"], new_payload=new_payload)

    # new rec exists, points back to old
    assert new["id"] != old["id"]
    assert new["status"] == "pending"

    # old rec is now superseded, superseded_by points to new
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT status, superseded_by FROM dq_recommendations WHERE id = %s",
            (old["id"],),
        )
        old_row = cur.fetchone()
    assert old_row[0] == "superseded"
    assert old_row[1] == new["id"]


def test_calibration_summary_returns_counts(ctx):
    r1 = _make_rec(ctx, 1, status="approved")
    r2 = _make_rec(ctx, 2, status="approved")
    r3 = _make_rec(ctx, 3, status="rejected")
    summary = dq_recommendations_repo.calibration_summary(user_id=ctx["user_id"])
    assert summary["approved"] == 2
    assert summary["rejected"] == 1
    # Approval rate over reviewed (approved + rejected) = 2/3
    assert summary["approval_rate"] == pytest.approx(2 / 3, abs=0.01)


# --------------------------------------------------------------------------
# Migration 042: action_payload / mark_applied / resolve_stale_cluster_recs
# --------------------------------------------------------------------------


def test_create_recommendation_action_payload_round_trip(ctx):
    payload = {"stable_id": "abc-123", "proposed_label": "Rust ownership deep-dives"}
    rec = dq_recommendations_repo.create_recommendation(
        user_id=ctx["user_id"],
        run_id=ctx["run_id"],
        observation_id=ctx["obs_id"],
        action_type="relabel_cluster",
        headline="Relabel cluster",
        rationale="...",
        self_classification="trivial",
        rank_in_run=1,
        affected_entity_type="cluster",
        affected_entity_ids=["abc-123"],
        action_payload=payload,
    )
    assert rec["action_payload"] == payload
    assert rec["applied_at"] is None
    assert rec["applied_detail"] is None


def test_create_recommendation_action_payload_defaults_none(ctx):
    rec = _make_rec(ctx, 1)
    assert rec["action_payload"] is None


def test_supersede_carries_action_payload(ctx):
    old = _make_rec(ctx, 1)
    payload = {"stable_id": "xyz", "proposed_label": "New name"}
    new_payload = {
        "user_id": ctx["user_id"],
        "run_id": ctx["run_id"],
        "observation_id": ctx["obs_id"],
        "action_type": "relabel_cluster",
        "headline": "Revised headline",
        "rationale": "updated reasoning",
        "self_classification": "judgment",
        "rank_in_run": 1,
        "affected_entity_type": "cluster",
        "affected_entity_ids": ["xyz"],
        "action_payload": payload,
    }
    new = dq_recommendations_repo.supersede(old_rec_id=old["id"], new_payload=new_payload)
    assert new["action_payload"] == payload


def test_supersede_without_action_payload_is_none(ctx):
    old = _make_rec(ctx, 1)
    new_payload = {
        "user_id": ctx["user_id"],
        "run_id": ctx["run_id"],
        "observation_id": ctx["obs_id"],
        "action_type": "edit_prompt",
        "headline": "Revised headline",
        "rationale": "updated reasoning",
        "self_classification": "judgment",
        "rank_in_run": 1,
        "affected_entity_type": "global",
        "affected_entity_ids": ["skip_gate_prompt"],
    }
    new = dq_recommendations_repo.supersede(old_rec_id=old["id"], new_payload=new_payload)
    assert new["action_payload"] is None


def test_mark_applied_sets_applied_at_and_detail(ctx):
    rec = _make_rec(ctx, 1)
    detail = {"applied": True, "summary": "relabeled to 'Rust ownership'"}
    updated = dq_recommendations_repo.mark_applied(rec["id"], detail)
    assert updated is not None
    assert updated["applied_detail"] == detail
    assert updated["applied_at"] is not None


def test_mark_applied_record_only_detail(ctx):
    rec = _make_rec(ctx, 1)
    detail = {"applied": False, "reason": "action_type has no auto-apply path"}
    updated = dq_recommendations_repo.mark_applied(rec["id"], detail)
    assert updated["applied_detail"] == detail


def test_mark_applied_nonexistent_returns_none(ctx):
    assert dq_recommendations_repo.mark_applied(999999, {"x": 1}) is None


def _make_cluster_rec(ctx, entity_id, issue_type="reversal_pattern", rank=1):
    """Create an observation+recommendation pair for a cluster entity,
    seeding whatever vocab issue_type is needed."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (ctx["user_id"],))
        cur.execute(
            """
            INSERT INTO dq_vocab_issue_types (user_id, issue_type, status)
            VALUES (%s, %s, 'proposed')
            ON CONFLICT (user_id, issue_type) DO NOTHING
            """,
            (ctx["user_id"], issue_type),
        )
    obs = dq_observations_repo.create_observation(
        user_id=ctx["user_id"], run_id=ctx["run_id"], tag="core",
        entity_type="cluster", entity_id=entity_id,
        issue_type=issue_type, observation="x", severity="info",
    )
    rec = dq_recommendations_repo.create_recommendation(
        user_id=ctx["user_id"], run_id=ctx["run_id"], observation_id=obs["id"],
        action_type="relabel_cluster", headline=f"h-{entity_id}", rationale="r",
        self_classification="trivial", rank_in_run=rank,
        affected_entity_type="cluster", affected_entity_ids=[entity_id],
    )
    return obs, rec


def test_resolve_stale_cluster_recs_dismisses_dissolved(ctx):
    obs, rec = _make_cluster_rec(ctx, entity_id="stable-dissolved")
    dismissed_count = dq_recommendations_repo.resolve_stale_cluster_recs(
        user_id=ctx["user_id"], live_stable_ids=["stable-still-alive"],
    )
    assert dismissed_count == 1

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT status, user_note FROM dq_recommendations WHERE id = %s",
            (rec["id"],),
        )
        row = cur.fetchone()
    assert row[0] == "dismissed"
    assert "dissolved" in row[1]


def test_resolve_stale_cluster_recs_leaves_carried_untouched(ctx):
    obs, rec = _make_cluster_rec(ctx, entity_id="stable-alive")
    dismissed_count = dq_recommendations_repo.resolve_stale_cluster_recs(
        user_id=ctx["user_id"], live_stable_ids=["stable-alive"],
    )
    assert dismissed_count == 0

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM dq_recommendations WHERE id = %s", (rec["id"],))
        row = cur.fetchone()
    assert row[0] == "pending"


def test_resolve_stale_cluster_recs_empty_live_ids_is_noop(ctx):
    """Empty live_stable_ids means identity carry-forward was off/broken this
    run, not that every cluster dissolved -- must not mass-dismiss."""
    obs, rec = _make_cluster_rec(ctx, entity_id="stable-anything")
    dismissed_count = dq_recommendations_repo.resolve_stale_cluster_recs(
        user_id=ctx["user_id"], live_stable_ids=[],
    )
    assert dismissed_count == 0

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM dq_recommendations WHERE id = %s", (rec["id"],))
        row = cur.fetchone()
    assert row[0] == "pending"


def test_resolve_stale_cluster_recs_ignores_non_pending(ctx):
    """Only 'pending' cluster recs are candidates -- an already-resolved rec
    for a dissolved cluster should not be touched (or double-counted)."""
    obs, rec = _make_cluster_rec(ctx, entity_id="stable-already-approved")
    dq_recommendations_repo.update_status(rec_id=rec["id"], new_status="approved")

    dismissed_count = dq_recommendations_repo.resolve_stale_cluster_recs(
        user_id=ctx["user_id"], live_stable_ids=["some-other-stable-id"],
    )
    assert dismissed_count == 0

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM dq_recommendations WHERE id = %s", (rec["id"],))
        row = cur.fetchone()
    assert row[0] == "approved"


def test_resolve_stale_cluster_recs_ignores_non_cluster_entities(ctx):
    """A pending page-entity rec must not be dismissed by the cluster-expiry
    sweep even if its (unrelated) entity_id string happens not to be in
    live_stable_ids."""
    rec = _make_rec(ctx, 1)  # page-entity rec seeded by ctx's obs fixture
    dismissed_count = dq_recommendations_repo.resolve_stale_cluster_recs(
        user_id=ctx["user_id"], live_stable_ids=["totally-unrelated-stable-id"],
    )
    assert dismissed_count == 0

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM dq_recommendations WHERE id = %s", (rec["id"],))
        row = cur.fetchone()
    assert row[0] == "pending"


def test_resolve_stale_cluster_recs_scoped_to_user(ctx):
    """A dissolved cluster rec belonging to a different user must not be
    touched by this user's resolve call (RLS-adjacent isolation, but this
    asserts the explicit user_id filter regardless of RLS)."""
    obs, rec = _make_cluster_rec(ctx, entity_id="stable-dissolved-other-user")

    other_uid = user_repo.create_user(email="other-resolve@r.com", name="other")["id"]
    dismissed_count = dq_recommendations_repo.resolve_stale_cluster_recs(
        user_id=other_uid, live_stable_ids=["irrelevant"],
    )
    assert dismissed_count == 0

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM dq_recommendations WHERE id = %s", (rec["id"],))
        row = cur.fetchone()
    assert row[0] == "pending"
