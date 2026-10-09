"""trusted_browsers rows (migration 049): browsers the owner trusted for
automatic tailnet sign-in. Callers pass token HASHES, never raw tokens."""

from __future__ import annotations

from backend.db.connection import get_conn


def create(user_id: int, token_hash: str, label: str | None) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO trusted_browsers (user_id, token_hash, label) "
                "VALUES (%s, %s, %s) RETURNING id",
                (user_id, token_hash, label),
            )
            return cur.fetchone()[0]


def get_active(token_hash: str) -> dict | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, user_id FROM trusted_browsers "
                "WHERE token_hash = %s AND revoked_at IS NULL",
                (token_hash,),
            )
            row = cur.fetchone()
    return {"id": row[0], "user_id": row[1]} if row else None


def touch(browser_id: int) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE trusted_browsers SET last_used_at = now() WHERE id = %s",
                (browser_id,),
            )


def list_all() -> list[dict]:
    cols = ("id", "user_id", "label", "created_at", "last_used_at", "revoked_at")
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT {', '.join(cols)} FROM trusted_browsers ORDER BY id")
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def revoke(browser_id: int) -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE trusted_browsers SET revoked_at = now() "
                "WHERE id = %s AND revoked_at IS NULL",
                (browser_id,),
            )
            return cur.rowcount == 1


def revoke_all(user_id: int | None = None) -> int:
    sql = "UPDATE trusted_browsers SET revoked_at = now() WHERE revoked_at IS NULL"
    params: tuple = ()
    if user_id is not None:
        sql += " AND user_id = %s"
        params = (user_id,)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount
