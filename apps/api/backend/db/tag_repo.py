"""Repository for the tags and entity_tags tables."""

from backend.db.connection import get_conn


# ── Tags CRUD ───────────────────────────────────────────────────────────


def create_tag(
    user_id: int,
    name: str,
    *,
    color: str = "#808080",
    group_name: str | None = None,
    description: str | None = None,
) -> dict:
    """Create a tag. Returns the new tag dict."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO tags (user_id, name, color, group_name, description)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id, user_id, name, color, group_name, description, created_at
                """,
                (user_id, name, color, group_name, description),
            )
            return _tag_row_to_dict(cur.fetchone())


def get_tags(user_id: int, *, group_name: str | None = None) -> list[dict]:
    """All tags for a user, optionally filtered by group."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            if group_name is not None:
                cur.execute(
                    """
                    SELECT id, user_id, name, color, group_name, description, created_at
                    FROM tags
                    WHERE user_id = %s AND group_name = %s
                    ORDER BY name
                    """,
                    (user_id, group_name),
                )
            else:
                cur.execute(
                    """
                    SELECT id, user_id, name, color, group_name, description, created_at
                    FROM tags
                    WHERE user_id = %s
                    ORDER BY name
                    """,
                    (user_id,),
                )
            return [_tag_row_to_dict(r) for r in cur.fetchall()]


def get_tag_by_name(user_id: int, name: str) -> dict | None:
    """Look up a tag by name (unique per user)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, user_id, name, color, group_name, description, created_at
                FROM tags
                WHERE user_id = %s AND name = %s
                """,
                (user_id, name),
            )
            row = cur.fetchone()
    return _tag_row_to_dict(row) if row else None


def get_tag_by_id(tag_id: int) -> dict | None:
    """Look up a tag by ID."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, user_id, name, color, group_name, description, created_at
                FROM tags WHERE id = %s
                """,
                (tag_id,),
            )
            row = cur.fetchone()
    return _tag_row_to_dict(row) if row else None


def update_tag(tag_id: int, **fields) -> None:
    """Update tag fields. Accepts: name, color, group_name, description."""
    allowed = {"name", "color", "group_name", "description"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return

    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [tag_id]

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE tags SET {set_clause} WHERE id = %s",  # noqa: S608
                values,
            )


def delete_tag(tag_id: int) -> None:
    """Delete a tag (CASCADE removes entity_tags)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM tags WHERE id = %s", (tag_id,))


def get_tag_groups(user_id: int) -> list[str]:
    """Distinct non-null group names for a user."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT group_name FROM tags
                WHERE user_id = %s AND group_name IS NOT NULL
                ORDER BY group_name
                """,
                (user_id,),
            )
            return [r[0] for r in cur.fetchall()]


# ── Entity Tags ─────────────────────────────────────────────────────────


def add_entity_tag(tag_id: int, entity_type: str, entity_id: int, user_id: int) -> None:
    """Associate a tag with a page or capture. Idempotent (ON CONFLICT DO NOTHING)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO entity_tags (tag_id, entity_type, entity_id, user_id)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (tag_id, entity_type, entity_id) DO NOTHING
                """,
                (tag_id, entity_type, entity_id, user_id),
            )


def remove_entity_tag(tag_id: int, entity_type: str, entity_id: int) -> None:
    """Remove a tag association."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM entity_tags
                WHERE tag_id = %s AND entity_type = %s AND entity_id = %s
                """,
                (tag_id, entity_type, entity_id),
            )


def get_tags_for_entity(entity_type: str, entity_id: int) -> list[dict]:
    """All tags on a specific page or capture."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT t.id, t.user_id, t.name, t.color,
                       t.group_name, t.description, t.created_at
                FROM tags t
                JOIN entity_tags et ON t.id = et.tag_id
                WHERE et.entity_type = %s AND et.entity_id = %s
                ORDER BY t.name
                """,
                (entity_type, entity_id),
            )
            return [_tag_row_to_dict(r) for r in cur.fetchall()]


def get_entities_for_tag(tag_id: int, *, entity_type: str | None = None) -> list[dict]:
    """All entities (pages/captures) with a specific tag."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            if entity_type is not None:
                cur.execute(
                    """
                    SELECT entity_type, entity_id, created_at
                    FROM entity_tags
                    WHERE tag_id = %s AND entity_type = %s
                    ORDER BY created_at DESC
                    """,
                    (tag_id, entity_type),
                )
            else:
                cur.execute(
                    """
                    SELECT entity_type, entity_id, created_at
                    FROM entity_tags
                    WHERE tag_id = %s
                    ORDER BY created_at DESC
                    """,
                    (tag_id,),
                )
            return [
                {
                    "entity_type": r[0],
                    "entity_id": r[1],
                    "created_at": r[2],
                }
                for r in cur.fetchall()
            ]


def get_tags_for_entities_batch(
    entity_type: str,
    entity_ids: list[int],
) -> dict[int, list[dict]]:
    """All tags for a list of entity IDs in one query.

    Returns ``{entity_id: [{id, name, color}, ...]}``.
    """
    if not entity_ids:
        return {}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT et.entity_id, t.id, t.name, t.color
                FROM tags t
                JOIN entity_tags et ON t.id = et.tag_id
                WHERE et.entity_type = %s AND et.entity_id = ANY(%s)
                ORDER BY t.name
                """,
                (entity_type, entity_ids),
            )
            result: dict[int, list[dict]] = {}
            for eid, tid, name, color in cur.fetchall():
                result.setdefault(eid, []).append({"id": tid, "name": name, "color": color})
    return result


# ── Helpers ─────────────────────────────────────────────────────────────


def _tag_row_to_dict(row: tuple) -> dict:
    return {
        "id": row[0],
        "user_id": row[1],
        "name": row[2],
        "color": row[3],
        "group_name": row[4],
        "description": row[5],
        "created_at": row[6],
    }
