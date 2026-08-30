"""Repository for the captures table."""

from datetime import datetime

from backend.db.connection import get_conn


def save_capture(
    user_id: int,
    capture_id: str,
    source: str,
    started_at: datetime,
    ended_at: datetime,
    *,
    is_trivial: bool = False,
    title: str | None = None,
    mini_summary: str | None = None,
    events: list | None = None,
    device_label: str | None = None,
    client_meta: dict | None = None,
) -> dict:
    """Insert a capture and return it as a dict with its DB id."""
    import json

    events_json = json.dumps(events or [])
    client_meta_json = json.dumps(client_meta) if client_meta else None

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO captures
                    (user_id, capture_id, source, started_at, ended_at,
                     is_trivial, title, mini_summary, events,
                     device_label, client_meta)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, created_at
                """,
                (
                    user_id,
                    capture_id,
                    source,
                    started_at,
                    ended_at,
                    is_trivial,
                    title,
                    mini_summary,
                    events_json,
                    device_label,
                    client_meta_json,
                ),
            )
            row = cur.fetchone()

    return {
        "id": row[0],
        "user_id": user_id,
        "capture_id": capture_id,
        "source": source,
        "started_at": started_at,
        "ended_at": ended_at,
        "is_trivial": is_trivial,
        "title": title,
        "mini_summary": mini_summary,
        "device_label": device_label,
        "client_meta": client_meta,
        "created_at": row[1],
    }


def get_capture(capture_id: str) -> dict | None:
    """Fetch a capture by its text capture_id."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, user_id, capture_id, source, started_at, ended_at,
                       is_trivial, title, mini_summary, events, created_at
                FROM captures WHERE capture_id = %s
                """,
                (capture_id,),
            )
            row = cur.fetchone()

    if row is None:
        return None

    return {
        "id": row[0],
        "user_id": row[1],
        "capture_id": row[2],
        "source": row[3],
        "started_at": row[4],
        "ended_at": row[5],
        "is_trivial": row[6],
        "title": row[7],
        "mini_summary": row[8],
        "events": row[9],
        "created_at": row[10],
    }


def list_captures(user_id: int) -> list[dict]:
    """List all captures for a user, newest first."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, capture_id, source, started_at, ended_at,
                       is_trivial, title, mini_summary, created_at
                FROM captures
                WHERE user_id = %s
                ORDER BY started_at DESC
                """,
                (user_id,),
            )
            rows = cur.fetchall()

    return [
        {
            "id": r[0],
            "user_id": user_id,
            "capture_id": r[1],
            "source": r[2],
            "started_at": r[3],
            "ended_at": r[4],
            "is_trivial": r[5],
            "title": r[6],
            "mini_summary": r[7],
            "created_at": r[8],
        }
        for r in rows
    ]


def override_capture_trivial(
    db_id: int,
    human_is_trivial: bool | None,
    user_id: int,
    *,
    note: str | None = None,
) -> dict:
    """Set (or clear) a human override on a capture's trivial flag.

    Pass human_is_trivial=None to clear the override.
    Creates an audit annotation and returns the updated effective value.
    """
    from backend.db.annotation_repo import create_annotation

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT is_trivial, human_is_trivial FROM captures WHERE id = %s",
                (db_id,),
            )
            row = cur.fetchone()
            if row is None:
                return {}
            old_effective = row[1] if row[1] is not None else row[0]

            cur.execute(
                "UPDATE captures SET human_is_trivial = %s WHERE id = %s",
                (human_is_trivial, db_id),
            )

    action = "override_trivial" if human_is_trivial is not None else "clear_override"
    create_annotation(
        user_id,
        "capture",
        db_id,
        action,
        old_value=str(old_effective),
        new_value=str(human_is_trivial) if human_is_trivial is not None else None,
        note=note,
    )

    new_effective = human_is_trivial if human_is_trivial is not None else row[0]
    return {"capture_id": db_id, "effective_is_trivial": new_effective}


def update_capture(db_id: int, **fields) -> None:
    """Update specific fields on a capture by its DB id."""
    if not fields:
        return
    import json

    set_clauses = []
    values = []
    for key, val in fields.items():
        set_clauses.append(f"{key} = %s")
        if key == "events":
            values.append(json.dumps(val))
        else:
            values.append(val)
    values.append(db_id)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE captures SET {', '.join(set_clauses)} WHERE id = %s",
                values,
            )
