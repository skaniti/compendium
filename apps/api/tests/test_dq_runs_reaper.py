import itertools

import pytest

from backend.db import dq_runs_repo
from backend.db.connection import get_conn

_DUMMY_HASH = "x" * 60  # satisfies api_key_hash NOT NULL; not a real bcrypt hash
_counter = itertools.count(1)  # unique suffix across all calls in a session


@pytest.fixture(autouse=True)
def _clean_tables():
    """Delete @x.test users (+ cascading dq_runs rows) before each test."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM users WHERE email LIKE '%@x.test'")


def _stuck_run(minutes_ago: int) -> tuple[int, int]:
    n = next(_counter)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (email, name, api_key_hash, api_key_prefix)"
            " VALUES (%s, %s, %s, %s) RETURNING id",
            (f"dq{n}@x.test", "d", f"{_DUMMY_HASH}{n}", f"d{n:07d}"),
        )
        uid = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO dq_runs (user_id, trigger, status, started_at) "
            "VALUES (%s, 'manual', 'running', now() - make_interval(mins => %s)) RETURNING id",
            (uid, minutes_ago),
        )
        return uid, cur.fetchone()[0]


def test_reap_fails_old_running_dq_runs():
    uid, run_id = _stuck_run(200)
    assert dq_runs_repo.reap_stale_runs() >= 1
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM dq_runs WHERE id=%s", (run_id,))
        assert cur.fetchone()[0] == "failed"


def test_reap_leaves_fresh_running_dq_runs():
    uid, run_id = _stuck_run(5)
    dq_runs_repo.reap_stale_runs()
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM dq_runs WHERE id=%s", (run_id,))
        assert cur.fetchone()[0] == "running"
