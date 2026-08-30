"""Migration 034: dq_runs gains 'queued' status + abort_requested column."""

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import user_repo
from backend.db.connection import get_conn


@pytest.fixture
def user_id():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE dq_runs CASCADE")
        cur.execute("TRUNCATE users CASCADE")
    return user_repo.create_user(email="m34@example.com", name="m34")["id"]


def test_queued_status_is_accepted(user_id):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO dq_runs (user_id, trigger, status) VALUES (%s, 'manual', 'queued') RETURNING status, abort_requested",
            (user_id,),
        )
        status, abort_requested = cur.fetchone()
    assert status == "queued"
    assert abort_requested is False


def test_invalid_status_still_rejected(user_id):
    import psycopg2

    with pytest.raises(psycopg2.errors.CheckViolation):
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO dq_runs (user_id, trigger, status) VALUES (%s, 'manual', 'bogus')",
                (user_id,),
            )
