"""Integration tests for backend/scripts/_archive/dq_rec_sweep.py."""

import json

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import dq_observations_repo, dq_recommendations_repo, dq_runs_repo, user_repo
from backend.db.connection import get_conn
from backend.scripts._archive import dq_rec_sweep


@pytest.fixture
def ctx():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE dq_overrides CASCADE")
        cur.execute("TRUNCATE dq_recommendations CASCADE")
        cur.execute("TRUNCATE dq_observations CASCADE")
        cur.execute("TRUNCATE dq_runs CASCADE")
        cur.execute("TRUNCATE users CASCADE")
    uid = user_repo.create_user(email="recsweep@t.com", name="recsweep")["id"]
    run = dq_runs_repo.start_run(user_id=uid, trigger="manual")
    # Migration 028's FK from dq_observations.issue_type to the vocab table --
    # only needed for the handoff-observation fixtures below.
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


def _make_rec(ctx, action_type="edit_prompt", rank=1, user_id=None):
    return dq_recommendations_repo.create_recommendation(
        user_id=user_id or ctx["user_id"],
        run_id=ctx["run_id"],
        observation_id=None,
        action_type=action_type,
        headline="h",
        rationale="r",
        self_classification="judgment",
        rank_in_run=rank,
        affected_entity_type="cluster",
        affected_entity_ids=["x"],
    )


def _make_handoff_obs(ctx, entity_id="60", user_id=None):
    return dq_observations_repo.create_observation(
        user_id=user_id or ctx["user_id"],
        run_id=ctx["run_id"],
        tag="adjacent",
        entity_type="global",
        entity_id=entity_id,
        issue_type="reversal_pattern",
        observation="x",
        severity="info",
        adjacency_contract_ref="A1",
        handoff_prompt_draft="draft prompt text",
    )


def _rec_entry(rec_id, disposition="approved", note="note", action=None, expected="pending"):
    entry = {
        "rec_id": rec_id,
        "expected_prior_status": expected,
        "disposition": disposition,
        "user_note": note,
    }
    if action is not None:
        entry["action"] = action
    return entry


def _handoff_entry(obs_id, note_bucket="infra draft"):
    return {"obs_id": obs_id, "note_bucket": note_bucket}


def _fetch_rec_full(rec_id):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT status, user_note, reviewed_at, action_payload, applied_at, applied_detail
            FROM dq_recommendations WHERE id = %s
            """,
            (rec_id,),
        )
        return cur.fetchone()


def _fetch_obs_handoff(obs_id):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT handoff_status FROM dq_observations WHERE id = %s", (obs_id,))
        return cur.fetchone()[0]


def _write_manifest(tmp_path, recs, handoffs):
    manifest = {"recommendations": recs, "handoffs": handoffs, "meta": {"generated": "test"}}
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps(manifest))
    return p


# ── engine path ──────────────────────────────────────────────────────────


def test_engine_path_backfills_payload_calls_apply_and_marks_applied(ctx, monkeypatch):
    rec = _make_rec(ctx, action_type="relabel_cluster")
    payload = {"stable_id": "abc123", "proposed_label": "New Label"}
    entry = _rec_entry(
        rec["id"],
        disposition="approved",
        note="engine applied",
        action={"mode": "engine", "action_payload": payload},
    )

    captured = {}

    def fake_apply(rec_dict, user_id):
        captured["rec"] = rec_dict
        captured["user_id"] = user_id
        return {
            "action": "relabel_cluster",
            "applied": True,
            "cluster_rows_updated": 1,
            "override_id": 999,
        }

    monkeypatch.setattr(dq_rec_sweep.dq_apply, "apply", fake_apply)

    applied, skipped = dq_rec_sweep._process_recommendations(
        [entry], apply=True, user_id=ctx["user_id"]
    )

    assert len(applied) == 1
    assert len(skipped) == 0

    # apply() got the full rec dict per the brief's contract, not just the payload.
    assert captured["rec"] == {
        "id": rec["id"],
        "user_id": ctx["user_id"],
        "action_type": "relabel_cluster",
        "action_payload": payload,
    }
    assert captured["user_id"] == ctx["user_id"]

    status, user_note, reviewed_at, action_payload, applied_at, applied_detail = _fetch_rec_full(
        rec["id"]
    )
    assert status == "approved"
    assert user_note == "engine applied"
    assert reviewed_at is not None
    assert action_payload == payload
    assert applied_at is not None
    assert applied_detail == {
        "action": "relabel_cluster",
        "applied": True,
        "cluster_rows_updated": 1,
        "override_id": 999,
    }


def test_engine_path_apply_error_detail_still_recorded(ctx, monkeypatch):
    """dq_apply.apply never raises -- an error detail still gets mark_applied'd
    and the disposition still stands (mirrors the PATCH-approve endpoint)."""
    rec = _make_rec(ctx, action_type="split_cluster")
    payload = {"stable_id": "zzz", "remove_page_content_ids": [1, 2]}
    entry = _rec_entry(
        rec["id"], disposition="approved", note="applied",
        action={"mode": "engine", "action_payload": payload},
    )
    monkeypatch.setattr(
        dq_rec_sweep.dq_apply,
        "apply",
        lambda r, u: {"action": "split_cluster", "applied": False, "error": "boom"},
    )

    applied, skipped = dq_rec_sweep._process_recommendations(
        [entry], apply=True, user_id=ctx["user_id"]
    )
    assert len(applied) == 1

    status, _, _, action_payload, applied_at, applied_detail = _fetch_rec_full(rec["id"])
    assert status == "approved"
    assert action_payload == payload
    assert applied_at is not None
    assert applied_detail == {"action": "split_cluster", "applied": False, "error": "boom"}


# ── override path ────────────────────────────────────────────────────────


def test_override_path_seeds_override_and_marks_applied(ctx):
    rec = _make_rec(ctx, action_type="relabel_cluster")  # deliberately mismatched vs. remedy
    override_obj = {
        "override_type": "exclude_from_cluster",
        "subject": {"stable_id": "abc123"},
        "payload": {"page_content_ids": [1, 2, 3]},
    }
    entry = _rec_entry(
        rec["id"],
        disposition="approved",
        note="override seeded",
        action={"mode": "override", "override": override_obj},
    )

    applied, skipped = dq_rec_sweep._process_recommendations(
        [entry], apply=True, user_id=ctx["user_id"]
    )

    assert len(applied) == 1
    assert len(skipped) == 0

    status, user_note, reviewed_at, action_payload, applied_at, applied_detail = _fetch_rec_full(
        rec["id"]
    )
    assert status == "approved"
    assert user_note == "override seeded"
    assert reviewed_at is not None
    assert action_payload is None  # override path never touches action_payload
    assert applied_at is not None
    assert applied_detail["action"] == "override_seeded"
    assert applied_detail["applied"] is False
    assert applied_detail["reason"] == "applies at next recluster"

    override_id = applied_detail["override_id"]
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT override_type, subject, payload, source_rec_id, user_id FROM dq_overrides WHERE id = %s",
            (override_id,),
        )
        row = cur.fetchone()
    assert row == (
        "exclude_from_cluster",
        {"stable_id": "abc123"},
        {"page_content_ids": [1, 2, 3]},
        rec["id"],
        ctx["user_id"],
    )


# ── plain disposition (no action) ───────────────────────────────────────


def test_plain_disposition_flips_status_only(ctx):
    rec = _make_rec(ctx, action_type="edit_prompt")
    entry = _rec_entry(rec["id"], disposition="dismissed", note="no action needed")

    applied, skipped = dq_rec_sweep._process_recommendations(
        [entry], apply=True, user_id=ctx["user_id"]
    )

    assert len(applied) == 1
    assert len(skipped) == 0

    status, user_note, reviewed_at, action_payload, applied_at, applied_detail = _fetch_rec_full(
        rec["id"]
    )
    assert status == "dismissed"
    assert user_note == "no action needed"
    assert reviewed_at is not None
    assert action_payload is None
    assert applied_at is None  # mark_applied never called for a no-action entry
    assert applied_detail is None

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM dq_overrides WHERE user_id = %s", (ctx["user_id"],))
        assert cur.fetchone()[0] == 0


def test_rejected_disposition_flips_status_only(ctx):
    rec = _make_rec(ctx, action_type="flag_for_review")
    entry = _rec_entry(rec["id"], disposition="rejected", note="false positive")

    applied, skipped = dq_rec_sweep._process_recommendations(
        [entry], apply=True, user_id=ctx["user_id"]
    )
    assert len(applied) == 1

    status, user_note, *_ = _fetch_rec_full(rec["id"])
    assert status == "rejected"
    assert user_note == "false positive"


# ── status_mismatch idempotency ─────────────────────────────────────────


def test_second_apply_run_is_idempotent(ctx, monkeypatch):
    rec = _make_rec(ctx, action_type="merge_clusters")
    payload = {"stable_ids": ["a", "b"]}
    entry = _rec_entry(
        rec["id"], disposition="approved", note="merged",
        action={"mode": "engine", "action_payload": payload},
    )
    monkeypatch.setattr(
        dq_rec_sweep.dq_apply, "apply", lambda r, u: {"action": "merge_clusters", "applied": False}
    )

    applied1, skipped1 = dq_rec_sweep._process_recommendations(
        [entry], apply=True, user_id=ctx["user_id"]
    )
    assert len(applied1) == 1
    assert len(skipped1) == 0

    applied2, skipped2 = dq_rec_sweep._process_recommendations(
        [entry], apply=True, user_id=ctx["user_id"]
    )
    assert len(applied2) == 0
    assert len(skipped2) == 1
    assert skipped2[0]["skip_reason"] == "status_mismatch"
    assert skipped2[0]["found_status"] == "approved"

    # No duplicate override row from a second (skipped) pass over an override entry.
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM dq_overrides WHERE source_rec_id = %s", (rec["id"],))
        assert cur.fetchone()[0] == 0  # this entry used the engine path, not override


def test_status_mismatch_never_clobbers_existing_review(ctx):
    rec = _make_rec(ctx, action_type="edit_prompt")
    dq_recommendations_repo.update_status(
        rec_id=rec["id"], new_status="rejected", user_note="reviewed elsewhere"
    )
    entry = _rec_entry(rec["id"], disposition="approved", note="sweep note")

    applied, skipped = dq_rec_sweep._process_recommendations(
        [entry], apply=True, user_id=ctx["user_id"]
    )
    assert len(applied) == 0
    assert skipped[0]["skip_reason"] == "status_mismatch"
    assert skipped[0]["found_status"] == "rejected"

    status, user_note, *_ = _fetch_rec_full(rec["id"])
    assert status == "rejected"
    assert user_note == "reviewed elsewhere"


def test_not_found_rec_is_skipped(ctx):
    entry = _rec_entry(999_999_999, disposition="approved")

    applied, skipped = dq_rec_sweep._process_recommendations(
        [entry], apply=True, user_id=ctx["user_id"]
    )
    assert len(applied) == 0
    assert skipped[0]["skip_reason"] == "not_found"
    assert skipped[0]["found_status"] is None


def test_user_id_mismatch_is_skipped_and_untouched(ctx):
    other_uid = user_repo.create_user(email="other@t.com", name="other")["id"]
    other_run = dq_runs_repo.start_run(user_id=other_uid, trigger="manual")
    rec_other = dq_recommendations_repo.create_recommendation(
        user_id=other_uid, run_id=other_run["id"], observation_id=None,
        action_type="edit_prompt", headline="h", rationale="r",
        self_classification="judgment", rank_in_run=1,
        affected_entity_type="global", affected_entity_ids=["x"],
    )
    entry = _rec_entry(rec_other["id"], disposition="approved", note="not mine")

    applied, skipped = dq_rec_sweep._process_recommendations(
        [entry], apply=True, user_id=ctx["user_id"]
    )
    assert len(applied) == 0
    assert skipped[0]["skip_reason"] == "user_id_mismatch"

    status, *_ = _fetch_rec_full(rec_other["id"])
    assert status == "pending"


# ── dry run ──────────────────────────────────────────────────────────────


def test_dry_run_writes_nothing(ctx, monkeypatch):
    rec = _make_rec(ctx, action_type="relabel_cluster")
    payload = {"stable_id": "abc", "proposed_label": "X"}
    entry = _rec_entry(
        rec["id"], disposition="approved", note="would apply",
        action={"mode": "engine", "action_payload": payload},
    )

    calls = []
    monkeypatch.setattr(dq_rec_sweep.dq_apply, "apply", lambda r, u: calls.append((r, u)))

    applied, skipped = dq_rec_sweep._process_recommendations(
        [entry], apply=False, user_id=ctx["user_id"]
    )

    assert len(applied) == 1  # would-apply, counted, but not written
    assert len(skipped) == 0
    assert calls == []  # dq_apply.apply is never invoked during a dry run

    status, user_note, reviewed_at, action_payload, applied_at, applied_detail = _fetch_rec_full(
        rec["id"]
    )
    assert status == "pending"
    assert user_note is None
    assert reviewed_at is None
    assert action_payload is None
    assert applied_at is None
    assert applied_detail is None

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM dq_overrides WHERE user_id = %s", (ctx["user_id"],))
        assert cur.fetchone()[0] == 0


def test_dry_run_override_entry_writes_nothing(ctx):
    rec = _make_rec(ctx, action_type="relabel_cluster")
    entry = _rec_entry(
        rec["id"], disposition="approved", note="would override",
        action={
            "mode": "override",
            "override": {
                "override_type": "pin_label",
                "subject": {"stable_id": "abc"},
                "payload": {"label": "X"},
            },
        },
    )

    applied, skipped = dq_rec_sweep._process_recommendations(
        [entry], apply=False, user_id=ctx["user_id"]
    )
    assert len(applied) == 1

    status, *_ = _fetch_rec_full(rec["id"])
    assert status == "pending"
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM dq_overrides WHERE user_id = %s", (ctx["user_id"],))
        assert cur.fetchone()[0] == 0


# ── handoffs ─────────────────────────────────────────────────────────────


def test_handoff_dismissed_from_draft(ctx):
    obs = _make_handoff_obs(ctx)
    entries = [_handoff_entry(obs["id"])]

    applied, skipped = dq_rec_sweep._process_handoffs(entries, apply=True, user_id=ctx["user_id"])

    assert len(applied) == 1
    assert len(skipped) == 0
    assert _fetch_obs_handoff(obs["id"]) == "dismissed"


def test_handoff_skips_non_draft(ctx):
    obs = _make_handoff_obs(ctx, entity_id="61")
    dq_observations_repo.update_handoff_status(obs_id=obs["id"], new_status="sent")
    entries = [_handoff_entry(obs["id"])]

    applied, skipped = dq_rec_sweep._process_handoffs(entries, apply=True, user_id=ctx["user_id"])

    assert len(applied) == 0
    assert skipped[0]["skip_reason"] == "status_mismatch"
    assert skipped[0]["found_status"] == "sent"
    assert _fetch_obs_handoff(obs["id"]) == "sent"


def test_handoff_dry_run_writes_nothing(ctx):
    obs = _make_handoff_obs(ctx, entity_id="62")
    entries = [_handoff_entry(obs["id"])]

    applied, skipped = dq_rec_sweep._process_handoffs(entries, apply=False, user_id=ctx["user_id"])

    assert len(applied) == 1
    assert _fetch_obs_handoff(obs["id"]) == "draft"


# ── main() end-to-end ────────────────────────────────────────────────────


def test_main_end_to_end_with_manifest_file(ctx, tmp_path, monkeypatch):
    rec_engine = _make_rec(ctx, action_type="relabel_cluster")
    rec_plain = _make_rec(ctx, action_type="edit_prompt", rank=2)
    obs_handoff = _make_handoff_obs(ctx, entity_id="70")

    manifest_path = _write_manifest(
        tmp_path,
        recs=[
            _rec_entry(
                rec_engine["id"], disposition="approved", note="engine",
                action={
                    "mode": "engine",
                    "action_payload": {"stable_id": "s1", "proposed_label": "L"},
                },
            ),
            _rec_entry(rec_plain["id"], disposition="dismissed", note="no-op"),
        ],
        handoffs=[_handoff_entry(obs_handoff["id"])],
    )
    monkeypatch.setattr(dq_rec_sweep, "MANIFEST_PATH", manifest_path)
    monkeypatch.setattr(
        dq_rec_sweep.dq_apply, "apply", lambda r, u: {"action": "relabel_cluster", "applied": True}
    )

    dq_rec_sweep.main(apply=True, user_id=ctx["user_id"])

    status1, _, _, payload1, applied_at1, detail1 = _fetch_rec_full(rec_engine["id"])
    assert status1 == "approved"
    assert payload1 == {"stable_id": "s1", "proposed_label": "L"}
    assert applied_at1 is not None
    assert detail1 == {"action": "relabel_cluster", "applied": True}

    status2, user_note2, *_ = _fetch_rec_full(rec_plain["id"])
    assert status2 == "dismissed"
    assert user_note2 == "no-op"

    assert _fetch_obs_handoff(obs_handoff["id"]) == "dismissed"


def test_main_dry_run_with_manifest_file_writes_nothing(ctx, tmp_path, monkeypatch):
    rec = _make_rec(ctx, action_type="edit_prompt")
    manifest_path = _write_manifest(
        tmp_path, recs=[_rec_entry(rec["id"], disposition="approved", note="x")], handoffs=[]
    )
    monkeypatch.setattr(dq_rec_sweep, "MANIFEST_PATH", manifest_path)

    dq_rec_sweep.main(apply=False, user_id=ctx["user_id"])

    status, *_ = _fetch_rec_full(rec["id"])
    assert status == "pending"


def test_manifest_absent_fails_loudly_from_default_path():
    """No manifest ships (they are per-deployment operational data); the
    loader must fail LOUDLY with FileNotFoundError, never silently no-op."""
    with pytest.raises(FileNotFoundError):
        dq_rec_sweep._load_manifest()


# ── CLI ──────────────────────────────────────────────────────────────────


def test_user_id_is_a_required_cli_arg():
    with pytest.raises(SystemExit):
        dq_rec_sweep._build_parser().parse_args([])

    args = dq_rec_sweep._build_parser().parse_args(["--user-id", "152"])
    assert args.user_id == 152
    assert args.apply is False
