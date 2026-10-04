"""Integration tests for backend/scripts/_archive/dq_queue_triage.py."""

import json

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import dq_observations_repo, dq_recommendations_repo, dq_runs_repo, user_repo
from backend.db.connection import get_conn
from backend.scripts._archive import dq_queue_triage


@pytest.fixture
def ctx():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE dq_recommendations CASCADE")
        cur.execute("TRUNCATE dq_observations CASCADE")
        cur.execute("TRUNCATE dq_runs CASCADE")
        cur.execute("TRUNCATE users CASCADE")
    uid = user_repo.create_user(email="triage@t.com", name="triage")["id"]
    run = dq_runs_repo.start_run(user_id=uid, trigger="manual")
    # Migration 028's FK from dq_observations.issue_type to the vocab table.
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
    return {"user_id": uid, "run_id": run["id"]}


def _make_obs(ctx, entity_id="1", handoff=False, user_id=None):
    kwargs = dict(
        user_id=user_id or ctx["user_id"],
        run_id=ctx["run_id"],
        tag="adjacent" if handoff else "core",
        entity_type="global" if handoff else "page",
        entity_id=entity_id,
        issue_type="reversal_pattern",
        observation="x",
        severity="info",
    )
    if handoff:
        kwargs["adjacency_contract_ref"] = "A1"
        kwargs["handoff_prompt_draft"] = "draft prompt text"
    else:
        kwargs["scope_citation"] = "S1"
    return dq_observations_repo.create_observation(**kwargs)


def _make_rec(ctx, obs_id, rank=1, user_id=None):
    return dq_recommendations_repo.create_recommendation(
        user_id=user_id or ctx["user_id"],
        run_id=ctx["run_id"],
        observation_id=obs_id,
        action_type="edit_prompt",
        headline="h",
        rationale="r",
        self_classification="judgment",
        rank_in_run=rank,
        affected_entity_type="global",
        affected_entity_ids=["x"],
    )


def _rec_entry(rec_id, obs_id, status="approved", bucket="RC-A", note="note"):
    return {
        "rec_id": rec_id,
        "obs_id": obs_id,
        "expected_prior_status": "pending",
        "status": status,
        "bucket": bucket,
        "user_note": note,
    }


def _handoff_entry(obs_id, note_bucket="consolidated"):
    return {"obs_id": obs_id, "handoff_status": "dismissed", "note_bucket": note_bucket}


def _write_manifest(tmp_path, recs, handoffs):
    manifest = {"recommendations": recs, "handoffs": handoffs, "meta": {"generated": "test"}}
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps(manifest))
    return p


def _fetch_rec(rec_id):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT status, user_note, reviewed_at FROM dq_recommendations WHERE id = %s",
            (rec_id,),
        )
        return cur.fetchone()


def _fetch_obs_handoff(obs_id):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT handoff_status FROM dq_observations WHERE id = %s", (obs_id,))
        return cur.fetchone()[0]


# ── recommendations: apply / skip / idempotency ────────────────────────────


def test_apply_updates_pending_recommendation(ctx):
    obs = _make_obs(ctx, entity_id="42")
    rec = _make_rec(ctx, obs["id"])
    entries = [_rec_entry(rec["id"], obs["id"], status="approved", note="approved via triage")]

    applied, skipped, user_ids = dq_queue_triage._process_recommendations(
        entries, apply=True, user_id_filter=None
    )

    assert len(applied) == 1
    assert len(skipped) == 0
    assert user_ids == {ctx["user_id"]}

    status, user_note, reviewed_at = _fetch_rec(rec["id"])
    assert status == "approved"
    assert user_note == "approved via triage"
    assert reviewed_at is not None


def test_dry_run_does_not_write(ctx):
    obs = _make_obs(ctx, entity_id="43")
    rec = _make_rec(ctx, obs["id"])
    entries = [_rec_entry(rec["id"], obs["id"], status="dismissed")]

    applied, skipped, _ = dq_queue_triage._process_recommendations(
        entries, apply=False, user_id_filter=None
    )

    assert len(applied) == 1  # would-apply, counted, but not written
    assert len(skipped) == 0

    status, user_note, reviewed_at = _fetch_rec(rec["id"])
    assert status == "pending"
    assert user_note is None
    assert reviewed_at is None


def test_skips_non_pending_row_without_clobbering(ctx):
    obs = _make_obs(ctx, entity_id="44")
    rec = _make_rec(ctx, obs["id"])
    # Row was already reviewed through another path (not by this script).
    dq_recommendations_repo.update_status(
        rec_id=rec["id"], new_status="rejected", user_note="reviewed elsewhere"
    )
    entries = [_rec_entry(rec["id"], obs["id"], status="approved", note="triage note")]

    applied, skipped, _ = dq_queue_triage._process_recommendations(
        entries, apply=True, user_id_filter=None
    )

    assert len(applied) == 0
    assert len(skipped) == 1
    assert skipped[0]["skip_reason"] == "status_mismatch"
    assert skipped[0]["found_status"] == "rejected"

    # Never clobbered.
    status, user_note, _ = _fetch_rec(rec["id"])
    assert status == "rejected"
    assert user_note == "reviewed elsewhere"


def test_second_apply_run_is_idempotent(ctx):
    obs = _make_obs(ctx, entity_id="45")
    rec = _make_rec(ctx, obs["id"])
    entries = [_rec_entry(rec["id"], obs["id"], status="approved")]

    applied1, skipped1, _ = dq_queue_triage._process_recommendations(
        entries, apply=True, user_id_filter=None
    )
    assert len(applied1) == 1
    assert len(skipped1) == 0

    applied2, skipped2, _ = dq_queue_triage._process_recommendations(
        entries, apply=True, user_id_filter=None
    )
    assert len(applied2) == 0
    assert len(skipped2) == 1
    assert skipped2[0]["skip_reason"] == "status_mismatch"
    assert skipped2[0]["found_status"] == "approved"


def test_missing_rec_id_is_skipped(ctx):
    entries = [_rec_entry(999_999_999, 1, status="approved")]

    applied, skipped, _ = dq_queue_triage._process_recommendations(
        entries, apply=True, user_id_filter=None
    )

    assert len(applied) == 0
    assert skipped[0]["skip_reason"] == "not_found"
    assert skipped[0]["found_status"] is None


# ── user-id filter guard ────────────────────────────────────────────────────


def test_user_id_filter_only_touches_matching_user(ctx):
    other_uid = user_repo.create_user(email="other@t.com", name="other")["id"]
    other_run = dq_runs_repo.start_run(user_id=other_uid, trigger="manual")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (other_uid,))
        cur.execute(
            """
            INSERT INTO dq_vocab_issue_types (user_id, issue_type, status)
            VALUES (%s, 'reversal_pattern', 'proposed')
            ON CONFLICT (user_id, issue_type) DO NOTHING
            """,
            (other_uid,),
        )

    obs_mine = _make_obs(ctx, entity_id="50")
    rec_mine = _make_rec(ctx, obs_mine["id"])

    obs_other = dq_observations_repo.create_observation(
        user_id=other_uid, run_id=other_run["id"], tag="core", entity_type="page",
        entity_id="51", issue_type="reversal_pattern", observation="y", severity="info",
        scope_citation="S1",
    )
    rec_other = _make_rec(ctx, obs_other["id"], user_id=other_uid)

    entries = [
        _rec_entry(rec_mine["id"], obs_mine["id"], status="approved"),
        _rec_entry(rec_other["id"], obs_other["id"], status="approved"),
    ]

    applied, skipped, user_ids = dq_queue_triage._process_recommendations(
        entries, apply=True, user_id_filter=ctx["user_id"]
    )

    assert len(applied) == 1
    assert applied[0]["rec_id"] == rec_mine["id"]
    assert len(skipped) == 1
    assert skipped[0]["rec_id"] == rec_other["id"]
    assert skipped[0]["skip_reason"] == "user_id_mismatch"
    assert user_ids == {ctx["user_id"], other_uid}

    # The other user's row must be untouched.
    status, _, _ = _fetch_rec(rec_other["id"])
    assert status == "pending"


# ── handoffs ─────────────────────────────────────────────────────────────


def test_handoff_dismissed_from_draft(ctx):
    obs = _make_obs(ctx, entity_id="60", handoff=True)
    entries = [_handoff_entry(obs["id"])]

    applied, skipped, _ = dq_queue_triage._process_handoffs(entries, apply=True, user_id_filter=None)

    assert len(applied) == 1
    assert len(skipped) == 0
    assert _fetch_obs_handoff(obs["id"]) == "dismissed"


def test_handoff_skips_non_draft(ctx):
    obs = _make_obs(ctx, entity_id="61", handoff=True)
    dq_observations_repo.update_handoff_status(obs_id=obs["id"], new_status="sent")
    entries = [_handoff_entry(obs["id"])]

    applied, skipped, _ = dq_queue_triage._process_handoffs(entries, apply=True, user_id_filter=None)

    assert len(applied) == 0
    assert skipped[0]["skip_reason"] == "status_mismatch"
    assert skipped[0]["found_status"] == "sent"
    assert _fetch_obs_handoff(obs["id"]) == "sent"


# ── end-to-end via main() + real manifest file loading ──────────────────────


def test_main_end_to_end_with_manifest_file(ctx, tmp_path, monkeypatch):
    obs_rec = _make_obs(ctx, entity_id="70")
    rec = _make_rec(ctx, obs_rec["id"])
    obs_handoff = _make_obs(ctx, entity_id="71", handoff=True)

    manifest_path = _write_manifest(
        tmp_path,
        recs=[_rec_entry(rec["id"], obs_rec["id"], status="dismissed", note="stale target")],
        handoffs=[_handoff_entry(obs_handoff["id"])],
    )
    monkeypatch.setattr(dq_queue_triage, "MANIFEST_PATH", manifest_path)

    dq_queue_triage.main(apply=True, user_id_filter=None)

    status, user_note, reviewed_at = _fetch_rec(rec["id"])
    assert status == "dismissed"
    assert user_note == "stale target"
    assert reviewed_at is not None
    assert _fetch_obs_handoff(obs_handoff["id"]) == "dismissed"


def test_manifest_absent_fails_loudly_from_default_path():
    """No manifest ships (they are per-deployment operational data); the
    loader must fail LOUDLY with FileNotFoundError, never silently no-op."""
    with pytest.raises(FileNotFoundError):
        dq_queue_triage._load_manifest()
