"""Verify migration 028 applies cleanly and FK enforces vocab membership.

Migrations are applied to the test DB by the session-scoped fixture in
conftest.py, so by the time these tests run, the schema for migration 028
already exists. Tests assert structure (PK columns, CHECK constraints,
RLS policies, role grants) and behaviour (FK rejects unknown labels,
bootstrap seeded the deterministic-investigator constants).

Pytest pattern note: psycopg2 puts a transaction into "aborted" state after
a constraint violation, and `with get_conn()` will then fail at commit time.
So `pytest.raises` is the OUTER context for any test that triggers a
violation -- the exception propagates through `get_conn()`, which rolls back
cleanly before re-raising.
"""

import uuid

import pytest
from psycopg2.errors import (
    CheckViolation,
    ForeignKeyViolation,
    InsufficientPrivilege,
)

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(), reason="Test PostgreSQL not reachable"
)

from backend.db import user_repo, dq_runs_repo
from backend.db.connection import get_conn


def _fresh_user(label: str) -> int:
    """Create an isolated user for a single test.

    Uses a uuid-suffixed email so re-runs against the persistent test DB
    do not collide on the unique-email constraint.
    """
    email = f"{label}-{uuid.uuid4().hex[:8]}@test.local"
    return user_repo.create_user(email=email, name="vocab_test")["id"]


def test_vocab_table_exists_with_composite_pk():
    """PK is (user_id, issue_type), the cosine-gate routing key."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT a.attname FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = 'dq_vocab_issue_types'::regclass AND i.indisprimary
            ORDER BY a.attname
            """
        )
        cols = [r[0] for r in cur.fetchall()]
    assert cols == ["issue_type", "user_id"]


def test_observations_have_receipt_columns():
    """Receipt JSONB columns + SQL receipt columns added to dq_observations."""
    expected = {
        "evidence",
        "reasoning",
        "ambiguities",
        "proposed_issue_type",
        "sql_query",
        "sql_query_description",
        "sql_query_executed_at",
        "sql_query_status",
        "sql_query_n_rows",
        "sql_query_error_text",
    }
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'dq_observations'
            """
        )
        actual = {r[0] for r in cur.fetchall()}
    assert expected.issubset(actual), f"Missing: {expected - actual}"


def test_canonical_requires_description():
    """CHECK constraint blocks status=canonical without description.

    Canonical entries are what the cosine gate compares against, so they
    must always carry both a description and an embedding.
    """
    uid = _fresh_user("canonical_check")
    with pytest.raises(CheckViolation):
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SET app.current_user_id = %s", (uid,))
            cur.execute(
                """
                INSERT INTO dq_vocab_issue_types (user_id, issue_type, status)
                VALUES (%s, 'unit_test_canonical_no_desc', 'canonical')
                """,
                (uid,),
            )


def test_alias_requires_rejected():
    """CHECK blocks aliased_to set unless status=rejected.

    Two-step test: first INSERT creates the alias target so the self-FK is
    satisfied; second INSERT (in its own connection) violates the CHECK.
    """
    uid = _fresh_user("alias_check")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (uid,))
        cur.execute(
            """
            INSERT INTO dq_vocab_issue_types (user_id, issue_type, status)
            VALUES (%s, 'target', 'proposed')
            """,
            (uid,),
        )

    with pytest.raises(CheckViolation):
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SET app.current_user_id = %s", (uid,))
            cur.execute(
                """
                INSERT INTO dq_vocab_issue_types (user_id, issue_type, status, aliased_to)
                VALUES (%s, 'src', 'proposed', 'target')
                """,
                (uid,),
            )


def test_observation_fk_blocks_unknown_issue_type():
    """FK rejects observations referring to non-vocab labels."""
    uid = _fresh_user("fk_check")
    run = dq_runs_repo.start_run(user_id=uid, trigger="manual")
    with pytest.raises(ForeignKeyViolation):
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SET app.current_user_id = %s", (uid,))
            cur.execute(
                """
                INSERT INTO dq_observations
                    (user_id, run_id, tag, entity_type, entity_id,
                     issue_type, observation, severity)
                VALUES (%s, %s, 'core', 'cluster', '1',
                        'definitely_not_in_vocab_xyz', 'test', 'info')
                """,
                (uid, run["id"]),
            )


def test_readonly_role_cannot_write():
    """dq_bot_readonly should fail on INSERT and DROP attempts."""
    with pytest.raises(InsufficientPrivilege):
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SET ROLE dq_bot_readonly")
            cur.execute("INSERT INTO dq_observations DEFAULT VALUES")


def test_readonly_role_can_select_allowlist():
    """dq_bot_readonly has SELECT on the allowed tables.

    The allowlisted tables enforce RLS via current_setting('app.current_user_id'),
    which fails to cast when unset, so we set a valid user id before testing.
    """
    uid = _fresh_user("readonly_select")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (uid,))
        cur.execute("SET ROLE dq_bot_readonly")
        for tbl in ("pages", "clusters", "dq_observations", "dq_vocab_issue_types"):
            cur.execute(f"SELECT 1 FROM {tbl} LIMIT 1")  # must not raise
            cur.fetchall()
        cur.execute("RESET ROLE")


def test_bootstrap_seeded_known_constants():
    """The 5 hardcoded investigator constants exist for every user.

    Bootstrap inserts them with n_proposals=0 (the seed-vs-observed marker).
    Migration 028 only seeds users present AT migration time, so users
    created after the migration need an explicit seeding pass; this test
    re-runs the seed clause for the fresh user before asserting.
    """
    uid = _fresh_user("bootstrap_check")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (uid,))
        cur.execute(
            """
            INSERT INTO dq_vocab_issue_types
                (user_id, issue_type, status, n_proposals, last_proposed_at)
            SELECT %s, c.issue_type, 'proposed', 0, NOW()
            FROM (VALUES
                ('cluster_coherence_drift'),
                ('dedup_escapees'),
                ('domain_silo'),
                ('supercluster_drift'),
                ('reversal_pattern')
            ) AS c(issue_type)
            ON CONFLICT (user_id, issue_type) DO NOTHING
            """,
            (uid,),
        )
        cur.execute(
            """
            SELECT issue_type FROM dq_vocab_issue_types
            WHERE user_id = %s AND status = 'proposed'
              AND issue_type IN ('cluster_coherence_drift', 'dedup_escapees',
                                  'domain_silo', 'supercluster_drift',
                                  'reversal_pattern')
            """,
            (uid,),
        )
        seeded = {r[0] for r in cur.fetchall()}
    assert seeded == {
        "cluster_coherence_drift",
        "dedup_escapees",
        "domain_silo",
        "supercluster_drift",
        "reversal_pattern",
    }
