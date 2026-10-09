"""scripts/trusted_browsers.py (tailnet-passwordless-login, Task 4)."""
import pytest

from backend.db import auth_repo, trusted_browser_repo, user_repo
from backend.db.connection import get_conn
from backend.services import auth_service
from scripts import trusted_browsers as cli


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
def owner():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
    return user_repo.create_user("owner@test.local", name="Owner")


def test_list_shows_rows_without_hashes(owner, capsys):
    trusted_browser_repo.create(owner["id"], "a" * 64, "Firefox on Linux")
    assert cli.main(["list"]) == 0
    out = capsys.readouterr().out
    assert "Firefox on Linux" in out and "a" * 64 not in out


def test_revoke_one(owner, capsys):
    bid = trusted_browser_repo.create(owner["id"], "b" * 64, None)
    assert cli.main(["revoke", str(bid)]) == 0
    assert trusted_browser_repo.get_active("b" * 64) is None
    assert cli.main(["revoke", str(bid)]) == 1


def test_revoke_all_for_a_user_with_sessions(owner):
    trusted_browser_repo.create(owner["id"], "c" * 64, None)
    raw = auth_service.create_refresh_token(owner["id"], remembered=True)
    assert cli.main(["revoke-all", "--user", "owner@test.local", "--sessions"]) == 0
    assert trusted_browser_repo.get_active("c" * 64) is None
    assert auth_repo.get_refresh_token(auth_service._hash_token(raw))["revoked_at"] is not None


def test_revoke_all_unknown_user_fails(owner):
    assert cli.main(["revoke-all", "--user", "nobody@test.local"]) == 1
