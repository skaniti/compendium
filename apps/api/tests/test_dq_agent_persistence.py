"""Integration tests for DQAgent.persist_findings -- the agent-repo bridge."""

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
from backend.services.dq_agent import DQAgent


@pytest.fixture
def ctx():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE dq_recommendations CASCADE")
        cur.execute("TRUNCATE dq_observations CASCADE")
        cur.execute("TRUNCATE dq_runs CASCADE")
        cur.execute("TRUNCATE users CASCADE")
    uid = user_repo.create_user(email="p@p.com", name="p")["id"]
    run = dq_runs_repo.start_run(user_id=uid, trigger="manual")
    # Migration 028 added a FK from dq_observations.issue_type -> vocab.
    # Tests that call create_observation directly (bypassing the cosine gate
    # in persist_findings) need vocab seeded for their issue_types.
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


def _finding_with_rec(entity_id="42", scope="S1"):
    return {
        "tag": "core",
        "scope_citation": scope,
        "issue_type": "reversal_pattern",
        "entity_type": "page",
        "entity_id": entity_id,
        "observation": "x",
        "severity": "warning",
        "rank": 1,
        "recommendation": {
            "headline": "fix prompt",
            "rationale": "...",
            "self_classification": "judgment",
            "action_type": "edit_prompt",
            "affected_entity_ids": ["skip_gate_prompt"],
        },
        "handoff_prompt_draft": None,
    }


def _finding_observation_only(entity_id="99"):
    return {
        "tag": "adjacent",
        "adjacency_contract_ref": "A1",
        "issue_type": "ux_friction",
        "entity_type": "global",
        "entity_id": entity_id,
        "observation": "adjacent note",
        "severity": "info",
        "rank": 5,
        "recommendation": None,
        "handoff_prompt_draft": None,
    }


def test_persist_findings_writes_observation_and_recommendation(ctx):
    agent = DQAgent(user_id=ctx["user_id"])
    result = agent.persist_findings(
        user_id=ctx["user_id"],
        run_id=ctx["run_id"],
        findings=[_finding_with_rec()],
    )
    assert result["observations_written"] == 1
    assert result["recommendations_written"] == 1

    observations = dq_observations_repo.list_for_run(ctx["run_id"])
    assert len(observations) == 1
    assert observations[0]["scope_citation"] == "S1"

    pending = dq_recommendations_repo.list_pending(user_id=ctx["user_id"])
    assert len(pending) == 1
    assert pending[0]["action_type"] == "edit_prompt"
    # No action_payload on the finding -> None, not an error (spec S4).
    assert pending[0]["action_payload"] is None


def test_persist_findings_passes_action_payload_through(ctx):
    """finding["recommendation"]["action_payload"] (spec S4) flows through
    create_recommendation to the persisted row unchanged."""
    finding = _finding_with_rec(entity_id="500")
    finding["entity_type"] = "cluster"
    finding["recommendation"]["action_type"] = "relabel_cluster"
    finding["recommendation"]["action_payload"] = {
        "stable_id": "cluster-stable-500",
        "proposed_label": "New Label",
    }

    agent = DQAgent(user_id=ctx["user_id"])
    result = agent.persist_findings(
        user_id=ctx["user_id"], run_id=ctx["run_id"], findings=[finding]
    )
    assert result["recommendations_written"] == 1

    pending = dq_recommendations_repo.list_pending(user_id=ctx["user_id"])
    assert len(pending) == 1
    assert pending[0]["action_payload"] == {
        "stable_id": "cluster-stable-500",
        "proposed_label": "New Label",
    }


def test_persist_findings_refile_supersedes_resolved_prior_rec(ctx):
    """Spec S2 refile path: has_observation is pending-only now, so a
    regression on an entity+issue whose prior rec already resolved (e.g.
    approved) is NOT blocked. persist_findings must look up the newest prior
    rec via newest_rec_for_entity_issue and SUPERSEDE it (not orphan a fresh
    chain), so recur%/trend calibration stays real."""
    prior_run = dq_runs_repo.start_run(user_id=ctx["user_id"], trigger="manual")
    obs = dq_observations_repo.create_observation(
        user_id=ctx["user_id"], run_id=prior_run["id"], tag="core",
        entity_type="cluster", entity_id="stable-abc", issue_type="reversal_pattern",
        observation="first sighting", severity="info", scope_citation="S2",
    )
    old_rec = dq_recommendations_repo.create_recommendation(
        user_id=ctx["user_id"], run_id=prior_run["id"], observation_id=obs["id"],
        action_type="relabel_cluster", headline="old headline", rationale="old rationale",
        self_classification="judgment", rank_in_run=1,
        affected_entity_type="cluster", affected_entity_ids=["stable-abc"],
    )
    dq_recommendations_repo.update_status(old_rec["id"], "approved")

    # has_observation is now False (pending-only semantics) -- the same
    # entity+issue refiles as a regression.
    assert dq_observations_repo.has_observation(
        user_id=ctx["user_id"], entity_type="cluster", entity_id="stable-abc",
        issue_type="reversal_pattern",
    ) is False

    finding = {
        "tag": "core",
        "scope_citation": "S2",
        "issue_type": "reversal_pattern",
        "entity_type": "cluster",
        "entity_id": "stable-abc",
        "observation": "regression sighting",
        "severity": "warning",
        "rank": 1,
        "recommendation": {
            "headline": "new headline",
            "rationale": "new rationale",
            "self_classification": "judgment",
            "action_type": "relabel_cluster",
            "affected_entity_ids": ["stable-abc"],
            "action_payload": {"stable_id": "stable-abc", "proposed_label": "New Label"},
        },
        "handoff_prompt_draft": None,
    }

    agent = DQAgent(user_id=ctx["user_id"])
    result = agent.persist_findings(
        user_id=ctx["user_id"], run_id=ctx["run_id"], findings=[finding]
    )
    assert result["recommendations_written"] == 1

    recs = dq_recommendations_repo.list_for_observation(ctx["user_id"], obs["id"])
    assert len(recs) == 2
    new_rec = next(r for r in recs if r["id"] != old_rec["id"])
    old_rec_refreshed = next(r for r in recs if r["id"] == old_rec["id"])

    assert old_rec_refreshed["status"] == "superseded"
    assert old_rec_refreshed["superseded_by"] == new_rec["id"]
    assert new_rec["status"] == "pending"
    assert new_rec["headline"] == "new headline"
    assert new_rec["action_payload"] == {
        "stable_id": "stable-abc", "proposed_label": "New Label"
    }


def test_persist_findings_creates_fresh_rec_when_no_prior_exists(ctx):
    """When newest_rec_for_entity_issue finds nothing (brand-new entity+issue,
    the common case), persist_findings creates a fresh recommendation rather
    than attempting a supersede."""
    agent = DQAgent(user_id=ctx["user_id"])
    result = agent.persist_findings(
        user_id=ctx["user_id"],
        run_id=ctx["run_id"],
        findings=[_finding_with_rec(entity_id="999")],
    )
    assert result["recommendations_written"] == 1

    pending = dq_recommendations_repo.list_pending(user_id=ctx["user_id"])
    assert len(pending) == 1
    assert pending[0]["status"] == "pending"
    assert pending[0]["superseded_by"] is None


def test_persist_findings_observation_without_recommendation(ctx):
    agent = DQAgent(user_id=ctx["user_id"])
    result = agent.persist_findings(
        user_id=ctx["user_id"],
        run_id=ctx["run_id"],
        findings=[_finding_observation_only()],
    )
    assert result["observations_written"] == 1
    assert result["recommendations_written"] == 0

    observations = dq_observations_repo.list_for_run(ctx["run_id"])
    assert len(observations) == 1
    assert observations[0]["tag"] == "adjacent"


def test_persist_findings_skips_already_seen_entities(ctx):
    # Seed: entity 42 / reversal_pattern already observed in a prior run,
    # with a PENDING recommendation. has_observation is pending-only now
    # (spec S2) -- only a still-pending prior rec blocks a refile; a bare
    # observation with no rec (or a resolved rec) would NOT block, see
    # test_persist_findings_refile_supersedes_resolved_prior_rec below.
    prior_run = dq_runs_repo.start_run(user_id=ctx["user_id"], trigger="manual")
    obs = dq_observations_repo.create_observation(
        user_id=ctx["user_id"], run_id=prior_run["id"], tag="core",
        entity_type="page", entity_id="42", issue_type="reversal_pattern",
        observation="previously seen", severity="info", scope_citation="S1",
    )
    dq_recommendations_repo.create_recommendation(
        user_id=ctx["user_id"], run_id=prior_run["id"], observation_id=obs["id"],
        action_type="edit_prompt", headline="old headline", rationale="old rationale",
        self_classification="judgment", rank_in_run=1,
        affected_entity_type="page", affected_entity_ids=["skip_gate_prompt"],
    )

    # New run tries to re-surface the same entity + issue_type
    agent = DQAgent(user_id=ctx["user_id"])
    result = agent.persist_findings(
        user_id=ctx["user_id"],
        run_id=ctx["run_id"],
        findings=[_finding_with_rec()],
    )
    # Observation is skipped (dedup ledger caught it, prior rec still pending);
    # recommendation also not written
    assert result["observations_written"] == 0
    assert result["recommendations_written"] == 0


def test_persist_findings_mixed_batch(ctx):
    agent = DQAgent(user_id=ctx["user_id"])
    findings = [
        _finding_with_rec(entity_id="100"),
        _finding_observation_only(entity_id="200"),
        _finding_with_rec(entity_id="300", scope="S2"),
    ]
    result = agent.persist_findings(
        user_id=ctx["user_id"], run_id=ctx["run_id"], findings=findings
    )
    assert result["observations_written"] == 3
    assert result["recommendations_written"] == 2


# ----------------------------------------- finding-shape validator (Phase 4)


from backend.services.dq_agent import _validate_finding_shape


def _well_formed_finding() -> dict:
    """Minimum shape that passes _validate_finding_shape."""
    return {
        "tag": "core",
        "issue_type": "reversal_pattern",
        "entity_type": "cluster",
        "entity_id": 1,
        "observation": "x",
        "severity": "info",
        "evidence": {"items": []},
        "reasoning": {"steps": []},
        "ambiguities": {"items": []},
        "sql_query": "SELECT 1",
        "sql_query_description": "smoke",
    }


def test_validator_accepts_well_formed_finding():
    assert _validate_finding_shape(_well_formed_finding()) is None


def test_validator_rejects_missing_evidence():
    finding = _well_formed_finding()
    del finding["evidence"]
    err = _validate_finding_shape(finding)
    assert err is not None
    assert "evidence" in err


def test_validator_rejects_missing_sql_query():
    finding = _well_formed_finding()
    del finding["sql_query"]
    err = _validate_finding_shape(finding)
    assert err is not None
    assert "sql_query" in err


def test_validator_rejects_proposed_without_rationale():
    finding = _well_formed_finding()
    finding["proposed_issue_type"] = "novel_thing"
    # proposal_rationale missing -> error
    err = _validate_finding_shape(finding)
    assert err is not None
    assert "proposal_rationale" in err


def test_validator_accepts_proposed_with_rationale():
    finding = _well_formed_finding()
    finding["proposed_issue_type"] = "novel_thing"
    finding["proposal_rationale"] = "no canonical entry captures this case"
    assert _validate_finding_shape(finding) is None


def test_validator_accepts_empty_ambiguities():
    """Empty ambiguities is a deliberate 'no ambiguity' claim, not a missing field."""
    finding = _well_formed_finding()
    finding["ambiguities"] = {"items": []}
    assert _validate_finding_shape(finding) is None


def test_validator_rejects_evidence_wrong_shape():
    finding = _well_formed_finding()
    finding["evidence"] = ["not", "a", "dict"]
    err = _validate_finding_shape(finding)
    assert err is not None
    assert "evidence" in err
