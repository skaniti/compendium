"""API smoke tests for the dqBot endpoints (Task 3.3).

Tests hit the real test DB via TestClient. verify_api_key is bypassed in
dev mode (returns get_default_user_id() == dev@localhost). No LLM subprocess
is invoked: DQAgent.investigate is monkeypatched to return a canned payload.
"""

import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(), reason="Test PostgreSQL not reachable"
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def client_and_ctx(monkeypatch):
    """Create a TestClient with a clean dq-table state.

    Truncates dq tables and recreates the dev user to keep user_ids stable.
    Returns (client, user_id, run_id, obs_id, rec_id) so individual tests can
    operate on known seeded rows.
    """
    from backend.api.main import app, get_default_user_id
    from backend.db import (
        dq_observations_repo,
        dq_recommendations_repo,
        dq_runs_repo,
    )
    from backend.db.connection import get_conn
    from backend.services.dq_agent import DQAgent

    # Truncate dq tables only -- leaves users/captures intact so
    # get_default_user_id() still works.
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE dq_recommendations CASCADE")
        cur.execute("TRUNCATE dq_observations CASCADE")
        # dq_run_events references dq_runs via FK; truncate it before dq_runs
        # (or rely on CASCADE, but explicit is clearer).
        cur.execute("TRUNCATE dq_runs CASCADE")

    user_id = get_default_user_id()

    # Migration 028 added a FK from dq_observations.issue_type -> vocab.
    # The dev user may have been created post-migration (the bootstrap only
    # seeds users present at migration time), so explicitly seed the labels
    # this test file references.
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            INSERT INTO dq_vocab_issue_types (user_id, issue_type, status)
            VALUES (%s, 'reversal_pattern', 'proposed'),
                   (%s, 'ux_friction', 'proposed')
            ON CONFLICT (user_id, issue_type) DO NOTHING
            """,
            (user_id, user_id),
        )

    # Seed a run + observation + recommendation for PATCH/GET tests.
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    obs = dq_observations_repo.create_observation(
        user_id=user_id,
        run_id=run["id"],
        tag="core",
        entity_type="page",
        entity_id="99",
        issue_type="reversal_pattern",
        observation="Test observation for API smoke tests.",
        severity="warning",
        scope_citation="S1",
        handoff_prompt_draft="Please investigate the following...",
    )
    rec = dq_recommendations_repo.create_recommendation(
        user_id=user_id,
        run_id=run["id"],
        observation_id=obs["id"],
        action_type="edit_prompt",
        headline="Test headline",
        rationale="Test rationale",
        self_classification="judgment",
        rank_in_run=1,
        affected_entity_type="global",
        affected_entity_ids=["skip_gate_prompt"],
    )

    # Patch DQAgent.investigate so run-now doesn't launch a real subprocess.
    def _fake_investigate(
        self, trigger="manual", model=None, investigations=None,
        on_event=None, on_subprocess_start=None,
    ):
        return {"trigger": trigger, "findings": [], "total_cost_usd": 0.0}

    monkeypatch.setattr(DQAgent, "investigate", _fake_investigate)

    client = TestClient(app)
    return client, user_id, run["id"], obs["id"], rec["id"]


# ---------------------------------------------------------------------------
# GET /api/dq/runs/{run_id}
# ---------------------------------------------------------------------------


class TestGetRun:
    def test_returns_seeded_run(self, client_and_ctx):
        client, user_id, run_id, *_ = client_and_ctx
        r = client.get(f"/api/dq/runs/{run_id}")
        assert r.status_code == 200
        body = r.json()
        assert body["id"] == run_id

    def test_returns_404_for_unknown_run(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.get("/api/dq/runs/999999")
        assert r.status_code == 404

    def test_response_has_status_field(self, client_and_ctx):
        client, user_id, run_id, *_ = client_and_ctx
        body = client.get(f"/api/dq/runs/{run_id}").json()
        assert "status" in body

    def test_response_has_run_kind_and_gate_metrics_fields(self, client_and_ctx):
        """Task 9: the router passes get_run's dict through as-is, so
        run_kind/gate_metrics (Task 1 / migration 043) must already be on
        the response without any router change. Fixture's run predates
        gate_metrics -- run_kind defaults to 'full', gate_metrics is null,
        not absent/erroring."""
        client, user_id, run_id, *_ = client_and_ctx
        body = client.get(f"/api/dq/runs/{run_id}").json()
        assert "run_kind" in body
        assert "gate_metrics" in body
        assert body["run_kind"] == "full"
        assert body["gate_metrics"] is None

    def test_gate_metrics_set_on_run_surfaces_via_get(self, client_and_ctx):
        """A non-null gate_metrics round-trips through GET /runs/{id} once set."""
        from backend.db import dq_runs_repo

        client, user_id, run_id, *_ = client_and_ctx
        metrics = {"tripped": True, "reasons": ["3 novel duplicates"], "novel_total": 3}
        dq_runs_repo.set_gate_metrics(run_id, metrics)

        body = client.get(f"/api/dq/runs/{run_id}").json()
        assert body["gate_metrics"] == metrics


# ---------------------------------------------------------------------------
# GET /api/dq/runs/{run_id}/detail
# ---------------------------------------------------------------------------


class TestRunDetail:
    """Tests for the rich run-detail endpoint backing the History tab."""

    def test_detail_shape_with_observation_and_recommendation(self, client_and_ctx):
        """Fixture seeds one run + one observation + one recommendation;
        assert the full response shape, including the rec join on the obs."""
        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        r = client.get(f"/api/dq/runs/{run_id}/detail")
        assert r.status_code == 200
        body = r.json()

        assert set(body.keys()) == {"run", "observations", "events_summary"}

        # run: the same dict get_run returns, including the newer telemetry columns.
        assert body["run"]["id"] == run_id
        for key in ("failure_reason", "llm_cost_usd", "observations_written",
                    "recommendations_written", "status"):
            assert key in body["run"]

        # observations: fixture's single obs, enriched with its rec.
        assert len(body["observations"]) == 1
        obs = body["observations"][0]
        assert obs["id"] == obs_id
        for key in ("id", "tag", "entity_type", "entity_id", "issue_type",
                    "severity", "observation", "scope_citation", "recommendation"):
            assert key in obs
        assert obs["recommendation"] is not None
        assert obs["recommendation"]["id"] == rec_id
        assert obs["recommendation"]["action_type"] == "edit_prompt"
        assert obs["recommendation"]["headline"] == "Test headline"
        assert obs["recommendation"]["self_classification"] == "judgment"
        assert obs["recommendation"]["status"] == "pending"

        # events_summary: no events seeded for this run in the fixture.
        assert body["events_summary"]["count"] == 0

    def test_observation_without_recommendation_returns_null(self, client_and_ctx):
        """An observation with no linked recommendation has recommendation=None."""
        from backend.db import dq_observations_repo

        client, user_id, run_id, *_ = client_and_ctx
        dq_observations_repo.create_observation(
            user_id=user_id,
            run_id=run_id,
            tag="adjacent",
            entity_type="page",
            entity_id="unrecced",
            issue_type="reversal_pattern",
            observation="No recommendation attached.",
            severity="info",
            scope_citation="S2",
        )

        body = client.get(f"/api/dq/runs/{run_id}/detail").json()
        obs = next(o for o in body["observations"] if o["entity_id"] == "unrecced")
        assert obs["recommendation"] is None

    def test_404_for_unknown_run(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.get("/api/dq/runs/999999/detail")
        assert r.status_code == 404

    def test_404_for_foreign_run(self, client_and_ctx):
        """A run owned by a different user must 404, not leak."""
        import uuid

        from backend.db import dq_runs_repo, user_repo
        from backend.db.connection import set_current_user_id

        client, user_id, *_ = client_and_ctx

        unique_email = f"other-{uuid.uuid4().hex[:8]}@localhost"
        user_b = user_repo.create_user(unique_email, name="Other User")
        set_current_user_id(user_b["id"])
        run_b = dq_runs_repo.start_run(user_id=user_b["id"], trigger="manual")
        set_current_user_id(user_id)

        r = client.get(f"/api/dq/runs/{run_b['id']}/detail")
        assert r.status_code == 404

    def test_zero_events_summary_counts_and_null_result(self, client_and_ctx):
        """A run with no dq_run_events rows: count=0, timestamps null, result null."""
        client, user_id, run_id, *_ = client_and_ctx
        body = client.get(f"/api/dq/runs/{run_id}/detail").json()
        summary = body["events_summary"]
        assert summary["count"] == 0
        assert summary["first_at"] is None
        assert summary["last_at"] is None
        assert summary["phases"] == []
        assert summary["result"] is None

    def test_phases_and_result_extracted_from_seeded_events(self, client_and_ctx):
        """Seed a '_phase' event + a terminal 'result' event; assert both surface."""
        from backend.db import dq_run_events_repo
        from backend.db.connection import set_current_user_id

        client, user_id, run_id, *_ = client_and_ctx
        set_current_user_id(user_id)

        dq_run_events_repo.append_event(
            user_id=user_id, run_id=run_id, seq=0, event_type="_phase",
            payload={
                "type": "_phase", "subtype": "investigator_start",
                "name": "reversal_pattern_investigator", "candidates": 12,
            },
        )
        dq_run_events_repo.append_event(
            user_id=user_id, run_id=run_id, seq=1, event_type="_phase",
            payload={"type": "_phase", "subtype": "investigator_done"},
        )
        dq_run_events_repo.append_event(
            user_id=user_id, run_id=run_id, seq=2, event_type="result",
            payload={
                "type": "result", "subtype": "success", "is_error": False,
                "total_cost_usd": 0.1234, "num_turns": 7, "duration_ms": 8500,
            },
        )

        body = client.get(f"/api/dq/runs/{run_id}/detail").json()
        summary = body["events_summary"]

        assert summary["count"] == 3
        assert summary["first_at"] is not None
        assert summary["last_at"] is not None

        assert len(summary["phases"]) == 2
        first_phase, second_phase = summary["phases"]
        assert first_phase["subtype"] == "investigator_start"
        assert first_phase["name"] == "reversal_pattern_investigator"
        assert first_phase["candidates"] == 12
        assert "at" in first_phase
        assert second_phase["subtype"] == "investigator_done"
        assert "name" not in second_phase

        assert summary["result"] is not None
        assert summary["result"]["total_cost_usd"] == 0.1234
        assert summary["result"]["num_turns"] == 7
        assert summary["result"]["duration_s"] == 8.5

    def test_observations_and_phases_are_capped(self, client_and_ctx):
        """observations capped at 100, phases capped at 50 per the endpoint contract."""
        from backend.db import dq_observations_repo, dq_run_events_repo
        from backend.db.connection import set_current_user_id

        client, user_id, run_id, *_ = client_and_ctx
        set_current_user_id(user_id)

        for i in range(105):
            dq_observations_repo.create_observation(
                user_id=user_id,
                run_id=run_id,
                tag="core",
                entity_type="page",
                entity_id=f"cap_{i}",
                issue_type="reversal_pattern",
                observation=f"cap obs {i}",
                severity="info",
                scope_citation="S1",
            )
        for i in range(55):
            dq_run_events_repo.append_event(
                user_id=user_id, run_id=run_id, seq=i, event_type="_phase",
                payload={"type": "_phase", "subtype": "agent_starting"},
            )

        body = client.get(f"/api/dq/runs/{run_id}/detail").json()
        assert len(body["observations"]) <= 100
        assert len(body["events_summary"]["phases"]) <= 50
        # count reflects the true total, not the capped phases list
        assert body["events_summary"]["count"] == 55


# ---------------------------------------------------------------------------
# GET /api/dq/recommendations
# ---------------------------------------------------------------------------


class TestListRecommendations:
    def test_default_limit_five(self, client_and_ctx):
        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        from backend.db import dq_observations_repo, dq_recommendations_repo

        # Seed 7 recs total (1 from fixture + 6 more)
        for rank in range(2, 8):
            obs_extra = dq_observations_repo.create_observation(
                user_id=user_id,
                run_id=run_id,
                tag="core",
                entity_type="page",
                entity_id=str(900 + rank),
                issue_type="reversal_pattern",
                observation=f"obs {rank}",
                severity="info",
                scope_citation="S1",
            )
            dq_recommendations_repo.create_recommendation(
                user_id=user_id,
                run_id=run_id,
                observation_id=obs_extra["id"],
                action_type="flag_for_review",
                headline=f"rec {rank}",
                rationale="...",
                self_classification="trivial",
                rank_in_run=rank,
                affected_entity_type="page",
                affected_entity_ids=[str(900 + rank)],
            )
        r = client.get("/api/dq/recommendations")
        assert r.status_code == 200
        body = r.json()
        # Default limit=5 means at most 5 rows
        assert body["total"] <= 5

    def test_include_ranks_above_returns_more(self, client_and_ctx):
        client, *_ = client_and_ctx
        r_default = client.get("/api/dq/recommendations")
        r_all = client.get("/api/dq/recommendations?include_ranks_above=true")
        assert r_all.status_code == 200
        # When all > default limit, include_ranks_above should return more
        assert r_all.json()["total"] >= r_default.json()["total"]

    def test_response_shape(self, client_and_ctx):
        client, *_ = client_and_ctx
        body = client.get("/api/dq/recommendations").json()
        assert "recommendations" in body
        assert "total" in body

    def test_recommendations_default_excludes_superseded(self, client_and_ctx):
        """Default GET (no include_superseded) must NOT return status='superseded' rows.

        Preserves the inbox contract: existing callers must continue to see only
        pending recs even when superseded rows exist in the DB.
        """
        from backend.db import dq_recommendations_repo

        client, user_id, run_id, obs_id, _ = client_and_ctx

        # Seed a separate pending rec, then supersede it via the repo's atomic
        # supersede() helper (mirrors the live promote_recommendation flow).
        old_rec = dq_recommendations_repo.create_recommendation(
            user_id=user_id, run_id=run_id, observation_id=obs_id,
            action_type="edit_prompt", headline="old superseded headline",
            rationale="...", self_classification="trivial",
            rank_in_run=42, affected_entity_type="global",
            affected_entity_ids=[],
        )
        dq_recommendations_repo.supersede(
            old_rec_id=old_rec["id"],
            new_payload={
                "user_id": user_id, "run_id": run_id, "observation_id": obs_id,
                "action_type": "edit_prompt", "headline": "new replacement",
                "rationale": "...", "self_classification": "trivial",
                "rank_in_run": 43, "affected_entity_type": "global",
                "affected_entity_ids": [], "outlier_signals": None,
            },
        )

        # Default endpoint -- no include_superseded query param
        r = client.get("/api/dq/recommendations?include_ranks_above=true")
        assert r.status_code == 200
        recs = r.json()["recommendations"]
        statuses = {rec["status"] for rec in recs}
        assert "superseded" not in statuses, (
            f"Default endpoint must not return superseded rows; got statuses={statuses}"
        )
        # The old rec id must not appear anywhere
        ids = {rec["id"] for rec in recs}
        assert old_rec["id"] not in ids

    def test_recommendations_include_superseded_query_param_works(self, client_and_ctx):
        """GET ?include_superseded=true returns superseded rows with superseded_by set."""
        from backend.db import dq_recommendations_repo

        client, user_id, run_id, obs_id, _ = client_and_ctx

        old_rec = dq_recommendations_repo.create_recommendation(
            user_id=user_id, run_id=run_id, observation_id=obs_id,
            action_type="edit_prompt", headline="will be superseded",
            rationale="...", self_classification="trivial",
            rank_in_run=44, affected_entity_type="global",
            affected_entity_ids=[],
        )
        new_rec = dq_recommendations_repo.supersede(
            old_rec_id=old_rec["id"],
            new_payload={
                "user_id": user_id, "run_id": run_id, "observation_id": obs_id,
                "action_type": "edit_prompt", "headline": "the replacement",
                "rationale": "...", "self_classification": "trivial",
                "rank_in_run": 45, "affected_entity_type": "global",
                "affected_entity_ids": [], "outlier_signals": None,
            },
        )

        r = client.get(
            "/api/dq/recommendations?include_ranks_above=true&include_superseded=true"
        )
        assert r.status_code == 200
        recs = r.json()["recommendations"]

        # The superseded rec is in the response, with superseded_by pointing to the new id
        old_in_resp = next((rec for rec in recs if rec["id"] == old_rec["id"]), None)
        assert old_in_resp is not None, (
            f"Expected old rec id={old_rec['id']} in include_superseded response"
        )
        assert old_in_resp["status"] == "superseded"
        assert old_in_resp["superseded_by"] == new_rec["id"]


# ---------------------------------------------------------------------------
# PATCH /api/dq/recommendations/{rec_id}
# ---------------------------------------------------------------------------


class TestPatchRecommendation:
    def test_approve_changes_status(self, client_and_ctx):
        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        r = client.patch(
            f"/api/dq/recommendations/{rec_id}",
            json={"status": "approved"},
        )
        assert r.status_code == 200
        assert r.json()["status"] == "approved"

    def test_reject_with_note(self, client_and_ctx):
        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        r = client.patch(
            f"/api/dq/recommendations/{rec_id}",
            json={"status": "rejected", "user_note": "false positive"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "rejected"
        assert body["user_note"] == "false positive"

    def test_snooze_allowed(self, client_and_ctx):
        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        r = client.patch(
            f"/api/dq/recommendations/{rec_id}",
            json={"status": "snoozed"},
        )
        assert r.status_code == 200
        assert r.json()["status"] == "snoozed"

    def test_invalid_status_returns_400(self, client_and_ctx):
        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        r = client.patch(
            f"/api/dq/recommendations/{rec_id}",
            json={"status": "superseded"},  # not allowed via this endpoint
        )
        assert r.status_code == 400

    def test_unknown_id_returns_404(self, client_and_ctx):
        """PATCH on a rec_id that doesn't exist returns 404, not 500."""
        client, _user_id, *_ = client_and_ctx
        r = client.patch(
            "/api/dq/recommendations/999999",
            json={"status": "approved"},
        )
        assert r.status_code == 404


class TestPatchRecommendationApplies:
    """PATCH approve invokes the apply layer (dqBot Tier 1, spec S5) and
    surfaces the outcome as `applied_detail` on the response + DB row."""

    def test_approve_relabel_applies_and_returns_applied_detail(self, client_and_ctx):
        """Approve on a rec with a resolvable relabel_cluster payload updates
        the current-gen cluster_name now, creates a pin_label override, and
        the response/DB row carry applied_detail + applied_at."""
        from backend.db import cluster_repo, dq_recommendations_repo, recluster_repo
        from backend.db.connection import get_conn

        client, user_id, run_id, obs_id, _ = client_and_ctx

        r_run_id = recluster_repo.start_run(user_id)
        recluster_repo.complete_run(
            r_run_id, cluster_count=1, noise_count=0, naming_cost=0.0, elapsed_seconds=0.1,
        )
        cluster_repo.save_clusters(
            user_id, r_run_id,
            [{"cluster_slug": "api-relabel", "cluster_name": "Old Name", "stable_id": "api-sid-1"}],
        )

        rec = dq_recommendations_repo.create_recommendation(
            user_id=user_id, run_id=run_id, observation_id=obs_id,
            action_type="relabel_cluster", headline="relabel headline",
            rationale="r", self_classification="trivial", rank_in_run=50,
            affected_entity_type="cluster", affected_entity_ids=["api-sid-1"],
            action_payload={"stable_id": "api-sid-1", "proposed_label": "New Name"},
        )

        r = client.patch(
            f"/api/dq/recommendations/{rec['id']}",
            json={"status": "approved"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "approved"
        assert body["applied_detail"] is not None
        assert body["applied_detail"]["applied"] is True
        assert body["applied_detail"]["action"] == "relabel_cluster"
        assert body["applied_at"] is not None

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT applied_at, applied_detail, cluster_name FROM dq_recommendations r "
                "JOIN clusters c ON c.stable_id = 'api-sid-1' AND c.user_id = r.user_id "
                "WHERE r.id = %s",
                (rec["id"],),
            )
            applied_at, applied_detail, cluster_name = cur.fetchone()
            assert applied_at is not None
            assert applied_detail["applied"] is True
            assert cluster_name == "New Name"

    def test_approve_payload_less_rec_succeeds_record_only(self, client_and_ctx):
        """The fixture's default rec (action_type='edit_prompt', no
        action_payload) still approves successfully -- apply degrades to a
        record-only detail rather than blocking or failing the PATCH."""
        client, user_id, run_id, obs_id, rec_id = client_and_ctx

        r = client.patch(
            f"/api/dq/recommendations/{rec_id}",
            json={"status": "approved"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "approved"
        assert body["applied_detail"] is not None
        assert body["applied_detail"]["applied"] is False
        assert body["applied_detail"]["reason"].startswith("record-only")


# ---------------------------------------------------------------------------
# POST /api/dq/recommendations/{rec_id}/promote
# ---------------------------------------------------------------------------


class TestPromoteRecommendation:
    def test_promote_known_rec_returns_200(self, client_and_ctx):
        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        r = client.post(f"/api/dq/recommendations/{rec_id}/promote")
        assert r.status_code == 200
        body = r.json()
        assert body["id"] == rec_id
        # promoted_at should now be set in the DB (schema-backed, not marker-only)
        assert body.get("promoted_at") is not None

    def test_promote_sets_promoted_at_in_db(self, client_and_ctx):
        """After promote, the DB row has promoted_at non-null (real schema backing)."""
        from backend.db import dq_recommendations_repo
        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        r = client.post(f"/api/dq/recommendations/{rec_id}/promote")
        assert r.status_code == 200
        # Verify DB via a direct list_pending call (promoted rec should be first)
        rows = dq_recommendations_repo.list_pending(user_id=user_id, limit=5)
        assert len(rows) >= 1
        assert rows[0]["id"] == rec_id
        assert rows[0]["promoted_at"] is not None

    def test_promoted_rec_surfaces_to_inbox_top(self, client_and_ctx):
        """Promote a rank-8 rec; it should appear first in GET /api/dq/recommendations."""
        from backend.db import dq_observations_repo, dq_recommendations_repo
        client, user_id, run_id, obs_id, _ = client_and_ctx

        # Seed 9 more recs (ranks 2-10) so we have 10 total
        seeded_ids = []
        for rank in range(2, 11):
            extra = dq_recommendations_repo.create_recommendation(
                user_id=user_id,
                run_id=run_id,
                observation_id=obs_id,
                action_type="edit_prompt",
                headline=f"Test headline rank {rank}",
                rationale="rationale",
                self_classification="trivial",
                rank_in_run=rank,
                affected_entity_type="global",
                affected_entity_ids=[],
            )
            seeded_ids.append((rank, extra["id"]))

        # Find the rec with rank 8
        rank8_id = next(rid for rk, rid in seeded_ids if rk == 8)

        # Promote it
        r = client.post(f"/api/dq/recommendations/{rank8_id}/promote")
        assert r.status_code == 200

        # GET top-5 -- promoted rec should be first
        r2 = client.get("/api/dq/recommendations?limit=5")
        assert r2.status_code == 200
        recs = r2.json()["recommendations"]
        assert len(recs) >= 1
        assert recs[0]["id"] == rank8_id

    def test_promote_unknown_rec_returns_404(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.post("/api/dq/recommendations/999999/promote")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/dq/observations
# ---------------------------------------------------------------------------


class TestListObservations:
    def test_no_filters_returns_all(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.get("/api/dq/observations")
        assert r.status_code == 200
        body = r.json()
        assert "observations" in body
        assert body["total"] >= 1

    def test_tag_filter_core(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.get("/api/dq/observations?tag=core")
        assert r.status_code == 200
        body = r.json()
        for obs in body["observations"]:
            assert obs["tag"] == "core"

    def test_has_handoff_true_returns_only_with_draft(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.get("/api/dq/observations?has_handoff=true")
        assert r.status_code == 200
        body = r.json()
        for obs in body["observations"]:
            assert obs["handoff_prompt_draft"] is not None

    def test_has_handoff_false_returns_only_without_draft(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.get("/api/dq/observations?has_handoff=false")
        assert r.status_code == 200
        body = r.json()
        for obs in body["observations"]:
            assert obs["handoff_prompt_draft"] is None


# ---------------------------------------------------------------------------
# PATCH /api/dq/observations/{obs_id}/handoff-status
# ---------------------------------------------------------------------------


class TestPatchHandoffStatus:
    def test_mark_sent(self, client_and_ctx):
        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        r = client.patch(
            f"/api/dq/observations/{obs_id}/handoff-status",
            json={"status": "sent"},
        )
        assert r.status_code == 200
        assert r.json()["handoff_status"] == "sent"

    def test_mark_dismissed(self, client_and_ctx):
        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        r = client.patch(
            f"/api/dq/observations/{obs_id}/handoff-status",
            json={"status": "dismissed"},
        )
        assert r.status_code == 200
        assert r.json()["handoff_status"] == "dismissed"

    def test_invalid_status_returns_400(self, client_and_ctx):
        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        r = client.patch(
            f"/api/dq/observations/{obs_id}/handoff-status",
            json={"status": "pending"},  # not a valid handoff status
        )
        assert r.status_code == 400

    def test_unknown_id_returns_404(self, client_and_ctx):
        """PATCH handoff-status on an obs_id that doesn't exist returns 404, not 500."""
        client, _user_id, *_ = client_and_ctx
        r = client.patch(
            "/api/dq/observations/999999/handoff-status",
            json={"status": "sent"},
        )
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/dq/calibration
# ---------------------------------------------------------------------------


class TestCalibration:
    def test_returns_new_shape(self, client_and_ctx):
        """Calibration endpoint returns {by_action_type, overall} shape."""
        client, *_ = client_and_ctx
        r = client.get("/api/dq/calibration")
        assert r.status_code == 200
        body = r.json()
        assert "by_action_type" in body
        assert "overall" in body
        # overall still has the backward-compat keys
        overall_keys = {"approved", "rejected", "superseded", "snoozed", "dismissed", "total", "approval_rate"}
        assert overall_keys.issubset(body["overall"].keys())

    def test_overall_approval_rate_is_float(self, client_and_ctx):
        client, *_ = client_and_ctx
        body = client.get("/api/dq/calibration").json()
        assert isinstance(body["overall"]["approval_rate"], (int, float))

    def test_by_action_type_grouping(self, client_and_ctx):
        """Seed recs across 2 action_types with mixed statuses; assert correct grouping."""
        from backend.db import dq_recommendations_repo
        from backend.db.connection import get_conn, set_current_user_id

        client, user_id, run_id, obs_id, _ = client_and_ctx
        set_current_user_id(user_id)

        # Create 3 edit_prompt recs and approve 2, reject 1
        for i in range(3):
            rec = dq_recommendations_repo.create_recommendation(
                user_id=user_id,
                run_id=run_id,
                observation_id=obs_id,
                action_type="edit_prompt",
                headline=f"ep headline {i}",
                rationale="r",
                self_classification="trivial",
                rank_in_run=10 + i,
                affected_entity_type="global",
                affected_entity_ids=[],
            )
            status = "approved" if i < 2 else "rejected"
            dq_recommendations_repo.update_status(rec["id"], status)

        # Create 2 merge_clusters recs and approve 1, reject 1
        for i in range(2):
            rec = dq_recommendations_repo.create_recommendation(
                user_id=user_id,
                run_id=run_id,
                observation_id=obs_id,
                action_type="merge_clusters",
                headline=f"mc headline {i}",
                rationale="r",
                self_classification="judgment",
                rank_in_run=20 + i,
                affected_entity_type="cluster",
                affected_entity_ids=[],
            )
            status = "approved" if i == 0 else "rejected"
            dq_recommendations_repo.update_status(rec["id"], status)

        r = client.get("/api/dq/calibration")
        assert r.status_code == 200
        body = r.json()
        by_action = body["by_action_type"]

        # Build a lookup dict for easy assertions
        by_type = {entry["action_type"]: entry for entry in by_action}

        assert "edit_prompt" in by_type
        assert by_type["edit_prompt"]["approved"] == 2
        assert by_type["edit_prompt"]["rejected"] == 1
        assert by_type["edit_prompt"]["total_reviewed"] == 3
        assert abs(by_type["edit_prompt"]["approval_rate"] - 2 / 3) < 0.01

        assert "merge_clusters" in by_type
        assert by_type["merge_clusters"]["approved"] == 1
        assert by_type["merge_clusters"]["rejected"] == 1
        assert by_type["merge_clusters"]["total_reviewed"] == 2
        assert abs(by_type["merge_clusters"]["approval_rate"] - 0.5) < 0.01


# ---------------------------------------------------------------------------
# GET /api/dq/runs/{run_id}/events
# ---------------------------------------------------------------------------


class TestRunEvents:
    """Tests for the streaming event-log endpoint."""

    def _seed_events(self, user_id: int, run_id: int, count: int = 5) -> list[dict]:
        """Seed dq_run_events rows directly via the repo and return them."""
        from backend.db import dq_run_events_repo
        from backend.db.connection import set_current_user_id

        set_current_user_id(user_id)
        rows = []
        for seq in range(count):
            row = dq_run_events_repo.append_event(
                user_id=user_id,
                run_id=run_id,
                seq=seq,
                event_type="system" if seq == 0 else "assistant",
                payload={"type": "system" if seq == 0 else "assistant", "seq": seq},
            )
            rows.append(row)
        return rows

    def test_events_endpoint_returns_seeded_events(self, client_and_ctx):
        """GET /api/dq/runs/{run_id}/events returns all seeded events."""
        client, user_id, run_id, *_ = client_and_ctx
        self._seed_events(user_id, run_id, count=3)

        r = client.get(f"/api/dq/runs/{run_id}/events")
        assert r.status_code == 200
        body = r.json()
        assert "events" in body
        assert "latest_seq" in body
        assert "next_since" in body
        assert len(body["events"]) == 3

    def test_events_endpoint_respects_since(self, client_and_ctx):
        """GET with since=2 returns only events with seq > 2."""
        client, user_id, run_id, *_ = client_and_ctx
        self._seed_events(user_id, run_id, count=5)

        r = client.get(f"/api/dq/runs/{run_id}/events?since=2")
        assert r.status_code == 200
        body = r.json()
        events = body["events"]
        # Seeded seqs 0..4; since=2 means seq > 2, so seqs 3 and 4
        assert len(events) == 2
        for ev in events:
            assert ev["seq"] > 2

    def test_events_endpoint_empty_when_since_at_max(self, client_and_ctx):
        """GET with since=<last_seq> returns empty events list."""
        client, user_id, run_id, *_ = client_and_ctx
        self._seed_events(user_id, run_id, count=3)

        # Max seq is 2 (seqs 0,1,2); since=2 returns only seqs > 2 = nothing
        r = client.get(f"/api/dq/runs/{run_id}/events?since=2")
        assert r.status_code == 200
        body = r.json()
        assert len(body["events"]) == 0

    def test_events_endpoint_returns_correct_next_since(self, client_and_ctx):
        """next_since matches latest_seq after fetching events."""
        client, user_id, run_id, *_ = client_and_ctx
        self._seed_events(user_id, run_id, count=4)

        r = client.get(f"/api/dq/runs/{run_id}/events?since=-1")
        body = r.json()
        assert body["latest_seq"] == 3  # seqs 0..3, max=3
        assert body["next_since"] == 3


# ---------------------------------------------------------------------------
# outlier_signals round-trip and render tests
# ---------------------------------------------------------------------------


class TestOutlierSignals:
    """Tests for outlier_signals: repo round-trip and frontend render layer."""

    def test_create_rec_persists_outlier_signals(self, client_and_ctx):
        """Pass outlier_signals to create_recommendation, fetch back, assert round-trip."""
        from backend.db import dq_observations_repo, dq_recommendations_repo

        client, user_id, run_id, obs_id, _ = client_and_ctx

        signals = {"labels": ["70 duplicates (median 4)", "all placeholder summaries"]}
        rec = dq_recommendations_repo.create_recommendation(
            user_id=user_id,
            run_id=run_id,
            observation_id=obs_id,
            action_type="dedupe",
            headline="Dedupe outlier rec",
            rationale="This cluster has an unusually large dupe set.",
            self_classification="judgment",
            rank_in_run=99,
            affected_entity_type="cluster",
            affected_entity_ids=["10", "11", "12"],
            outlier_signals=signals,
        )

        assert rec["outlier_signals"] is not None
        assert rec["outlier_signals"]["labels"] == signals["labels"]

    def test_list_pending_includes_outlier_signals(self, client_and_ctx):
        """Seed a rec with signals, call list_pending, assert signals present in the dict."""
        from backend.db import dq_recommendations_repo

        client, user_id, run_id, obs_id, _ = client_and_ctx

        signals = {"labels": ["23 pages (median 5)", "arxiv-heavy (78% single domain)"]}
        created = dq_recommendations_repo.create_recommendation(
            user_id=user_id,
            run_id=run_id,
            observation_id=obs_id,
            action_type="split_cluster",
            headline="Split outlier cluster",
            rationale="Unusually large cluster with domain skew.",
            self_classification="trivial",
            rank_in_run=2,
            affected_entity_type="cluster",
            affected_entity_ids=["42"],
            outlier_signals=signals,
        )

        rows = dq_recommendations_repo.list_pending(user_id=user_id, limit=50)
        match = next((r for r in rows if r["id"] == created["id"]), None)
        assert match is not None, "Seeded rec not found in list_pending result"
        assert match["outlier_signals"] is not None
        assert match["outlier_signals"]["labels"] == signals["labels"]

    def test_rec_without_signals_returns_null(self, client_and_ctx):
        """Legacy recs (no outlier_signals) return None/null -- not an error."""
        from backend.db import dq_recommendations_repo

        client, user_id, run_id, obs_id, rec_id = client_and_ctx

        rows = dq_recommendations_repo.list_pending(user_id=user_id, limit=50)
        # The seeded rec from fixture has no signals
        seeded = next((r for r in rows if r["id"] == rec_id), None)
        assert seeded is not None
        assert seeded.get("outlier_signals") is None


# ---------------------------------------------------------------------------
# GET /api/dq/runs (Task 7.3 -- runs-history pane)
# ---------------------------------------------------------------------------


class TestListRunsForHistory:
    """The right-pane History tab calls GET /api/dq/runs to render past runs."""

    def test_get_runs_returns_ordered_runs_for_user(self, client_and_ctx):
        """Seed 3 runs with different started_at; assert response ordered most-recent-first.

        Also asserts findings_count is computed correctly via the LEFT JOIN.
        """
        from backend.db import dq_observations_repo, dq_runs_repo
        from backend.db.connection import get_conn

        client, user_id, run_id, obs_id, _ = client_and_ctx

        # The fixture seeded one run + one observation; that run's findings_count
        # should be 1. Add 2 more runs with backdated started_at and different
        # observation counts to verify ordering and counts together.
        run_b = dq_runs_repo.start_run(user_id=user_id, trigger="schedule")
        run_c = dq_runs_repo.start_run(user_id=user_id, trigger="manual")

        # Backdate run_b to 2 days ago, run_c to 1 day ago (so the fixture's
        # run is still the newest). Also add 2 obs to run_c.
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE dq_runs SET started_at = NOW() - INTERVAL '2 days' WHERE id = %s",
                (run_b["id"],),
            )
            cur.execute(
                "UPDATE dq_runs SET started_at = NOW() - INTERVAL '1 day' WHERE id = %s",
                (run_c["id"],),
            )
        for i in range(2):
            dq_observations_repo.create_observation(
                user_id=user_id,
                run_id=run_c["id"],
                tag="core",
                entity_type="page",
                entity_id=f"hist_{i}",
                issue_type="reversal_pattern",
                observation=f"hist obs {i}",
                severity="info",
                scope_citation="S1",
            )

        r = client.get("/api/dq/runs")
        assert r.status_code == 200
        body = r.json()
        assert isinstance(body, list)
        # 3 runs total (fixture + run_b + run_c)
        assert len(body) == 3

        # Newest first: fixture's run_id, then run_c, then run_b
        ids = [row["id"] for row in body]
        assert ids == [run_id, run_c["id"], run_b["id"]], (
            f"Expected runs ordered newest-first as {[run_id, run_c['id'], run_b['id']]}, got {ids}"
        )

        # findings_count: fixture run has 1 obs, run_c has 2, run_b has 0
        by_id = {row["id"]: row for row in body}
        assert by_id[run_id]["findings_count"] == 1
        assert by_id[run_c["id"]]["findings_count"] == 2
        assert by_id[run_b["id"]]["findings_count"] == 0

        # Other expected fields are present
        for row in body:
            assert "trigger" in row
            assert "started_at" in row
            assert "completed_at" in row
            assert "status" in row

    def test_get_runs_excludes_other_users_runs(self, client_and_ctx):
        """Runs owned by a different user must not appear in the response."""
        import uuid

        from backend.db import dq_runs_repo, user_repo
        from backend.db.connection import set_current_user_id

        client, user_id, run_id, *_ = client_and_ctx

        # Seed a second user and a run for them. Email is uuid-suffixed so this
        # test is idempotent across re-runs (the fixture only truncates dq_* --
        # users table is preserved, so a fixed email would UniqueViolation).
        # Switch the RLS context so the INSERT goes through under user_b's
        # policy, then restore.
        unique_email = f"other-{uuid.uuid4().hex[:8]}@localhost"
        user_b = user_repo.create_user(unique_email, name="Other User")
        set_current_user_id(user_b["id"])
        run_b = dq_runs_repo.start_run(user_id=user_b["id"], trigger="manual")
        set_current_user_id(user_id)  # restore for the API call's repo accesses

        r = client.get("/api/dq/runs")
        assert r.status_code == 200
        body = r.json()
        ids = [row["id"] for row in body]
        assert run_id in ids, "fixture's own run must appear"
        assert run_b["id"] not in ids, (
            f"Expected run_b ({run_b['id']}) to be excluded from user A's history; got {ids}"
        )

    def test_get_runs_respects_limit(self, client_and_ctx):
        """?limit=2 returns at most 2 rows, regardless of total seeded."""
        from backend.db import dq_runs_repo

        client, user_id, *_ = client_and_ctx

        # Fixture seeded 1 run; add 4 more so we have 5 total.
        for _ in range(4):
            dq_runs_repo.start_run(user_id=user_id, trigger="manual")

        r = client.get("/api/dq/runs?limit=2")
        assert r.status_code == 200
        body = r.json()
        assert len(body) == 2

    def test_get_runs_caps_limit_at_max(self, client_and_ctx):
        """?limit=999999 is clamped to the server-side max (100)."""
        client, *_ = client_and_ctx
        r = client.get("/api/dq/runs?limit=999999")
        assert r.status_code == 200
        body = r.json()
        # Fixture only seeded 1 run; cap doesn't grow data, just ensures no 500
        assert isinstance(body, list)
        assert len(body) <= 100

    def test_runs_list_includes_run_kind_and_gate_metrics(self, client_and_ctx):
        """Task 9: list_runs_for_user's run_kind/gate_metrics columns (Task 1 /
        migration 043) must appear on every row of the list payload, not just
        the single-run GET. Router passes list_runs_for_user's dicts through
        as-is -- this asserts that pass-through holds, not just documents it."""
        client, *_ = client_and_ctx
        r = client.get("/api/dq/runs")
        assert r.status_code == 200
        body = r.json()
        assert len(body) >= 1
        for row in body:
            assert "run_kind" in row
            assert "gate_metrics" in row
        assert body[0]["run_kind"] == "full"
        assert body[0]["gate_metrics"] is None


# ---------------------------------------------------------------------------
# Vocab endpoints (Phase 5 / migration 028)
# ---------------------------------------------------------------------------


def _seed_vocab(user_id: int, *, proposed: list[str] = (), canonical: list[str] = ()) -> None:
    """Insert proposed + canonical vocab entries for a test setup."""
    from backend.db import dq_vocab_repo

    for label in proposed:
        dq_vocab_repo.insert_proposal(user_id, label, rationale=None, run_id=None)
    for label in canonical:
        dq_vocab_repo.insert_proposal(user_id, label, rationale=None, run_id=None)
        embedding = get_sbert_model().encode(f"Description for {label}.").tolist()
        dq_vocab_repo.canonicalize(
            user_id=user_id, issue_type=label,
            description=f"Description for {label} (long enough).",
            embedding=embedding, canonicalized_by=user_id,
        )


def get_sbert_model():
    """Lazy import so the SBERT module is only loaded for tests that need it."""
    from backend.services.sbert_loader import get_sbert_model as _gs
    return _gs()


class TestVocabEndpoints:
    def test_list_groups_by_status(self, client_and_ctx):
        client, user_id, *_ = client_and_ctx
        # Add p1 (proposed) + c1 (canonical) on top of fixture's seed entries.
        # Truncating vocab would FK-violate the fixture's pre-seeded observation.
        _seed_vocab(user_id, proposed=["p1"], canonical=["c1"])

        r = client.get("/api/dq/vocab/list")
        assert r.status_code == 200
        body = r.json()
        assert {"pending", "canonical", "rejected"} <= body.keys()
        pending_labels = {e["issue_type"] for e in body["pending"]}
        canonical_labels = {e["issue_type"] for e in body["canonical"]}
        assert "p1" in pending_labels
        assert "c1" in canonical_labels

    def test_canonicalize_promotes_proposed(self, client_and_ctx):
        client, user_id, *_ = client_and_ctx
        _seed_vocab(user_id, proposed=["needs_canon"])

        r = client.post(
            "/api/dq/vocab/needs_canon/canonicalize",
            json={"description": "A 1-2 sentence description for testing the gate."},
        )
        assert r.status_code == 200, r.text
        from backend.db import dq_vocab_repo
        entry = dq_vocab_repo.lookup(user_id, "needs_canon")
        assert entry is not None
        assert entry.status == "canonical"
        assert entry.description.startswith("A 1-2")

    def test_canonicalize_rejects_short_description(self, client_and_ctx):
        client, user_id, *_ = client_and_ctx
        _seed_vocab(user_id, proposed=["short_desc"])
        r = client.post(
            "/api/dq/vocab/short_desc/canonicalize",
            json={"description": "too short"},
        )
        assert r.status_code == 400
        assert "10 character" in r.json()["detail"]

    def test_canonicalize_404_for_missing_entry(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.post(
            "/api/dq/vocab/never_existed/canonicalize",
            json={"description": "Long enough description for testing."},
        )
        assert r.status_code == 404

    def test_alias_rejects_non_canonical_target(self, client_and_ctx):
        client, user_id, *_ = client_and_ctx
        # Both src and tgt are merely proposed -- alias must point to canonical
        _seed_vocab(user_id, proposed=["src", "tgt_proposed_only"])
        r = client.post(
            "/api/dq/vocab/src/alias",
            json={"target": "tgt_proposed_only"},
        )
        assert r.status_code == 400
        assert "canonical" in r.json()["detail"]

    def test_alias_promotes_silent_rewrite(self, client_and_ctx):
        client, user_id, *_ = client_and_ctx
        _seed_vocab(user_id, proposed=["src"], canonical=["tgt_canon"])
        r = client.post(
            "/api/dq/vocab/src/alias",
            json={"target": "tgt_canon"},
        )
        assert r.status_code == 200, r.text
        from backend.db import dq_vocab_repo
        entry = dq_vocab_repo.lookup(user_id, "src")
        assert entry is not None
        assert entry.status == "rejected"
        assert entry.aliased_to == "tgt_canon"

    def test_reject_flips_status(self, client_and_ctx):
        client, user_id, *_ = client_and_ctx
        _seed_vocab(user_id, proposed=["to_reject"])
        r = client.post("/api/dq/vocab/to_reject/reject")
        assert r.status_code == 200
        from backend.db import dq_vocab_repo
        entry = dq_vocab_repo.lookup(user_id, "to_reject")
        assert entry is not None
        assert entry.status == "rejected"
        assert entry.aliased_to is None


# ---------------------------------------------------------------------------
# Overrides endpoints (dqBot Tier 1, spec S7 -- Worker O / Phase 3)
# ---------------------------------------------------------------------------


def _seed_current_gen_cluster(user_id: int, cluster_slug: str, cluster_name: str, stable_id: str | None = None):
    """Start+complete a recluster run with one cluster, return (run_id, cluster_db_id)."""
    from backend.db import cluster_repo, recluster_repo

    run_id = recluster_repo.start_run(user_id)
    recluster_repo.complete_run(
        run_id, cluster_count=1, noise_count=0, naming_cost=0.0, elapsed_seconds=0.1,
    )
    entry: dict = {"cluster_slug": cluster_slug, "cluster_name": cluster_name}
    if stable_id is not None:
        entry["stable_id"] = stable_id
    slug_to_id = cluster_repo.save_clusters(user_id, run_id, [entry])
    return run_id, slug_to_id[cluster_slug]


class TestOverridesEndpoints:
    def test_list_empty_when_no_overrides(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.get("/api/dq/overrides")
        assert r.status_code == 200
        assert r.json() == {"overrides": []}

    def test_pin_label_resolves_current_gen_name_and_headline(self, client_and_ctx):
        from backend.db import dq_overrides_repo

        client, user_id, run_id, obs_id, rec_id = client_and_ctx
        _seed_current_gen_cluster(user_id, "ov-resolve", "Resolved Name", stable_id="ov-sid-1")

        ov = dq_overrides_repo.create_override(
            user_id=user_id, override_type="pin_label",
            subject={"stable_id": "ov-sid-1"}, payload={"label": "Resolved Name"},
            source_rec_id=rec_id,
        )

        r = client.get("/api/dq/overrides")
        assert r.status_code == 200
        overrides = r.json()["overrides"]
        assert len(overrides) == 1
        entry = overrides[0]
        assert entry["id"] == ov["id"]
        assert entry["resolved"] == {"stable_id": "ov-sid-1", "cluster_name": "Resolved Name"}
        # rec_id here is the fixture's seeded rec, headline "Test headline"
        assert entry["source_headline"] == "Test headline"

    def test_exclude_from_cluster_dormant_when_stable_id_unmatched(self, client_and_ctx):
        from backend.db import dq_overrides_repo

        client, user_id, *_ = client_and_ctx
        ov = dq_overrides_repo.create_override(
            user_id=user_id, override_type="exclude_from_cluster",
            subject={"stable_id": "does-not-exist"}, payload={"page_content_ids": [1, 2]},
        )

        r = client.get("/api/dq/overrides")
        entry = next(o for o in r.json()["overrides"] if o["id"] == ov["id"])
        assert entry["resolved"] == {"stable_id": "does-not-exist", "dormant": True}
        assert entry["source_headline"] is None

    def test_merge_clusters_partial_dormant(self, client_and_ctx):
        from backend.db import dq_overrides_repo

        client, user_id, *_ = client_and_ctx
        _seed_current_gen_cluster(user_id, "merge-a", "Cooking", stable_id="merge-sid-a")

        ov = dq_overrides_repo.create_override(
            user_id=user_id, override_type="merge_clusters",
            subject={"stable_ids": ["merge-sid-a", "merge-sid-missing"]},
        )

        r = client.get("/api/dq/overrides")
        entry = next(o for o in r.json()["overrides"] if o["id"] == ov["id"])
        assert entry["resolved"]["names"] == {"merge-sid-a": "Cooking"}
        assert entry["resolved"]["dormant"] == ["merge-sid-missing"]

    def test_never_cocluster_resolved_is_null(self, client_and_ctx):
        from backend.db import dq_overrides_repo

        client, user_id, *_ = client_and_ctx
        ov = dq_overrides_repo.create_override(
            user_id=user_id, override_type="never_cocluster",
            subject={"page_content_id_a": 1, "page_content_id_b": 2},
        )

        r = client.get("/api/dq/overrides")
        entry = next(o for o in r.json()["overrides"] if o["id"] == ov["id"])
        assert entry["resolved"] is None

    def test_list_all_includes_retired(self, client_and_ctx):
        from backend.db import dq_overrides_repo

        client, user_id, *_ = client_and_ctx
        ov = dq_overrides_repo.create_override(
            user_id=user_id, override_type="pin_label",
            subject={"stable_id": "x"}, payload={"label": "y"},
        )
        dq_overrides_repo.retire(ov["id"], user_id)

        r = client.get("/api/dq/overrides")
        entry = next(o for o in r.json()["overrides"] if o["id"] == ov["id"])
        assert entry["status"] == "retired"


class TestRetireOverrideEndpoint:
    def test_retire_flips_status(self, client_and_ctx):
        from backend.db import dq_overrides_repo

        client, user_id, *_ = client_and_ctx
        ov = dq_overrides_repo.create_override(
            user_id=user_id, override_type="pin_label",
            subject={"stable_id": "x"}, payload={"label": "y"},
        )

        r = client.post(f"/api/dq/overrides/{ov['id']}/retire")
        assert r.status_code == 200
        assert r.json()["status"] == "retired"
        assert r.json()["id"] == ov["id"]

    def test_retire_unknown_id_returns_404(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.post("/api/dq/overrides/999999/retire")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Trends endpoints (Phase 5)
# ---------------------------------------------------------------------------


class TestTrendsEndpoints:
    def test_per_investigator_returns_diagnosis(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.get("/api/dq/trends/per-investigator")
        assert r.status_code == 200
        rows = r.json()
        assert isinstance(rows, list)
        if rows:
            sample = rows[0]
            assert "diagnosis" in sample
            assert sample["diagnosis"] in {
                "COMPENDIUM RESTRUCTURE", "DETECTION TUNING",
                "Noise (low cost)", "Healthy",
            }
            assert "observation_ids" in sample

    def test_per_cluster_filters_to_cluster_entities(self, client_and_ctx):
        """Per-cluster trends only count observations with entity_type='cluster'."""
        client, user_id, run_id, *_ = client_and_ctx
        # Seed a cluster-typed observation alongside the page-typed one from fixture
        from backend.db import dq_observations_repo, dq_vocab_repo
        dq_vocab_repo.insert_proposal(user_id, "domain_silo", None, None)
        dq_observations_repo.create_observation(
            user_id=user_id, run_id=run_id, tag="core",
            entity_type="cluster", entity_id="42", issue_type="domain_silo",
            observation="cluster-typed", severity="info", scope_citation="S3",
        )

        r = client.get("/api/dq/trends/per-cluster")
        assert r.status_code == 200
        rows = r.json()
        # Page-typed obs from fixture is filtered out; cluster-typed is included
        assert any("42" in (row.get("group_key") or "") for row in rows), rows

    def test_per_cluster_resolves_name_via_stable_id(self, client_and_ctx):
        """entity_id storing a stable_id (Tier 1, spec S1) resolves the real
        cluster_name via c.stable_id = o.entity_id, not the 'cluster <id>'
        fallback text."""
        from backend.db import dq_observations_repo, dq_vocab_repo

        client, user_id, run_id, *_ = client_and_ctx
        dq_vocab_repo.insert_proposal(user_id, "domain_silo", None, None)
        _seed_current_gen_cluster(user_id, "trend-sid", "Trend Cluster Name", stable_id="trend-sid-1")

        dq_observations_repo.create_observation(
            user_id=user_id, run_id=run_id, tag="core",
            entity_type="cluster", entity_id="trend-sid-1", issue_type="domain_silo",
            observation="stable-id-keyed", severity="info", scope_citation="S3",
        )

        r = client.get("/api/dq/trends/per-cluster")
        assert r.status_code == 200
        rows = r.json()
        assert any(row.get("group_key") == "Trend Cluster Name" for row in rows), rows

    def test_per_cluster_pre_tier1_integer_id_fallback(self, client_and_ctx):
        """entity_id still holding the legacy per-run integer id (no
        stable_id ever set on the cluster) resolves via the c.id::text OR
        fallback, not just the literal 'cluster <id>' text."""
        from backend.db import dq_observations_repo, dq_vocab_repo

        client, user_id, run_id, *_ = client_and_ctx
        dq_vocab_repo.insert_proposal(user_id, "domain_silo", None, None)
        _, cluster_db_id = _seed_current_gen_cluster(user_id, "legacy-cluster", "Legacy Name")

        dq_observations_repo.create_observation(
            user_id=user_id, run_id=run_id, tag="core",
            entity_type="cluster", entity_id=str(cluster_db_id), issue_type="domain_silo",
            observation="legacy-id-keyed", severity="info", scope_citation="S3",
        )

        r = client.get("/api/dq/trends/per-cluster")
        assert r.status_code == 200
        rows = r.json()
        assert any(row.get("group_key") == "Legacy Name" for row in rows), rows


# ---------------------------------------------------------------------------
# SQL receipt rerun endpoint (Phase 5)
# ---------------------------------------------------------------------------


class TestSqlRerunEndpoint:
    def test_rerun_executes_and_updates(self, client_and_ctx):
        """Observation with a stored SELECT gets re-run; columns update."""
        client, user_id, run_id, _obs_id_unused, *_ = client_and_ctx
        from backend.db import dq_observations_repo, dq_vocab_repo
        dq_vocab_repo.insert_proposal(user_id, "domain_silo", None, None)
        obs = dq_observations_repo.create_observation(
            user_id=user_id, run_id=run_id, tag="core",
            entity_type="cluster", entity_id="1", issue_type="domain_silo",
            observation="rerun test", severity="info",
            sql_query="SELECT id FROM clusters LIMIT 1",
            sql_query_description="smoke",
        )
        r = client.post(f"/api/dq/observations/{obs['id']}/sql/run")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] in ("ok", "empty", "error")
        # Column update propagated
        from backend.db.connection import get_conn
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT sql_query_status, sql_query_executed_at FROM dq_observations WHERE id = %s",
                (obs["id"],),
            )
            row = cur.fetchone()
        assert row[0] in ("ok", "empty", "error")
        assert row[1] is not None  # executed_at populated

    def test_rerun_404_for_missing_observation(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.post("/api/dq/observations/9999999/sql/run")
        assert r.status_code == 404

    def test_rerun_400_when_no_sql_stored(self, client_and_ctx):
        """Existing fixture observation has no sql_query -> 400, not 500."""
        client, _user_id, _run_id, obs_id, *_ = client_and_ctx
        r = client.post(f"/api/dq/observations/{obs_id}/sql/run")
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# Receipt endpoint (Phase 6)
# ---------------------------------------------------------------------------



class TestReceiptEndpoint:
    def test_receipt_returns_observation_and_recommendations(self, client_and_ctx):
        """GET /observations/{id}/receipt returns observation + linked recs."""
        client, _user_id, _run_id, obs_id, rec_id = client_and_ctx
        r = client.get(f"/api/dq/observations/{obs_id}/receipt")
        assert r.status_code == 200
        body = r.json()
        assert "observation" in body
        assert "recommendations" in body
        assert body["observation"]["id"] == obs_id
        # The fixture-seeded recommendation should be linked
        rec_ids = {rec["id"] for rec in body["recommendations"]}
        assert rec_id in rec_ids

    def test_receipt_returns_receipt_columns(self, client_and_ctx):
        """The new structured fields (evidence/reasoning/ambiguities) are surfaced."""
        client, _user_id, _run_id, obs_id, *_ = client_and_ctx
        r = client.get(f"/api/dq/observations/{obs_id}/receipt")
        body = r.json()
        obs = body["observation"]
        # Migration 028 default: empty items/steps lists for legacy observations
        assert "evidence" in obs and obs["evidence"] == {"items": []}
        assert "reasoning" in obs and obs["reasoning"] == {"steps": []}
        assert "ambiguities" in obs and obs["ambiguities"] == {"items": []}

    def test_receipt_404_for_missing_observation(self, client_and_ctx):
        client, *_ = client_and_ctx
        r = client.get("/api/dq/observations/9999999/receipt")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Task 8: /run-now enqueues; /abort sets DB flag (mock-based, no PG needed)
# ---------------------------------------------------------------------------


@pytest.fixture
def mocked_client():
    """TestClient with the auth dependencies overridden to return user_id=42.

    Scoped to the fixture so the override does not bleed into the PG-backed
    tests above (which rely on the dev-mode bypass, not on this override).

    All three auth dependencies are overridden, not just verify_api_key: the
    dq router carries a router-level verify_not_plain_demo gate and /run-now
    additionally requires verify_admin_context. Both would otherwise hit
    auth_repo.get_role() against the DB for the synthetic user 42 and 403.
    Authorization itself is covered by TestDqDemoGating below, so these
    tests stay focused on run/abort behavior.
    """
    from backend.api.main import (
        app,
        verify_admin_context,
        verify_api_key,
        verify_not_plain_demo,
    )

    deps = (verify_api_key, verify_not_plain_demo, verify_admin_context)
    for dep in deps:
        app.dependency_overrides[dep] = lambda: 42
    yield TestClient(app)
    for dep in deps:
        app.dependency_overrides.pop(dep, None)


class TestRunNowAbortMocked:
    def test_run_now_enqueues_and_returns_queued(self, mocked_client):
        with patch(
            "backend.api.routers.dq_bot.dq_runs_repo.enqueue",
            return_value={"id": 99, "user_id": 42, "trigger": "manual", "status": "queued"},
        ) as enq:
            resp = mocked_client.post("/api/dq/run-now")
        assert resp.status_code == 200
        assert resp.json() == {"run_id": 99, "status": "queued"}
        enq.assert_called_once_with(user_id=42, trigger="manual")

    def test_run_now_blocked_when_disabled(self, mocked_client, monkeypatch):
        monkeypatch.setenv("DQ_BOT_DISABLED", "1")
        resp = mocked_client.post("/api/dq/run-now")
        assert resp.status_code == 503

    def test_abort_sets_flag(self, mocked_client):
        with (
            patch(
                "backend.api.routers.dq_bot.dq_runs_repo.get_run",
                return_value={"id": 99, "status": "running"},
            ),
            patch("backend.api.routers.dq_bot.dq_runs_repo.request_abort") as req,
        ):
            resp = mocked_client.post("/api/dq/runs/99/abort")
        assert resp.status_code == 200
        assert resp.json() == {"run_id": 99, "status": "abort_requested"}
        req.assert_called_once_with(99)

    def test_abort_404_for_unknown_run(self, mocked_client):
        with patch("backend.api.routers.dq_bot.dq_runs_repo.get_run", return_value=None):
            resp = mocked_client.post("/api/dq/runs/1234/abort")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Demo-account containment (2026-08-26)
#
# The public demo credential (compendium.example.com) is printed on a resume,
# so it must not reach dqBot at all: findings, SQL receipts and run
# transcripts are derived from the REAL corpus, and /run-now spends Claude
# subscription quota by spawning a worker subprocess. These tests pin the
# router-level gate so a future route added to dq_bot.py inherits it rather
# than silently reopening the hole.
# ---------------------------------------------------------------------------


class TestDqDemoGating:
    @pytest.fixture
    def demo_client(self):
        """TestClient authenticated as a PLAIN demo session (role=demo, no
        acting_as_demo claim) -- the exact shape of a public demo login."""
        from backend.api.main import app, get_current_claims, verify_api_key

        app.dependency_overrides[verify_api_key] = lambda: 7
        app.dependency_overrides[get_current_claims] = lambda: {}
        with patch("backend.db.auth_repo.get_role", return_value="demo"):
            yield TestClient(app)
        app.dependency_overrides.pop(verify_api_key, None)
        app.dependency_overrides.pop(get_current_claims, None)

    def test_demo_cannot_trigger_a_run(self, demo_client):
        """/run-now spawns a Claude subprocess and has no rate limit."""
        with patch("backend.api.routers.dq_bot.dq_runs_repo.enqueue") as enq:
            resp = demo_client.post("/api/dq/run-now")
        assert resp.status_code == 403
        enq.assert_not_called()

    @pytest.mark.parametrize("path", ["/api/dq/runs", "/api/dq/recommendations", "/api/dq/observations"])
    def test_demo_cannot_read_dq_surfaces(self, demo_client, path):
        """Router-level gate covers reads too -- findings describe real data."""
        assert demo_client.get(path).status_code == 403

    def test_admin_context_reaches_run_now(self):
        """The gate rejects demo specifically, not everyone: an admin still runs."""
        from backend.api.main import app, get_current_claims, verify_api_key

        app.dependency_overrides[verify_api_key] = lambda: 1
        app.dependency_overrides[get_current_claims] = lambda: {}
        try:
            with patch("backend.db.auth_repo.get_role", return_value="admin"), patch(
                "backend.api.routers.dq_bot.dq_runs_repo.enqueue",
                return_value={"id": 5, "user_id": 1, "trigger": "manual", "status": "queued"},
            ):
                resp = TestClient(app).post("/api/dq/run-now")
            assert resp.status_code == 200
            assert resp.json() == {"run_id": 5, "status": "queued"}
        finally:
            app.dependency_overrides.pop(verify_api_key, None)
            app.dependency_overrides.pop(get_current_claims, None)
