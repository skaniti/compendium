# tests/test_recluster_repo_guard.py
import itertools

import pytest

from backend.db import recluster_repo
from backend.db.connection import get_conn

_DUMMY_HASH = "x" * 60  # satisfies api_key_hash NOT NULL; not a real bcrypt hash
_counter = itertools.count(1)  # unique suffix across all calls in a session


@pytest.fixture(autouse=True)
def _clean_tables():
    """Truncate recluster_runs and test users before each test for isolation."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE recluster_runs CASCADE")
        cur.execute("DELETE FROM users WHERE email LIKE '%@x.test'")


def _make_user_and_run_age(minutes_ago: int) -> int:
    """Insert a user + a 'running' recluster run started `minutes_ago` minutes ago. Returns user_id."""
    n = next(_counter)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (email, name, api_key_hash, api_key_prefix) VALUES (%s, %s, %s, %s) RETURNING id",
            (f"guard{n}_{minutes_ago}@x.test", "g", f"{_DUMMY_HASH}{n}", f"g{n:07d}"),
        )
        uid = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO recluster_runs (user_id, status, started_at) "
            "VALUES (%s, 'running', now() - make_interval(mins => %s))",
            (uid, minutes_ago),
        )
        return uid


def test_start_run_if_idle_blocks_when_recent_running_exists():
    uid = _make_user_and_run_age(5)  # fresh running run
    assert recluster_repo.start_run_if_idle(uid) is None


def test_start_run_if_idle_allows_when_running_is_stale():
    uid = _make_user_and_run_age(200)  # stale running run (> 120m)
    run_id = recluster_repo.start_run_if_idle(uid)
    assert isinstance(run_id, int) and run_id > 0


def test_start_run_if_idle_allows_when_no_running():
    n = next(_counter)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (email, name, api_key_hash, api_key_prefix) VALUES (%s, %s, %s, %s) RETURNING id",
            (f"idle{n}@x.test", "i", f"{_DUMMY_HASH}{n}", f"i{n:07d}"),
        )
        uid = cur.fetchone()[0]
    run_id = recluster_repo.start_run_if_idle(uid)
    assert isinstance(run_id, int) and run_id > 0


def test_reap_stale_runs_fails_old_running_rows():
    uid = _make_user_and_run_age(200)
    reaped = recluster_repo.reap_stale_runs()
    assert reaped >= 1
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM recluster_runs WHERE user_id=%s ORDER BY id DESC LIMIT 1", (uid,))
        assert cur.fetchone()[0] == "failed"
