"""Integration tests for dq_overrides repo (migration 042 / dqBot Tier 1)."""

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(), reason="Test PostgreSQL not reachable"
)

from backend.db import dq_overrides_repo, user_repo
from backend.db.connection import get_conn


@pytest.fixture
def ctx():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE dq_overrides CASCADE")
        cur.execute("TRUNCATE users CASCADE")
    uid = user_repo.create_user(email="ov@ov.com", name="ov")["id"]
    return {"user_id": uid}


def test_create_override_pin_label(ctx):
    ov = dq_overrides_repo.create_override(
        user_id=ctx["user_id"],
        override_type="pin_label",
        subject={"stable_id": "abc-123"},
        payload={"label": "Rust ownership deep-dives"},
    )
    assert ov["id"] is not None
    assert ov["override_type"] == "pin_label"
    assert ov["subject"] == {"stable_id": "abc-123"}
    assert ov["payload"] == {"label": "Rust ownership deep-dives"}
    assert ov["status"] == "active"
    assert ov["apply_count"] == 0
    assert ov["source_rec_id"] is None
    assert ov["last_applied_run"] is None
    assert ov["last_applied_at"] is None


def test_create_override_without_payload(ctx):
    ov = dq_overrides_repo.create_override(
        user_id=ctx["user_id"],
        override_type="never_cocluster",
        subject={"page_content_id_a": "c1", "page_content_id_b": "c2"},  # canonical never_cocluster shape (spec S6)
    )
    assert ov["payload"] is None


def test_create_override_invalid_type_raises(ctx):
    with pytest.raises(ValueError, match="override_type"):
        dq_overrides_repo.create_override(
            user_id=ctx["user_id"],
            override_type="bogus_type",
            subject={},
        )


def test_create_override_with_source_rec_id(ctx):
    # source_rec_id FK requires a real dq_recommendations row; use a minimal
    # observation+rec fixture inline rather than pulling in the full
    # dq_recommendations ctx fixture (keeps this repo's test file self-
    # contained per the "your files only" scope).
    from backend.db import dq_observations_repo, dq_recommendations_repo, dq_runs_repo

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (ctx["user_id"],))
        cur.execute(
            """
            INSERT INTO dq_vocab_issue_types (user_id, issue_type, status)
            VALUES (%s, 'reversal_pattern', 'proposed')
            ON CONFLICT (user_id, issue_type) DO NOTHING
            """,
            (ctx["user_id"],),
        )
    run = dq_runs_repo.start_run(user_id=ctx["user_id"], trigger="manual")
    obs = dq_observations_repo.create_observation(
        user_id=ctx["user_id"], run_id=run["id"], tag="core",
        entity_type="cluster", entity_id="stable-9",
        issue_type="reversal_pattern", observation="x", severity="info",
    )
    rec = dq_recommendations_repo.create_recommendation(
        user_id=ctx["user_id"], run_id=run["id"], observation_id=obs["id"],
        action_type="relabel_cluster", headline="h", rationale="r",
        self_classification="trivial", rank_in_run=1,
        affected_entity_type="cluster", affected_entity_ids=["stable-9"],
    )

    ov = dq_overrides_repo.create_override(
        user_id=ctx["user_id"],
        override_type="pin_label",
        subject={"stable_id": "stable-9"},
        payload={"label": "Pinned"},
        source_rec_id=rec["id"],
    )
    assert ov["source_rec_id"] == rec["id"]


def test_list_active_excludes_retired(ctx):
    a = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="pin_label", subject={"stable_id": "1"},
    )
    b = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="pin_label", subject={"stable_id": "2"},
    )
    dq_overrides_repo.retire(b["id"], user_id=ctx["user_id"])

    active = dq_overrides_repo.list_active(ctx["user_id"])
    assert [o["id"] for o in active] == [a["id"]]


def test_list_active_newest_first(ctx):
    first = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="pin_label", subject={"stable_id": "1"},
    )
    second = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="pin_label", subject={"stable_id": "2"},
    )
    active = dq_overrides_repo.list_active(ctx["user_id"])
    assert [o["id"] for o in active] == [second["id"], first["id"]]


def test_list_all_active_first_then_retired_newest_within_group(ctx):
    o1 = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="pin_label", subject={"stable_id": "1"},
    )
    o2 = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="pin_label", subject={"stable_id": "2"},
    )
    o3 = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="pin_label", subject={"stable_id": "3"},
    )
    # Retire o1 (oldest) and o2 -- retired group should still be newest-first
    # within itself (o2 before o1), and the whole retired group comes after
    # the still-active group (o3).
    dq_overrides_repo.retire(o1["id"], user_id=ctx["user_id"])
    dq_overrides_repo.retire(o2["id"], user_id=ctx["user_id"])

    all_rows = dq_overrides_repo.list_all(ctx["user_id"])
    ids = [o["id"] for o in all_rows]
    statuses = [o["status"] for o in all_rows]

    assert ids == [o3["id"], o2["id"], o1["id"]]
    assert statuses == ["active", "retired", "retired"]


def test_retire_sets_status_and_returns_row(ctx):
    ov = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="merge_clusters",
        subject={"stable_ids": ["a", "b"]},
    )
    retired = dq_overrides_repo.retire(ov["id"], user_id=ctx["user_id"])
    assert retired is not None
    assert retired["status"] == "retired"


def test_retire_wrong_user_returns_none(ctx):
    ov = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="pin_label", subject={"stable_id": "1"},
    )
    other_uid = user_repo.create_user(email="other@ov.com", name="other")["id"]
    result = dq_overrides_repo.retire(ov["id"], user_id=other_uid)
    assert result is None

    # Confirm the original row is untouched
    active = dq_overrides_repo.list_active(ctx["user_id"])
    assert active[0]["status"] == "active"


def test_retire_nonexistent_returns_none(ctx):
    assert dq_overrides_repo.retire(999999, user_id=ctx["user_id"]) is None


def test_mark_applied_bumps_fields(ctx):
    a = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="pin_label", subject={"stable_id": "1"},
    )
    b = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="pin_label", subject={"stable_id": "2"},
    )

    updated = dq_overrides_repo.mark_applied([a["id"], b["id"]], run_id=42)
    assert updated == 2

    rows = {o["id"]: o for o in dq_overrides_repo.list_active(ctx["user_id"])}
    assert rows[a["id"]]["apply_count"] == 1
    assert rows[a["id"]]["last_applied_run"] == 42
    assert rows[a["id"]]["last_applied_at"] is not None
    assert rows[b["id"]]["apply_count"] == 1
    assert rows[b["id"]]["last_applied_run"] == 42


def test_mark_applied_increments_across_calls(ctx):
    a = dq_overrides_repo.create_override(
        user_id=ctx["user_id"], override_type="pin_label", subject={"stable_id": "1"},
    )
    dq_overrides_repo.mark_applied([a["id"]], run_id=1)
    dq_overrides_repo.mark_applied([a["id"]], run_id=2)

    rows = {o["id"]: o for o in dq_overrides_repo.list_active(ctx["user_id"])}
    assert rows[a["id"]]["apply_count"] == 2
    assert rows[a["id"]]["last_applied_run"] == 2


def test_mark_applied_empty_list_is_noop(ctx):
    assert dq_overrides_repo.mark_applied([], run_id=1) == 0


def test_mark_applied_nonexistent_ids_returns_zero(ctx):
    assert dq_overrides_repo.mark_applied([999999], run_id=1) == 0
