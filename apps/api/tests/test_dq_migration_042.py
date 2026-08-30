"""Verify migration 042 applies cleanly: dq_recommendations.action_payload/
applied_at/applied_detail + the dq_overrides table (CHECKs, RLS, index,
readonly grant).

Follows tests/test_dq_migration_040.py's pattern: migrations are applied to
the test DB by the session-scoped fixture in conftest.py, so by the time
these tests run, migration 042's schema changes already exist. These tests
assert structure + constraint behaviour; CRUD behaviour for dq_overrides
lives in tests/test_dq_overrides_repo.py and the corresponding
dq_recommendations_repo additions live in tests/test_dq_recommendations_repo.py.

Pytest pattern note (same as test_dq_migration_028.py): psycopg2 puts a
transaction into "aborted" state after a constraint violation, so
pytest.raises must be the OUTER context wrapping `with get_conn()` -- the
exception propagates through get_conn(), which rolls back cleanly before
re-raising.
"""

import uuid

import pytest
from psycopg2.errors import CheckViolation

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(), reason="Test PostgreSQL not reachable"
)

from backend.db import user_repo
from backend.db.connection import get_conn


def _fresh_user(label: str) -> int:
    email = f"{label}-{uuid.uuid4().hex[:8]}@test.local"
    return user_repo.create_user(email=email, name="dq042_test")["id"]


def test_dq_recommendations_has_new_columns():
    expected = {
        "action_payload": "jsonb",
        "applied_at": "timestamp with time zone",
        "applied_detail": "jsonb",
    }
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, data_type FROM information_schema.columns
            WHERE table_name = 'dq_recommendations'
              AND column_name IN ('action_payload', 'applied_at', 'applied_detail')
            """
        )
        actual = {r[0]: r[1] for r in cur.fetchall()}
    assert actual == expected


def test_dq_overrides_table_exists_with_expected_columns():
    expected = {
        "id",
        "user_id",
        "override_type",
        "subject",
        "payload",
        "status",
        "source_rec_id",
        "created_at",
        "last_applied_run",
        "last_applied_at",
        "apply_count",
    }
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'dq_overrides'
            """
        )
        actual = {r[0] for r in cur.fetchall()}
    assert actual == expected


def test_dq_overrides_defaults():
    uid = _fresh_user("overrides_defaults")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (uid,))
        cur.execute(
            """
            INSERT INTO dq_overrides (user_id, override_type, subject)
            VALUES (%s, 'pin_label', '{"stable_id": "abc"}'::jsonb)
            RETURNING status, apply_count, payload, last_applied_run, last_applied_at
            """,
            (uid,),
        )
        row = cur.fetchone()
    assert row[0] == "active"
    assert row[1] == 0
    assert row[2] is None
    assert row[3] is None
    assert row[4] is None


def test_dq_overrides_type_check_rejects_unknown():
    uid = _fresh_user("overrides_type_check")
    with pytest.raises(CheckViolation):
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SET app.current_user_id = %s", (uid,))
            cur.execute(
                """
                INSERT INTO dq_overrides (user_id, override_type, subject)
                VALUES (%s, 'not_a_real_type', '{}'::jsonb)
                """,
                (uid,),
            )


def test_dq_overrides_type_check_accepts_all_four():
    uid = _fresh_user("overrides_type_all")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (uid,))
        for override_type in (
            "pin_label",
            "exclude_from_cluster",
            "never_cocluster",
            "merge_clusters",
        ):
            cur.execute(
                """
                INSERT INTO dq_overrides (user_id, override_type, subject)
                VALUES (%s, %s, '{}'::jsonb)
                """,
                (uid, override_type),
            )


def test_dq_overrides_status_check_rejects_unknown():
    uid = _fresh_user("overrides_status_check")
    with pytest.raises(CheckViolation):
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SET app.current_user_id = %s", (uid,))
            cur.execute(
                """
                INSERT INTO dq_overrides (user_id, override_type, subject, status)
                VALUES (%s, 'pin_label', '{}'::jsonb, 'bogus')
                """,
                (uid,),
            )


def test_dq_overrides_subject_not_null():
    uid = _fresh_user("overrides_subject_notnull")
    with pytest.raises(Exception):
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SET app.current_user_id = %s", (uid,))
            cur.execute(
                """
                INSERT INTO dq_overrides (user_id, override_type)
                VALUES (%s, 'pin_label')
                """,
                (uid,),
            )


def test_dq_overrides_rls_enabled():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT relrowsecurity FROM pg_class WHERE relname = 'dq_overrides'"
        )
        row = cur.fetchone()
    assert row is not None and row[0] is True


def test_dq_overrides_rls_policy_exists():
    """A policy is registered against dq_overrides using the standard
    user-isolation predicate. (Row-level enforcement isn't exercised here --
    the test-suite's DB role is the table owner and bypasses RLS by default,
    same posture as the rest of this migration test family; see
    test_dq_migration_028.py, which likewise only asserts RLS is *enabled*,
    not that it's enforced under this role.)"""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT policyname, qual::text FROM pg_policies "
            "WHERE tablename = 'dq_overrides'"
        )
        rows = cur.fetchall()
    assert len(rows) == 1
    _, qual = rows[0]
    assert "current_user_id" in qual


def test_dq_overrides_has_user_status_index():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT indexdef FROM pg_indexes
            WHERE tablename = 'dq_overrides' AND indexdef ILIKE '%%user_id%%status%%'
            """
        )
        row = cur.fetchone()
    assert row is not None, "expected an index covering (user_id, status) on dq_overrides"


def test_dq_bot_readonly_has_select_on_dq_overrides():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.role_table_grants
            WHERE grantee = 'dq_bot_readonly' AND table_name = 'dq_overrides'
              AND privilege_type = 'SELECT'
            """
        )
        row = cur.fetchone()
    assert row is not None, "dq_bot_readonly must have SELECT on dq_overrides"


def test_dq_overrides_source_rec_id_set_null_on_rec_delete():
    """source_rec_id -> dq_recommendations(id) ON DELETE SET NULL."""
    from backend.db import dq_observations_repo, dq_recommendations_repo, dq_runs_repo

    uid = _fresh_user("overrides_fk_setnull")
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
    run = dq_runs_repo.start_run(user_id=uid, trigger="manual")
    obs = dq_observations_repo.create_observation(
        user_id=uid, run_id=run["id"], tag="core",
        entity_type="cluster", entity_id="stable-1",
        issue_type="reversal_pattern",
        observation="x", severity="info",
    )
    rec = dq_recommendations_repo.create_recommendation(
        user_id=uid, run_id=run["id"], observation_id=obs["id"],
        action_type="relabel_cluster", headline="h", rationale="r",
        self_classification="trivial", rank_in_run=1,
        affected_entity_type="cluster", affected_entity_ids=["stable-1"],
    )

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (uid,))
        cur.execute(
            """
            INSERT INTO dq_overrides (user_id, override_type, subject, source_rec_id)
            VALUES (%s, 'pin_label', '{"stable_id": "stable-1"}'::jsonb, %s)
            RETURNING id
            """,
            (uid, rec["id"]),
        )
        override_id = cur.fetchone()[0]

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (uid,))
        cur.execute("DELETE FROM dq_recommendations WHERE id = %s", (rec["id"],))

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (uid,))
        cur.execute("SELECT source_rec_id FROM dq_overrides WHERE id = %s", (override_id,))
        row = cur.fetchone()
    assert row[0] is None
