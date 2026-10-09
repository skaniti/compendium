"""trusted_browsers repository (tailnet-passwordless-login, Task 1)."""
import pytest

from backend.db import trusted_browser_repo as repo
from backend.db import user_repo
from backend.db.connection import get_conn


def _pg_reachable() -> bool:
    try:
        from backend.config.settings import settings
        from psycopg2 import connect

        connect(settings.test_database_url).close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")


@pytest.fixture
def users():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
    owner = user_repo.create_user("owner@test.local", name="Owner")
    other = user_repo.create_user("other@test.local", name="Other")
    return owner, other


def test_create_and_get_active(users):
    owner, _ = users
    bid = repo.create(owner["id"], "a" * 64, "Firefox on Linux")
    assert repo.get_active("a" * 64) == {"id": bid, "user_id": owner["id"]}
    assert repo.get_active("b" * 64) is None


def test_touch_sets_last_used(users):
    owner, _ = users
    bid = repo.create(owner["id"], "c" * 64, None)
    repo.touch(bid)
    row = next(r for r in repo.list_all() if r["id"] == bid)
    assert row["last_used_at"] is not None


def test_revoke_hides_the_row_and_is_idempotent(users):
    owner, _ = users
    bid = repo.create(owner["id"], "d" * 64, None)
    assert repo.revoke(bid) is True
    assert repo.get_active("d" * 64) is None
    assert repo.revoke(bid) is False


def test_revoke_all_scopes_to_a_user(users):
    owner, other = users
    repo.create(owner["id"], "e" * 64, None)
    repo.create(owner["id"], "f" * 64, None)
    keep = repo.create(other["id"], "0" * 64, None)
    assert repo.revoke_all(owner["id"]) == 2
    assert repo.get_active("0" * 64) == {"id": keep, "user_id": other["id"]}
    assert repo.revoke_all() == 1


def test_rows_go_with_their_user(users):
    owner, _ = users
    repo.create(owner["id"], "1" * 64, None)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM users WHERE id = %s", (owner["id"],))
    assert repo.get_active("1" * 64) is None
