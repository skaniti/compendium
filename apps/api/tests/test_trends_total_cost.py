import itertools

import pytest

from backend.db import trends_repo
from backend.db.connection import get_conn

_DUMMY_HASH = "x" * 60  # satisfies api_key_hash NOT NULL; not a real bcrypt hash
_counter = itertools.count(1)  # unique suffix per session to avoid email collisions


@pytest.fixture(autouse=True)
def _clean_tables():
    """Delete @x.test users (+ cascading cost_events) before each test."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM users WHERE email LIKE '%@x.test'")


def _user_with_costs(*costs) -> int:
    n = next(_counter)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (email, name, api_key_hash, api_key_prefix)"
            " VALUES (%s, %s, %s, %s) RETURNING id",
            (f"cost{n}@x.test", "c", f"{_DUMMY_HASH}{n}", f"c{n:07d}"),
        )
        uid = cur.fetchone()[0]
        for c in costs:
            cur.execute(
                "INSERT INTO cost_events (user_id, event_type, model, cost_usd)"
                " VALUES (%s, 'skip_gate', 'gpt-4o-mini', %s)",
                (uid, c),
            )
        return uid


def test_get_total_cost_sums_user_events():
    uid = _user_with_costs(0.01, 0.02, 0.03)
    assert round(trends_repo.get_total_cost_usd(uid), 4) == 0.06


def test_get_total_cost_zero_when_none():
    n = next(_counter)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (email, name, api_key_hash, api_key_prefix)"
            " VALUES (%s, %s, %s, %s) RETURNING id",
            (f"nocost{n}@x.test", "n", f"{_DUMMY_HASH}{n}", f"n{n:07d}"),
        )
        uid = cur.fetchone()[0]
    assert trends_repo.get_total_cost_usd(uid) == 0.0
