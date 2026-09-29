"""Repository for the users table."""

import secrets

import bcrypt

from backend.api.audit_ctx import CLI, AuditCtx
from backend.db import audit_repo
from backend.db.connection import get_conn


def create_user(email: str, name: str | None = None) -> dict:
    """Create a user and generate an API key.

    Returns dict with 'id', 'email', 'name', 'api_key' (plaintext, shown once),
    and 'api_key_prefix'.
    """
    raw_key = f"cmp_{secrets.token_urlsafe(32)}"
    prefix = raw_key[:8]
    key_hash = bcrypt.hashpw(raw_key.encode(), bcrypt.gensalt()).decode()

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (email, name, api_key_hash, api_key_prefix)
                VALUES (%s, %s, %s, %s)
                RETURNING id, email, name, api_key_prefix, created_at
                """,
                (email, name, key_hash, prefix),
            )
            row = cur.fetchone()

    return {
        "id": row[0],
        "email": row[1],
        "name": row[2],
        "api_key_prefix": row[3],
        "created_at": row[4],
        "api_key": raw_key,
    }


def rotate_api_key(email: str, audit_ctx: AuditCtx | None = None) -> dict | None:
    """Generate a fresh API key for an existing user, replacing the old one.

    The old key stops authenticating the instant this commits -- every
    client holding it (browser extension, Android collector, ~/.secrets)
    needs reconfiguring with the returned plaintext key.

    Returns dict with 'id', 'email', 'api_key' (plaintext, shown once),
    and 'api_key_prefix'; None if no user has that email.
    """
    raw_key = f"cmp_{secrets.token_urlsafe(32)}"
    prefix = raw_key[:8]
    key_hash = bcrypt.hashpw(raw_key.encode(), bcrypt.gensalt()).decode()

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT api_key_prefix FROM users WHERE email = %s", (email,))
            old = cur.fetchone()
            cur.execute(
                """
                UPDATE users SET api_key_hash = %s, api_key_prefix = %s
                WHERE email = %s
                RETURNING id, email, api_key_prefix
                """,
                (key_hash, prefix, email),
            )
            row = cur.fetchone()

    if row is None:
        return None

    ctx = audit_ctx or CLI
    audit_repo.record(
        "api_key.rotated",
        subject_user_id=row[0],
        origin_class=ctx.origin_class,
        client_key=ctx.client_key,
        detail={"old_prefix": old[0] if old else None, "new_prefix": row[2]},
    )

    return {
        "id": row[0],
        "email": row[1],
        "api_key_prefix": row[2],
        "api_key": raw_key,
    }


def get_user_by_api_key(raw_key: str) -> dict | None:
    """Look up a user by raw API key. Returns user dict or None."""
    prefix = raw_key[:8]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, email, name, api_key_hash, api_key_prefix, created_at "
                "FROM users WHERE api_key_prefix = %s",
                (prefix,),
            )
            row = cur.fetchone()

    if row is None:
        return None

    stored_hash = row[3]
    if not bcrypt.checkpw(raw_key.encode(), stored_hash.encode()):
        return None

    # Update last_used_at
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET last_used_at = NOW() WHERE id = %s",
                (row[0],),
            )

    return {
        "id": row[0],
        "email": row[1],
        "name": row[2],
        "api_key_prefix": row[4],
        "created_at": row[5],
    }


def get_user_by_id(user_id: int) -> dict | None:
    """Look up a user by ID.

    Returns ``preferences`` JSONB alongside the rest of the row so callers
    that need to gate behaviour on a flag (e.g. the dqBot recluster-event
    hook checking ``enable_scheduled_runs``) don't have to round-trip to
    ``auth_repo.get_preferences``.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, email, name, api_key_prefix, created_at, preferences "
                "FROM users WHERE id = %s",
                (user_id,),
            )
            row = cur.fetchone()

    if row is None:
        return None

    return {
        "id": row[0],
        "email": row[1],
        "name": row[2],
        "api_key_prefix": row[3],
        "created_at": row[4],
        "preferences": row[5] or {},
    }


def list_users_with_pref(key: str, value) -> list[dict]:
    """Return users whose preferences JSONB contains ``{key: value}``.

    Used by the dqBot scheduler to enumerate opted-in users for the weekly
    investigation tick (Task 6.1). The query uses ``preferences->>key``
    which returns the value as text; for booleans we compare against
    ``'true'``/``'false'`` (psycopg2's JSONB text-coercion convention).

    For non-bool, non-string values (ints, floats), the caller's value is
    str()-coerced -- callers that need exotic comparisons should use a
    different helper.
    """
    if isinstance(value, bool):
        compare_text = "true" if value else "false"
    else:
        compare_text = str(value)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, email, name, preferences
                FROM users
                WHERE preferences->>%s = %s
                """,
                (key, compare_text),
            )
            return [
                {
                    "id": r[0],
                    "email": r[1],
                    "name": r[2],
                    "preferences": r[3],
                }
                for r in cur.fetchall()
            ]
