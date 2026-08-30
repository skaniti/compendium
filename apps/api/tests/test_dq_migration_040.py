"""Verify migration 040 re-applies the dq_bot_readonly grants and adds
dq_runs.failure_reason.

Follows tests/test_dq_migration_028.py's pattern: migrations are applied to
the test DB by the session-scoped fixture in conftest.py, so by the time
these tests run, migration 040's schema changes already exist. These tests
assert the *idempotent-reapply* facts that motivated 040 in the first
place -- role exists, grants are present, failure_reason column exists --
rather than re-testing 028's own structural assertions (vocab table, RLS,
etc.), which stay in test_dq_migration_028.py.
"""

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(), reason="Test PostgreSQL not reachable"
)

from backend.db.connection import get_conn
from backend.services.dq_sql_receipt import READONLY_ALLOWLIST


def test_dq_bot_readonly_role_exists():
    """The role exists and is NOLOGIN (SQL receipts SET ROLE into it; it
    never authenticates directly)."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'dq_bot_readonly'"
        )
        row = cur.fetchone()
    assert row is not None, "dq_bot_readonly role must exist after migration 040"
    assert row[1] is False, "dq_bot_readonly must be NOLOGIN"


def test_dq_bot_readonly_has_select_on_allowlist():
    """Every table in dq_sql_receipt.READONLY_ALLOWLIST has an actual SELECT
    grant for dq_bot_readonly. This is the exact drift migration 040 fixes:
    the role existed on compendium-server, but with zero table grants,
    because dump/restore doesn't carry role ACLs even when the
    schema_migrations ledger says 028 already ran."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name FROM information_schema.role_table_grants
            WHERE grantee = 'dq_bot_readonly' AND privilege_type = 'SELECT'
            """
        )
        granted = {r[0] for r in cur.fetchall()}
    missing = set(READONLY_ALLOWLIST) - granted
    assert not missing, f"dq_bot_readonly missing SELECT grant on: {missing}"


def test_dq_bot_readonly_has_schema_usage():
    """information_schema.usage_privileges doesn't reliably surface schema
    grants across PG versions; has_schema_privilege() is the direct ACL check."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT has_schema_privilege('dq_bot_readonly', 'public', 'USAGE')")
        row = cur.fetchone()
    assert row is not None and row[0] is True, "dq_bot_readonly must have USAGE on schema public"


def test_dq_bot_readonly_has_statement_timeout():
    """ALTER ROLE ... SET statement_timeout = '5s' is stored in pg_roles.rolconfig."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT rolconfig FROM pg_roles WHERE rolname = 'dq_bot_readonly'")
        row = cur.fetchone()
    assert row is not None
    rolconfig = row[0] or []
    assert any(c.startswith("statement_timeout=") for c in rolconfig), (
        f"expected a statement_timeout entry in rolconfig, got: {rolconfig}"
    )


def test_dq_runs_has_failure_reason_column():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, data_type FROM information_schema.columns
            WHERE table_name = 'dq_runs' AND column_name = 'failure_reason'
            """
        )
        row = cur.fetchone()
    assert row is not None, "dq_runs.failure_reason must exist after migration 040"
    assert row[1] == "text"


def test_dq_bot_readonly_cannot_select_off_allowlist():
    """Sanity check: the allowlist grant is scoped, not schema-wide SELECT.
    `users` holds password hashes and must stay off the readonly role's grants."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.role_table_grants
            WHERE grantee = 'dq_bot_readonly' AND table_name = 'users'
              AND privilege_type = 'SELECT'
            """
        )
        row = cur.fetchone()
    assert row is None, "dq_bot_readonly must not have SELECT on users"
