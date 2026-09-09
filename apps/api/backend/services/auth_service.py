"""JWT authentication service: token creation, verification, password hashing."""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt

from backend.config.settings import settings
from backend.db import auth_repo


# ── Password hashing ───────────────────────────────────────────────────


def hash_password(password: str) -> str:
    """Hash a password with bcrypt."""
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its bcrypt hash."""
    return bcrypt.checkpw(password.encode(), hashed.encode())


# ── JWT access tokens ──────────────────────────────────────────────────


_RESERVED_CLAIMS = frozenset({"sub", "email", "iat", "exp", "type"})


def create_access_token(
    user_id: int,
    email: str,
    expires_minutes: int | None = None,
    extra_claims: dict | None = None,
) -> str:
    """Create a JWT access token.

    ``expires_minutes`` overrides ``settings.jwt_access_token_expire_minutes``.
    The Dash login flow passes the Flask permanent-session lifetime (7 days)
    so a server-side session doesn't 401 mid-use against a 15-minute default.

    ``extra_claims`` merges additional key/value pairs into the payload
    (e.g. the view-as-demo switch's ``acting_as_demo`` /
    ``admin_origin_user_id`` markers). Backward compatible: omitting it
    produces the exact same payload as before. Any key colliding with a
    reserved claim (sub/email/iat/exp/type) is silently dropped rather than
    allowed to override the core identity/expiry fields.
    """
    import jwt

    now = datetime.now(timezone.utc)
    minutes = (
        expires_minutes
        if expires_minutes is not None
        else settings.jwt_access_token_expire_minutes
    )
    payload = {
        "sub": str(user_id),
        "email": email,
        "iat": now,
        "exp": now + timedelta(minutes=minutes),
        "type": "access",
    }
    if extra_claims:
        payload.update(
            {k: v for k, v in extra_claims.items() if k not in _RESERVED_CLAIMS}
        )
    return jwt.encode(payload, settings.jwt_secret_key, algorithm="HS256")


def decode_access_token(token: str) -> dict | None:
    """Decode and validate a JWT access token. Returns claims or None."""
    import jwt

    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=["HS256"])
        if payload.get("type") != "access":
            return None
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


# ── Refresh tokens ─────────────────────────────────────────────────────


def _hash_token(raw_token: str) -> str:
    """SHA-256 hash a raw refresh token for DB storage."""
    return hashlib.sha256(raw_token.encode()).hexdigest()


def create_refresh_token(user_id: int, remembered: bool = False) -> str:
    """Create a long-lived refresh token, store its hash in the DB.

    ``remembered`` (spec D1) selects the lifetime:
    ``jwt_refresh_token_expire_days_remembered`` (90 days) when True, else
    the default ``jwt_refresh_token_expire_days`` (7 days). Persisted
    alongside the token hash so a later rotation can carry the flag
    forward without re-trusting client input.

    Returns the raw token (to be sent to the client).
    """
    raw_token = secrets.token_urlsafe(48)
    token_hash = _hash_token(raw_token)
    days = (
        settings.jwt_refresh_token_expire_days_remembered
        if remembered
        else settings.jwt_refresh_token_expire_days
    )
    expires_at = datetime.now(timezone.utc) + timedelta(days=days)
    auth_repo.save_refresh_token(user_id, token_hash, expires_at, remembered=remembered)
    return raw_token


def rotate_refresh_token(raw_token: str) -> tuple[str, str, dict] | None:
    """Validate a refresh token, revoke it, and issue new access + refresh.

    Returns ``(new_access_token, new_refresh_token, session_policy)`` or
    None if invalid. The ``remembered`` flag on the stored token carries
    forward to the newly minted refresh token (spec D1), and the policy is
    recomputed from the user's current DB role -- a demoted/promoted user
    gets the right policy on their very next refresh.
    """
    token_hash = _hash_token(raw_token)
    stored = auth_repo.get_refresh_token(token_hash)

    if stored is None:
        return None

    # Already revoked (possible token reuse attack)
    if stored["revoked_at"] is not None:
        auth_repo.revoke_all_user_tokens(stored["user_id"])
        return None

    # Expired
    expires = stored["expires_at"]
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < datetime.now(timezone.utc):
        auth_repo.revoke_refresh_token(token_hash)
        return None

    # Revoke old, issue new
    auth_repo.revoke_refresh_token(token_hash)

    from backend.db import user_repo

    user = user_repo.get_user_by_id(stored["user_id"])
    if user is None:
        return None

    # Read the CURRENT role BEFORE minting -- spec D1's hard constraint (the
    # demo role can never hold a 90-day token) must hold even for a user
    # whose role changed to demo since the stored token was minted. Reading
    # role after minting (the pre-fix bug) let the new refresh token inherit
    # the stale `remembered` flag while only the *reported* policy reflected
    # the corrected role, so a demoted-to-demo user kept a 90-day token with
    # a policy that claimed remembered: False.
    role = auth_repo.get_role(user["id"])
    remembered = bool(stored["remembered"]) and role != "demo"
    access = create_access_token(user["id"], user["email"])
    refresh = create_refresh_token(user["id"], remembered=remembered)
    policy = session_policy(role, remembered)
    return access, refresh, policy


def revoke_refresh_token(raw_token: str) -> None:
    """Revoke a single refresh token (logout)."""
    auth_repo.revoke_refresh_token(_hash_token(raw_token))


# ── Session policy ─────────────────────────────────────────────────────


def session_policy(role: str, remembered: bool, acting: bool = False) -> dict:
    """Compute the per-``(role, remembered)`` session policy (spec D1).

    Returned to the client from login/refresh/view-as/return-to-admin so
    ``apps/web`` can decide idle-lapse and resume behavior without
    hardcoding lifetimes. The backend token lifetimes remain the actual
    enforcement -- this is informational, like ``session_expires_at``.

    ``acting=True`` (view-as-demo) takes priority over everything else:
    the 60-minute no-refresh cap is unchanged and ``remembered`` is always
    False for an acting session, regardless of the role/remembered inputs.

    ``role == "demo"`` forces ``remembered`` to False even if the caller
    passed True -- the public demo credential can never obtain a 90-day
    token or a no-idle policy (server-side, DB-derived role; never
    client-trusted).
    """
    if acting:
        return {
            "idle_minutes": settings.session_idle_minutes,
            "resume": False,
            "remembered": False,
        }
    if role == "demo":
        return {
            "idle_minutes": settings.session_idle_minutes_demo,
            "resume": True,
            "remembered": False,
        }
    if remembered:
        return {
            "idle_minutes": settings.session_idle_minutes_remembered,
            "resume": True,
            "remembered": True,
        }
    return {
        "idle_minutes": settings.session_idle_minutes,
        "resume": True,
        "remembered": False,
    }
