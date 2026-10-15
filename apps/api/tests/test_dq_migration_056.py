"""Verify migration 056: dq_adjudications table (columns, CHECKs, FKs,
indexes, RLS policy, readonly grant). Same pattern as test_dq_migration_042.py."""

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
    return user_repo.create_user(email=email, name="dq056_test")["id"]


def _insert(cur, uid, verdict="confirm", context="full"):
    cur.execute(
        """
        INSERT INTO dq_adjudications (user_id, context, entity_type, entity_id, verdict)
        VALUES (%s, %s, 'cluster', 'abc', %s)
        """,
        (uid, context, verdict),
    )


def test_columns_and_types():
    expected = {
        "id": "integer", "user_id": "integer", "run_id": "integer",
        "generation": "integer", "context": "text", "scope_citation": "text",
        "entity_type": "text", "entity_id": "text", "issue_type": "text",
        "label": "text", "verdict": "text", "confidence": "real",
        "reason": "text", "refined_action": "text", "model": "text",
        "batch_index": "integer", "polarity_conflict": "boolean",
        "created_at": "timestamp with time zone",
    }
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_name = 'dq_adjudications'"
        )
        assert {r[0]: r[1] for r in cur.fetchall()} == expected


def test_nullability():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'dq_adjudications' AND is_nullable = 'NO'"
        )
        not_null = {r[0] for r in cur.fetchall()}
    assert not_null == {"id", "user_id", "context", "entity_type", "entity_id",
                        "verdict", "created_at"}


def test_verdict_check_rejects_unknown_and_accepts_both():
    uid = _fresh_user("adj_verdict")
    with get_conn() as conn, conn.cursor() as cur:
        _insert(cur, uid, "confirm")
        _insert(cur, uid, "suppress")
    with pytest.raises(CheckViolation):
        with get_conn() as conn, conn.cursor() as cur:
            _insert(cur, uid, "maybe")


def test_context_check_rejects_unknown():
    uid = _fresh_user("adj_context")
    with pytest.raises(CheckViolation):
        with get_conn() as conn, conn.cursor() as cur:
            _insert(cur, uid, context="nightly")


def test_run_id_set_null_on_run_delete():
    uid = _fresh_user("adj_runfk")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO dq_runs (user_id, trigger) VALUES (%s, 'manual') RETURNING id",
            (uid,),
        )
        run_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO dq_adjudications (user_id, run_id, context, entity_type, entity_id, verdict) "
            "VALUES (%s, %s, 'gate', 'cluster', 'x', 'suppress')",
            (uid, run_id),
        )
        cur.execute("DELETE FROM dq_runs WHERE id = %s", (run_id,))
        cur.execute("SELECT run_id FROM dq_adjudications WHERE user_id = %s", (uid,))
        assert cur.fetchone()[0] is None


def test_indexes_rls_and_grant():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'dq_adjudications'")
        idx = {r[0] for r in cur.fetchall()}
        assert {"dq_adjudications_user_created", "dq_adjudications_user_entity"} <= idx
        cur.execute("SELECT relrowsecurity FROM pg_class WHERE relname = 'dq_adjudications'")
        assert cur.fetchone()[0] is True
        cur.execute("SELECT policyname FROM pg_policies WHERE tablename = 'dq_adjudications'")
        assert [r[0] for r in cur.fetchall()] == ["dq_adjudications_user_isolation"]
        cur.execute(
            "SELECT has_table_privilege('dq_bot_readonly', 'dq_adjudications', 'SELECT')"
        )
        assert cur.fetchone()[0] is True
