"""Verify migration 057: dq_overrides.unmatched_generations / retired_reason.

Migrations are applied by the session fixture in conftest.py (same pattern
as test_dq_migration_040.py / _042.py).
"""

import pathlib

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(), reason="Test PostgreSQL not reachable"
)

from backend.db.connection import get_conn


def _columns():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'dq_overrides'
              AND column_name IN ('unmatched_generations', 'retired_reason')
            """
        )
        return {r[0]: r[1:] for r in cur.fetchall()}


def test_columns_exist_with_expected_shape():
    cols = _columns()
    assert cols["unmatched_generations"][0] == "integer"
    assert cols["unmatched_generations"][1] == "NO"
    assert cols["unmatched_generations"][2] == "0"
    assert cols["retired_reason"][0] == "text"
    assert cols["retired_reason"][1] == "YES"


def test_migration_is_idempotent():
    sql = (
        pathlib.Path(__file__).parent.parent
        / "backend" / "db" / "migrations" / "057_dq_overrides_unmatched_generations.sql"
    ).read_text()
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql)
    assert set(_columns()) == {"unmatched_generations", "retired_reason"}
