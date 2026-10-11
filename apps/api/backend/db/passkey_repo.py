"""Passkey rows (migration 052, owner-passkeys): WebAuthn credentials, the
per-account WebAuthn user handle, one-time enrollment links and single-use
challenges. Enrollment tokens arrive here already hashed; challenges are
hashed here. Expiry is always compared with the database clock."""

from __future__ import annotations

import hashlib
import secrets

from backend.db.connection import get_conn


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ── user handle ────────────────────────────────────────────────────────


def get_or_create_user_handle(user_id: int) -> bytes:
    """The account's random 64-byte WebAuthn user ID, created on first use."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE users SET webauthn_user_handle = %s "
            "WHERE id = %s AND webauthn_user_handle IS NULL",
            (secrets.token_bytes(64), user_id),
        )
        cur.execute("SELECT webauthn_user_handle FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
    if row is None or row[0] is None:
        raise LookupError(f"no user {user_id}")
    return bytes(row[0])


def get_user_handle(user_id: int) -> bytes | None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT webauthn_user_handle FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
    return bytes(row[0]) if row and row[0] is not None else None


# ── credentials ────────────────────────────────────────────────────────


def add_credential(
    user_id: int,
    *,
    credential_id: bytes,
    public_key: bytes,
    sign_count: int,
    transports: list[str],
    aaguid: str,
    backup_eligible: bool,
    backed_up: bool,
    label: str | None,
) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO passkey_credentials (user_id, credential_id, public_key, sign_count, "
            "transports, aaguid, backup_eligible, backed_up, label) "
            "VALUES (%s, %s, %s, %s, %s::text[], %s, %s, %s, %s) RETURNING id",
            (user_id, credential_id, public_key, sign_count, list(transports), aaguid,
             backup_eligible, backed_up, label),
        )
        return cur.fetchone()[0]


def active_credential_ids(user_id: int) -> list[bytes]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT credential_id FROM passkey_credentials "
            "WHERE user_id = %s AND revoked_at IS NULL ORDER BY id",
            (user_id,),
        )
        return [bytes(r[0]) for r in cur.fetchall()]


def count_active(user_id: int) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM passkey_credentials WHERE user_id = %s AND revoked_at IS NULL",
            (user_id,),
        )
        return cur.fetchone()[0]


def get_active_credential(credential_id: bytes) -> dict | None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, user_id, public_key, sign_count FROM passkey_credentials "
            "WHERE credential_id = %s AND revoked_at IS NULL",
            (credential_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {"id": row[0], "user_id": row[1], "public_key": bytes(row[2]), "sign_count": row[3]}


def record_use(row_id: int, sign_count: int, backed_up: bool) -> None:
    """Note a sign-in. The stored counter never moves backwards."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE passkey_credentials SET sign_count = GREATEST(sign_count, %s), "
            "backed_up = %s, last_used_at = now() WHERE id = %s",
            (sign_count, backed_up, row_id),
        )


def list_credentials(user_id: int) -> list[dict]:
    cols = ("id", "label", "backup_eligible", "backed_up", "created_at", "last_used_at", "revoked_at")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"SELECT {', '.join(cols)} FROM passkey_credentials WHERE user_id = %s ORDER BY id",
            (user_id,),
        )
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def revoke_credential(row_id: int) -> bool:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE passkey_credentials SET revoked_at = now() WHERE id = %s AND revoked_at IS NULL",
            (row_id,),
        )
        return cur.rowcount == 1


# ── enrollment links ───────────────────────────────────────────────────


def create_enrollment(user_id: int, token_hash: str, label: str | None, minutes: int) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO passkey_enrollments (user_id, token_hash, label, expires_at) "
            "VALUES (%s, %s, %s, now() + make_interval(mins => %s)) RETURNING id",
            (user_id, token_hash, label, minutes),
        )
        return cur.fetchone()[0]


def get_enrollment(token_hash: str) -> dict | None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, user_id, label, expires_at <= now(), consumed_at IS NOT NULL "
            "FROM passkey_enrollments WHERE token_hash = %s",
            (token_hash,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {"id": row[0], "user_id": row[1], "label": row[2], "expired": row[3], "consumed": row[4]}


def consume_enrollment(enrollment_id: int) -> bool:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE passkey_enrollments SET consumed_at = now() "
            "WHERE id = %s AND consumed_at IS NULL AND expires_at > now()",
            (enrollment_id,),
        )
        return cur.rowcount == 1


# ── challenges ─────────────────────────────────────────────────────────


def create_challenge(
    purpose: str,
    challenge: bytes,
    user_id: int,
    *,
    enrollment_id: int | None = None,
    minutes: int = 5,
) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO webauthn_challenges (purpose, challenge_hash, user_id, enrollment_id, expires_at) "
            "VALUES (%s, %s, %s, %s, now() + make_interval(mins => %s)) RETURNING id",
            (purpose, _digest(challenge), user_id, enrollment_id, minutes),
        )
        return cur.fetchone()[0]


def consume_challenge(purpose: str, challenge: bytes) -> dict | None:
    """Mark the challenge used and return whom it was issued for; None when
    it is unknown, already used, expired, or for the other ceremony."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE webauthn_challenges SET consumed_at = now() "
            "WHERE challenge_hash = %s AND purpose = %s AND consumed_at IS NULL "
            "AND expires_at > now() RETURNING user_id, enrollment_id",
            (_digest(challenge), purpose),
        )
        row = cur.fetchone()
    return {"user_id": row[0], "enrollment_id": row[1]} if row else None


def delete_expired_challenges() -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM webauthn_challenges WHERE expires_at < now()")
        return cur.rowcount
