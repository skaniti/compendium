"""Create and migrate the test database.

Usage:
    python scripts/init_test_db.py

Idempotent — drops and recreates the test DB each time to guarantee
a clean schema matching current migrations.
"""

import logging
import sys
from pathlib import Path

# Ensure project root is on sys.path
_ROOT = str(Path(__file__).resolve().parent.parent)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

from backend.config.settings import settings

logger = logging.getLogger(__name__)

TEST_DB_NAME = "traversal_discovery_test"


def init_test_db():
    # Connect to the 'postgres' system database to issue CREATE/DROP
    base_url = settings.database_url.rsplit("/", 1)[0] + "/postgres"

    conn = psycopg2.connect(base_url)
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)

    with conn.cursor() as cur:
        # Terminate any existing connections to the test DB
        cur.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = %s AND pid != pg_backend_pid()",
            (TEST_DB_NAME,),
        )
        cur.execute(f"DROP DATABASE IF EXISTS {TEST_DB_NAME}")
        cur.execute(f"CREATE DATABASE {TEST_DB_NAME}")
    conn.close()
    print(f"Created database: {TEST_DB_NAME}")

    # Connect to the new test DB and enable pgvector
    test_conn = psycopg2.connect(settings.test_database_url)
    test_conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    with test_conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
    test_conn.close()

    # Redirect the connection pool to the test DB and run migrations
    from backend.db.connection import set_dsn_override, close_pool

    set_dsn_override(settings.test_database_url)
    try:
        from backend.db.migrate import run_migrations

        applied = run_migrations()
        print(f"Test DB ready — applied {len(applied)} migration(s)")
    finally:
        close_pool()
        set_dsn_override(None)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    init_test_db()
