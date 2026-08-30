"""Tests for backend/services/dq_verdict_history.py."""

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import dq_observations_repo, dq_recommendations_repo, dq_runs_repo, user_repo
from backend.db.connection import get_conn
from backend.services import dq_verdict_history


@pytest.fixture
def ctx():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE dq_overrides CASCADE")
        cur.execute("TRUNCATE dq_recommendations CASCADE")
        cur.execute("TRUNCATE dq_observations CASCADE")
        cur.execute("TRUNCATE dq_runs CASCADE")
        cur.execute("TRUNCATE users CASCADE")
    uid = user_repo.create_user(email="verdicthist@t.com", name="verdicthist")["id"]
    run1 = dq_runs_repo.start_run(user_id=uid, trigger="manual")
    run2 = dq_runs_repo.start_run(user_id=uid, trigger="manual")
    # dq_observations.issue_type FKs to dq_vocab_issue_types(user_id, issue_type)
    # -- seed the issue types this fixture's observations use (mirrors
    # tests/test_dq_rec_sweep.py's ctx fixture).
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (uid,))
        for issue_type in ("reversal_pattern", "stale_label", "chain_pattern"):
            cur.execute(
                """
                INSERT INTO dq_vocab_issue_types (user_id, issue_type, status)
                VALUES (%s, %s, 'proposed')
                ON CONFLICT (user_id, issue_type) DO NOTHING
                """,
                (uid, issue_type),
            )
    return {"user_id": uid, "run1_id": run1["id"], "run2_id": run2["id"]}


def _make_obs(ctx, entity_id, issue_type="reversal_pattern", run_id=None):
    return dq_observations_repo.create_observation(
        user_id=ctx["user_id"],
        run_id=run_id or ctx["run1_id"],
        tag="core",
        entity_type="cluster",
        entity_id=entity_id,
        issue_type=issue_type,
        observation="x",
        severity="info",
    )


def _make_rec(ctx, action_type="edit_prompt", observation_id=None, run_id=None, rank=1):
    return dq_recommendations_repo.create_recommendation(
        user_id=ctx["user_id"],
        run_id=run_id or ctx["run1_id"],
        observation_id=observation_id,
        action_type=action_type,
        headline="h",
        rationale="r",
        self_classification="judgment",
        rank_in_run=rank,
        affected_entity_type="cluster",
        affected_entity_ids=["x"],
    )


def _seed_corpus(ctx):
    """2 rejected recs w/ notes, 3 approved w/ notes, 1 dismissed w/ note,
    plus a supersession chain on its own entity spanning two runs."""
    obs_a = _make_obs(ctx, entity_id="A", issue_type="reversal_pattern")
    obs_b = _make_obs(ctx, entity_id="B", issue_type="stale_label")

    rejected_ids = []
    for i, (action, note) in enumerate(
        [
            ("relabel_cluster", "wrong -- label was already correct"),
            ("edit_prompt", "false positive, pattern doesn't hold"),
        ]
    ):
        rec = _make_rec(ctx, action_type=action, observation_id=obs_a["id"], rank=i + 1)
        dq_recommendations_repo.update_status(rec["id"], "rejected", user_note=note)
        rejected_ids.append(rec["id"])

    approved_ids = []
    for i, (action, note) in enumerate(
        [
            ("relabel_cluster", "good catch, applied"),
            ("split_cluster", "correct outlier"),
            ("dedupe", "confirmed duplicate"),
        ]
    ):
        rec = _make_rec(ctx, action_type=action, observation_id=obs_b["id"], rank=i + 3)
        dq_recommendations_repo.update_status(rec["id"], "approved", user_note=note)
        approved_ids.append(rec["id"])

    dismissed_rec = _make_rec(
        ctx, action_type="flag_for_review", observation_id=obs_b["id"], rank=6
    )
    dq_recommendations_repo.update_status(dismissed_rec["id"], "dismissed", user_note="not worth it")

    # Supersession chain on its own entity, spanning two distinct runs.
    obs_chain = _make_obs(ctx, entity_id="CHAIN-1", issue_type="chain_pattern")
    old_rec = _make_rec(
        ctx, action_type="relabel_cluster", observation_id=obs_chain["id"], run_id=ctx["run1_id"], rank=7
    )
    dq_recommendations_repo.supersede(
        old_rec["id"],
        {
            "user_id": ctx["user_id"],
            "run_id": ctx["run2_id"],
            "observation_id": obs_chain["id"],
            "action_type": "relabel_cluster",
            "headline": "h2",
            "rationale": "r2",
            "self_classification": "judgment",
            "rank_in_run": 1,
            "affected_entity_type": "cluster",
            "affected_entity_ids": ["x"],
        },
    )

    return {
        "rejected_ids": rejected_ids,
        "approved_ids": approved_ids,
        "dismissed_id": dismissed_rec["id"],
    }


# ── empty corpus ─────────────────────────────────────────────────────────


def test_empty_corpus_renders_stub(ctx):
    text = dq_verdict_history.render_verdict_history(ctx["user_id"])
    assert text.startswith("## VERDICT HISTORY")
    assert "(no verdict history yet)" in text


# ── header, calibration, rejected, resolved, recurrence content ─────────


def test_header_and_calibration_rendered(ctx):
    _seed_corpus(ctx)
    text = dq_verdict_history.render_verdict_history(ctx["user_id"])

    assert text.startswith("## VERDICT HISTORY (how this user has judged your past findings)")
    # relabel_cluster: 1 rejected + 1 approved -> 1/2 approved (50%)
    assert "- relabel_cluster: 1/2 approved (50%)" in text
    # split_cluster / dedupe: 1 approved each -> 100%
    assert "- split_cluster: 1/1 approved (100%)" in text
    assert "- dedupe: 1/1 approved (100%)" in text
    # edit_prompt: 1 rejected only -> 0%
    assert "- edit_prompt: 0/1 approved (0%)" in text


def test_every_rejected_note_appears_verbatim(ctx):
    _seed_corpus(ctx)
    text = dq_verdict_history.render_verdict_history(ctx["user_id"])

    assert "wrong -- label was already correct" in text
    assert "false positive, pattern doesn't hold" in text


def test_recent_resolved_notes_appear_newest_first(ctx):
    _seed_corpus(ctx)
    text = dq_verdict_history.render_verdict_history(ctx["user_id"])

    for note in ("good catch, applied", "correct outlier", "confirmed duplicate", "not worth it"):
        assert note in text

    idx_dismissed = text.index("not worth it")
    idx_dedupe = text.index("confirmed duplicate")
    idx_split = text.index("correct outlier")
    idx_relabel = text.index("good catch, applied")
    # Reviewed in that order (relabel -> split -> dedupe -> dismissed), so
    # newest-first rendering puts "not worth it" first and "good catch,
    # applied" last.
    assert idx_dismissed < idx_dedupe < idx_split < idx_relabel


def test_recurrence_reflects_supersession_chain(ctx):
    _seed_corpus(ctx)
    text = dq_verdict_history.render_verdict_history(ctx["user_id"])

    assert "- entity CHAIN-1: recommended in 2 separate runs" in text


# ── trimming ──────────────────────────────────────────────────────────────


def test_rejected_and_calibration_survive_minimal_budget(ctx):
    _seed_corpus(ctx)
    minimal = dq_verdict_history.render_verdict_history(ctx["user_id"], max_chars=1)

    # Sections 1 (calibration) and 3 (rejected) always survive, even though
    # the result necessarily exceeds max_chars=1.
    assert "- relabel_cluster: 1/2 approved (50%)" in minimal
    assert "wrong -- label was already correct" in minimal
    assert "false positive, pattern doesn't hold" in minimal

    # Everything else is gone at the minimal achievable budget.
    assert "good catch, applied" not in minimal
    assert "not worth it" not in minimal
    assert "CHAIN-1" not in minimal


def test_output_respects_max_chars_budget(ctx):
    _seed_corpus(ctx)
    minimal = dq_verdict_history.render_verdict_history(ctx["user_id"], max_chars=1)
    budget = len(minimal) + 50

    trimmed = dq_verdict_history.render_verdict_history(ctx["user_id"], max_chars=budget)
    assert len(trimmed) <= budget


def test_trimming_drops_oldest_resolved_notes_before_newest(ctx):
    _seed_corpus(ctx)
    full_text = dq_verdict_history.render_verdict_history(ctx["user_id"], max_chars=100_000)
    minimal = dq_verdict_history.render_verdict_history(ctx["user_id"], max_chars=1)

    lo, hi = len(minimal), len(full_text)

    def first_budget_containing(needle: str) -> int:
        lo_, hi_ = lo, hi
        while lo_ < hi_:
            mid = (lo_ + hi_) // 2
            text = dq_verdict_history.render_verdict_history(ctx["user_id"], max_chars=mid)
            if needle in text:
                hi_ = mid
            else:
                lo_ = mid + 1
        return lo_

    newest_threshold = first_budget_containing("not worth it")
    oldest_threshold = first_budget_containing("good catch, applied")

    # The newest resolved note (dismissed last) survives at a smaller
    # budget than the oldest one (approved first) -- oldest is dropped
    # first as the budget shrinks.
    assert newest_threshold < oldest_threshold
