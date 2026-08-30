"""Integration tests for dq_observations repo."""

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
    uid = user_repo.create_user(email="a@a.com", name="a")["id"]
    run = dq_runs_repo.start_run(user_id=uid, trigger="manual")
    # Migration 028 added a FK from dq_observations.issue_type to the vocab
    # table. Seed the labels these tests reference (the TRUNCATE wiped the
    # bootstrap-seeded constants for this user).
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (uid,))
        cur.execute(
            """
            INSERT INTO dq_vocab_issue_types (user_id, issue_type, status)
            VALUES (%s, 'reversal_pattern', 'proposed'),
                   (%s, 'ux_friction', 'proposed')
            ON CONFLICT (user_id, issue_type) DO NOTHING
            """,
            (uid, uid),
        )
    return {"user_id": uid, "run_id": run["id"]}


def test_create_observation_core(ctx):
    obs = dq_observations_repo.create_observation(
        user_id=ctx["user_id"],
        run_id=ctx["run_id"],
        tag="core",
        entity_type="page",
        entity_id="42",
        issue_type="reversal_pattern",
        observation="Skip-gate overfits on personal-blog phrasing.",
        severity="warning",
        scope_citation="S1",
    )
    assert obs["id"] is not None
    assert obs["tag"] == "core"
    assert obs["scope_citation"] == "S1"
    assert obs["handoff_prompt_draft"] is None


def test_create_observation_adjacent_handoff(ctx):
    obs = dq_observations_repo.create_observation(
        user_id=ctx["user_id"],
        run_id=ctx["run_id"],
        tag="adjacent",
        entity_type="global",
        entity_id="annotation_ui",
        issue_type="ux_friction",
        observation="Note-textarea blur event not firing on certain browsers.",
        severity="info",
        adjacency_contract_ref="A1",
        handoff_prompt_draft="Hello CC session, please investigate...",
    )
    assert obs["handoff_status"] == "draft"
    assert obs["adjacency_contract_ref"] == "A1"


def _make_obs_with_rec(ctx, entity_id="42", issue_type="reversal_pattern"):
    obs = dq_observations_repo.create_observation(
        user_id=ctx["user_id"], run_id=ctx["run_id"], tag="core",
        entity_type="page", entity_id=entity_id,
        issue_type=issue_type,
        observation="x", severity="info", scope_citation="S1",
    )
    rec = dq_recommendations_repo.create_recommendation(
        user_id=ctx["user_id"],
        run_id=ctx["run_id"],
        observation_id=obs["id"],
        action_type="edit_prompt",
        headline="fix it",
        rationale="...",
        self_classification="judgment",
        rank_in_run=1,
        affected_entity_type="page",
        affected_entity_ids=[entity_id],
    )
    return obs, rec


def test_dedup_check_catches_duplicate(ctx):
    """A pending recommendation on the entity+issue blocks a refile (spec S2)."""
    _make_obs_with_rec(ctx)
    already_seen = dq_observations_repo.has_observation(
        user_id=ctx["user_id"],
        entity_type="page",
        entity_id="42",
        issue_type="reversal_pattern",
    )
    assert already_seen is True

    never_seen = dq_observations_repo.has_observation(
        user_id=ctx["user_id"],
        entity_type="page",
        entity_id="999",
        issue_type="reversal_pattern",
    )
    assert never_seen is False


def test_has_observation_pending_only(ctx):
    """spec S2 dedup ledger: pending blocks; approved/dismissed don't; a bare
    observation with no recommendation at all doesn't either."""
    # Entity 42: pending rec -> blocks
    _make_obs_with_rec(ctx, entity_id="42")
    assert dq_observations_repo.has_observation(
        ctx["user_id"], "page", "42", "reversal_pattern"
    ) is True

    # Entity 43: rec resolved to 'approved' -> no longer blocks
    obs_43, rec_43 = _make_obs_with_rec(ctx, entity_id="43")
    dq_recommendations_repo.update_status(rec_id=rec_43["id"], new_status="approved")
    assert dq_observations_repo.has_observation(
        ctx["user_id"], "page", "43", "reversal_pattern"
    ) is False

    # Entity 44: rec resolved to 'dismissed' -> no longer blocks
    obs_44, rec_44 = _make_obs_with_rec(ctx, entity_id="44")
    dq_recommendations_repo.update_status(rec_id=rec_44["id"], new_status="dismissed")
    assert dq_observations_repo.has_observation(
        ctx["user_id"], "page", "44", "reversal_pattern"
    ) is False

    # Entity 45: observation exists but no recommendation was ever created
    # (an observation-only finding) -> doesn't block either.
    dq_observations_repo.create_observation(
        user_id=ctx["user_id"], run_id=ctx["run_id"], tag="core",
        entity_type="page", entity_id="45",
        issue_type="reversal_pattern",
        observation="observation only, no rec", severity="info",
    )
    assert dq_observations_repo.has_observation(
        ctx["user_id"], "page", "45", "reversal_pattern"
    ) is False


def test_newest_rec_for_entity_issue_returns_latest(ctx):
    """Ordered by created_at DESC across the whole chain, any status."""
    obs, rec1 = _make_obs_with_rec(ctx, entity_id="50")
    dq_recommendations_repo.update_status(rec_id=rec1["id"], new_status="rejected")

    rec2 = dq_recommendations_repo.create_recommendation(
        user_id=ctx["user_id"],
        run_id=ctx["run_id"],
        observation_id=obs["id"],
        action_type="edit_prompt",
        headline="second attempt",
        rationale="...",
        self_classification="judgment",
        rank_in_run=2,
        affected_entity_type="page",
        affected_entity_ids=["50"],
    )

    newest = dq_observations_repo.newest_rec_for_entity_issue(
        ctx["user_id"], "page", "50", "reversal_pattern"
    )
    assert newest is not None
    assert newest["id"] == rec2["id"]
    assert newest["headline"] == "second attempt"


def test_newest_rec_for_entity_issue_none_when_no_rec(ctx):
    dq_observations_repo.create_observation(
        user_id=ctx["user_id"], run_id=ctx["run_id"], tag="core",
        entity_type="page", entity_id="60",
        issue_type="reversal_pattern",
        observation="no rec here", severity="info",
    )
    assert dq_observations_repo.newest_rec_for_entity_issue(
        ctx["user_id"], "page", "60", "reversal_pattern"
    ) is None


def test_newest_rec_for_entity_issue_none_when_no_observation(ctx):
    assert dq_observations_repo.newest_rec_for_entity_issue(
        ctx["user_id"], "page", "999", "reversal_pattern"
    ) is None


def test_list_for_run(ctx):
    dq_observations_repo.create_observation(
        user_id=ctx["user_id"], run_id=ctx["run_id"], tag="core",
        entity_type="page", entity_id="42",
        issue_type="reversal_pattern",
        observation="x", severity="info", scope_citation="S1",
    )
    dq_observations_repo.create_observation(
        user_id=ctx["user_id"], run_id=ctx["run_id"], tag="adjacent",
        entity_type="global", entity_id="annotation_ui",
        issue_type="ux_friction",
        observation="y", severity="info",
        adjacency_contract_ref="A1", handoff_prompt_draft="...",
    )
    rows = dq_observations_repo.list_for_run(ctx["run_id"])
    assert len(rows) == 2
    tags = {r["tag"] for r in rows}
    assert tags == {"core", "adjacent"}


def test_update_handoff_status(ctx):
    obs = dq_observations_repo.create_observation(
        user_id=ctx["user_id"], run_id=ctx["run_id"], tag="adjacent",
        entity_type="global", entity_id="annotation_ui",
        issue_type="ux_friction", observation="x", severity="info",
        adjacency_contract_ref="A1",
        handoff_prompt_draft="...",
    )
    updated = dq_observations_repo.update_handoff_status(
        obs_id=obs["id"], new_status="sent"
    )
    assert updated["handoff_status"] == "sent"
