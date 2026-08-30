"""Integration tests for user_repo helpers added in Task 6.1.

The fixture truncates ``users`` per-test so each scenario starts clean.
``list_users_with_pref`` is the only helper exercised here today; if more
helpers land later they should follow the same pattern (per-test truncate,
seed via ``user_repo.create_user`` + ``auth_repo.update_preferences``).
"""

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import auth_repo, user_repo
from backend.db.connection import get_conn


@pytest.fixture(autouse=True)
def _clean_users():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
    yield


def _seed_user_with_prefs(email: str, prefs: dict | None) -> int:
    """Create a user, optionally seed a preferences blob, return id."""
    u = user_repo.create_user(email=email, name=email.split("@")[0])
    if prefs is not None:
        auth_repo.update_preferences(u["id"], prefs)
    return u["id"]


# ---------------------------------------------------------------------------
# list_users_with_pref
# ---------------------------------------------------------------------------


def test_list_users_with_pref_returns_only_opted_in_user():
    """User A opts in (true), B opts out (false), C has no key. Only A is returned."""
    a = _seed_user_with_prefs("a@example.com", {"enable_scheduled_runs": True})
    _seed_user_with_prefs("b@example.com", {"enable_scheduled_runs": False})
    _seed_user_with_prefs("c@example.com", {})

    rows = user_repo.list_users_with_pref("enable_scheduled_runs", True)

    assert len(rows) == 1, (
        f"Expected exactly one user matching enable_scheduled_runs=True; got {len(rows)}: "
        f"{[r['email'] for r in rows]}"
    )
    assert rows[0]["id"] == a
    assert rows[0]["email"] == "a@example.com"
    # The preferences dict round-trips so the scheduler can read other prefs
    # off the same row without a second query.
    assert rows[0]["preferences"].get("enable_scheduled_runs") is True


def test_list_users_with_pref_returns_empty_when_none_match():
    """No user has the key -> empty list (not an error)."""
    _seed_user_with_prefs("a@example.com", {"some_other_pref": True})
    _seed_user_with_prefs("b@example.com", None)

    rows = user_repo.list_users_with_pref("enable_scheduled_runs", True)

    assert rows == []


def test_list_users_with_pref_handles_false_value():
    """Passing False matches users with the key set to false (not the absence of the key)."""
    a = _seed_user_with_prefs("a@example.com", {"enable_scheduled_runs": True})
    b = _seed_user_with_prefs("b@example.com", {"enable_scheduled_runs": False})
    _seed_user_with_prefs("c@example.com", {})  # key absent

    rows = user_repo.list_users_with_pref("enable_scheduled_runs", False)

    ids = sorted(r["id"] for r in rows)
    assert ids == [b], (
        f"Expected only user B (key explicitly false); got ids={ids}. "
        "User C (key absent) and A (true) must be excluded."
    )


def test_list_users_with_pref_returns_empty_when_no_users():
    """No users at all -> empty list."""
    rows = user_repo.list_users_with_pref("enable_scheduled_runs", True)
    assert rows == []
