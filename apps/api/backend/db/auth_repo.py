"""Repository for JWT auth: password users, refresh tokens, preferences."""

from datetime import datetime

from backend.db.connection import get_conn


# ── Password-based users ────────────────────────────────────────────────


def set_password(user_id: int, password_hash: str) -> None:
    """Set (or update) a user's password hash."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET password_hash = %s WHERE id = %s",
                (password_hash, user_id),
            )


def set_role(user_id: int, role: str) -> None:
    """Set a user's permission role. Constrained to admin / demo / user
    by the CHECK on users.role (migration 029). Callers should use the
    bootstrap script as the canonical assignment site; ad-hoc calls
    elsewhere should be rare."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET role = %s WHERE id = %s",
                (role, user_id),
            )


def get_role(user_id: int) -> str:
    """Return a user's role string ('admin' / 'demo' / 'user'). Returns
    'user' as a safe default if the row is missing — callers can treat
    a missing user the same as an unprivileged one without an extra
    None check."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT role FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
            return row[0] if row else "user"


def get_user_by_email(email: str) -> dict | None:
    """Look up a user by email, including password_hash for login verification."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, email, name, password_hash, api_key_prefix, created_at
                FROM users WHERE email = %s
                """,
                (email,),
            )
            row = cur.fetchone()

    if row is None:
        return None

    return {
        "id": row[0],
        "email": row[1],
        "name": row[2],
        "password_hash": row[3],
        "api_key_prefix": row[4],
        "created_at": row[5],
    }


def get_user_by_login(identifier: str) -> dict | None:
    """Look up a user by email OR username, for the login path.

    Email is matched exactly, preserving the historical
    ``get_user_by_email`` behaviour byte-for-byte (so existing email
    logins cannot regress). ``username`` (migration 032) is matched
    case-insensitively. Returns the identical dict shape to
    ``get_user_by_email`` so the two are interchangeable at call sites.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, email, name, password_hash, api_key_prefix, created_at
                FROM users
                WHERE email = %s OR lower(username) = lower(%s)
                LIMIT 1
                """,
                (identifier, identifier),
            )
            row = cur.fetchone()

    if row is None:
        return None

    return {
        "id": row[0],
        "email": row[1],
        "name": row[2],
        "password_hash": row[3],
        "api_key_prefix": row[4],
        "created_at": row[5],
    }


# ── Refresh tokens ─────────────────────────────────────────────────────


def save_refresh_token(
    user_id: int, token_hash: str, expires_at: datetime, remembered: bool = False
) -> int:
    """Store a hashed refresh token. Returns the token row ID.

    ``remembered`` (migration 044) records that this token was minted while
    the request's ingress verdict was tailnet-trusted (see
    ``auth_service.ingress_trusted``) -- not a client "keep me signed in"
    opt-in. It is recomputed from the current ingress verdict at every mint
    (login and each rotation), never carried forward from a stored token's
    own flag, so ``session_policy`` stays derived from the DB without
    re-trusting client input.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO refresh_tokens (user_id, token_hash, expires_at, remembered)
                VALUES (%s, %s, %s, %s)
                RETURNING id
                """,
                (user_id, token_hash, expires_at, remembered),
            )
            return cur.fetchone()[0]


def get_refresh_token(token_hash: str) -> dict | None:
    """Look up a refresh token by its hash. Returns None if not found."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, user_id, token_hash, expires_at, created_at, revoked_at, remembered
                FROM refresh_tokens
                WHERE token_hash = %s
                """,
                (token_hash,),
            )
            row = cur.fetchone()

    if row is None:
        return None

    return {
        "id": row[0],
        "user_id": row[1],
        "token_hash": row[2],
        "expires_at": row[3],
        "created_at": row[4],
        "revoked_at": row[5],
        "remembered": row[6],
    }


def revoke_refresh_token(token_hash: str) -> None:
    """Mark a refresh token as revoked."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = %s",
                (token_hash,),
            )


def revoke_all_user_tokens(user_id: int) -> int:
    """Revoke all active refresh tokens for a user (logout everywhere).

    Returns the number of tokens revoked.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE refresh_tokens SET revoked_at = NOW()
                WHERE user_id = %s AND revoked_at IS NULL
                """,
                (user_id,),
            )
            return cur.rowcount


def cleanup_expired_tokens() -> int:
    """Delete tokens that are expired or revoked. Returns count deleted."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM refresh_tokens
                WHERE revoked_at IS NOT NULL OR expires_at < NOW()
                """,
            )
            return cur.rowcount


# ── User preferences ───────────────────────────────────────────────────


def update_preferences(user_id: int, preferences: dict) -> None:
    """Merge new preferences into the existing JSONB (shallow merge)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE users
                SET preferences = COALESCE(preferences, '{}'::jsonb) || %s::jsonb
                WHERE id = %s
                """,
                (__import__("json").dumps(preferences), user_id),
            )


def get_preferences(user_id: int) -> dict:
    """Return the user's preferences dict (empty dict if none set)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT preferences FROM users WHERE id = %s",
                (user_id,),
            )
            row = cur.fetchone()
    return row[0] if row and row[0] else {}
