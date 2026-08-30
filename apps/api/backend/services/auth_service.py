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


def create_refresh_token(user_id: int) -> str:
    """Create a long-lived refresh token, store its hash in the DB.

    Returns the raw token (to be sent to the client).
    """
    raw_token = secrets.token_urlsafe(48)
    token_hash = _hash_token(raw_token)
    expires_at = datetime.now(timezone.utc) + timedelta(
        days=settings.jwt_refresh_token_expire_days
    )
    auth_repo.save_refresh_token(user_id, token_hash, expires_at)
    return raw_token


def rotate_refresh_token(raw_token: str) -> tuple[str, str] | None:
    """Validate a refresh token, revoke it, and issue new access + refresh.

    Returns (new_access_token, new_refresh_token) or None if invalid.
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

    access = create_access_token(user["id"], user["email"])
    refresh = create_refresh_token(user["id"])
    return access, refresh


def revoke_refresh_token(raw_token: str) -> None:
    """Revoke a single refresh token (logout)."""
    auth_repo.revoke_refresh_token(_hash_token(raw_token))
