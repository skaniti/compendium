"""break_glass_codes rows (migration 052, owner-passkeys): one-time codes a
server command issues when passkeys are unavailable. Callers pass bcrypt
hashes, never raw codes. At most one code per account is live."""

from __future__ import annotations

from backend.db.connection import get_conn


def issue(user_id: int, code_hash: str, minutes: int) -> int:
    """Store a new code and revoke any unused earlier one of the account."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE break_glass_codes SET revoked_at = now() "
            "WHERE user_id = %s AND used_at IS NULL AND revoked_at IS NULL",
            (user_id,),
        )
        cur.execute(
            "INSERT INTO break_glass_codes (user_id, code_hash, expires_at) "
            "VALUES (%s, %s, now() + make_interval(mins => %s)) RETURNING id",
            (user_id, code_hash, minutes),
        )
        return cur.fetchone()[0]


def live(user_id: int) -> dict | None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, code_hash FROM break_glass_codes WHERE user_id = %s "
            "AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() "
            "ORDER BY id DESC LIMIT 1",
            (user_id,),
        )
        row = cur.fetchone()
    return {"id": row[0], "code_hash": row[1]} if row else None


def use(code_id: int) -> bool:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE break_glass_codes SET used_at = now() WHERE id = %s "
            "AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()",
            (code_id,),
        )
        return cur.rowcount == 1
