"""PostgreSQL connection pool and context manager."""

import logging
import threading
from contextlib import contextmanager

from psycopg2 import pool

from backend.config.settings import settings

logger = logging.getLogger(__name__)

_pool: pool.ThreadedConnectionPool | None = None

# DSN override — set by test fixtures to redirect connections to the test DB.
_dsn_override: str | None = None

# Thread-local storage for the current user_id (set by auth middleware)
_local = threading.local()


def set_current_user_id(user_id: int) -> None:
    """Set the current user ID for RLS policies.

    Called by the auth middleware on each request. The next get_conn()
    call will SET app.current_user_id on the connection.
    """
    _local.user_id = user_id


def _get_current_user_id() -> int | None:
    """Get the current user ID from thread-local storage."""
    return getattr(_local, "user_id", None)


def set_dsn_override(dsn: str | None) -> None:
    """Override the database URL used by the connection pool.

    Call with a URL to redirect all connections (e.g., to a test DB).
    Call with None to revert to settings.database_url.
    Forces pool recreation on next get_conn() call.
    """
    global _dsn_override, _pool
    _dsn_override = dsn
    if _pool is not None and not _pool.closed:
        _pool.closeall()
        _pool = None


def _get_pool() -> pool.ThreadedConnectionPool:
    """Lazy-initialize the connection pool."""
    global _pool
    if _pool is None or _pool.closed:
        dsn = _dsn_override or settings.database_url
        logger.info("Creating PostgreSQL connection pool → %s", dsn.split("@")[-1])
        _pool = pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=10,
            dsn=dsn,
        )
    return _pool


@contextmanager
def get_conn():
    """Yield a connection from the pool; auto-return on exit.

    If a user_id has been set via set_current_user_id(), it is applied
    as a session variable for row-level security policies.

    Usage::

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
    """
    p = _get_pool()
    conn = p.getconn()
    try:
        # Set RLS session variable if a user_id is available
        uid = _get_current_user_id()
        if uid is not None:
            with conn.cursor() as cur:
                cur.execute("SET app.current_user_id = %s", (str(uid),))

        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        # Reset the session variable before returning to pool
        try:
            with conn.cursor() as cur:
                cur.execute("RESET app.current_user_id")
            conn.commit()
        except Exception:
            pass
        p.putconn(conn)


@contextmanager
def get_readonly_db_conn(user_id: int):
    """Yield a connection scoped to the dq_bot_readonly role + RLS user.

    Used by the SQL receipt service (dq_sql_receipt) to execute dqbot's
    pre-generated SELECT statements. Defense-in-depth: SELECT-only grants
    + 5s statement_timeout (set on the role at migration time) keep the
    role from doing damage even if the in-process sqlparse validator
    misses something.

    SET ROLE persists for the connection lifetime; we RESET ROLE before
    returning the connection to the pool so subsequent users aren't
    sandbagged into a low-privilege session.
    """
    p = _get_pool()
    conn = p.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute("SET app.current_user_id = %s", (str(user_id),))
            cur.execute("SET ROLE dq_bot_readonly")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        try:
            with conn.cursor() as cur:
                cur.execute("RESET ROLE")
                cur.execute("RESET app.current_user_id")
            conn.commit()
        except Exception:
            pass
        p.putconn(conn)


def close_pool() -> None:
    """Shut down the connection pool (call on app shutdown)."""
    global _pool
    if _pool is not None and not _pool.closed:
        _pool.closeall()
        _pool = None
        logger.info("PostgreSQL connection pool closed")
