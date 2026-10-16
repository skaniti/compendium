"""Repository for shelves, shelf_pages and shelf_strings (migration 059).

A shelf is a canonical, stable subtopic. ``centroid`` is an untyped pgvector
column, so it is written as a ``[..]`` literal cast to ``vector`` and read back
through ``::text`` (the same convention as ``embedding_repo``).
"""

from __future__ import annotations

import logging

from backend.db.connection import get_conn

logger = logging.getLogger(__name__)

_UPDATABLE = {"name", "category", "centroid", "n_pages", "status", "merged_into", "embedder_key"}
_COLS = (
    "id, user_id, stable_id::text, name, category, centroid::text, embedder_key, "
    "n_pages, status, merged_into"
)


def _vec_literal(vec) -> str | None:
    if vec is None:
        return None
    return "[" + ",".join(repr(float(v)) for v in vec) + "]"


def _parse_vec(text: str | None) -> list[float] | None:
    if not text:
        return None
    return [float(x) for x in text.strip("[]").split(",")]


def _row(r) -> dict:
    return {
        "id": r[0],
        "user_id": r[1],
        "stable_id": r[2],
        "name": r[3],
        "category": r[4],
        "centroid": _parse_vec(r[5]),
        "embedder_key": r[6],
        "n_pages": r[7],
        "status": r[8],
        "merged_into": r[9],
    }


def create_shelf(
    user_id: int,
    name: str,
    category: str,
    centroid=None,
    embedder_key: str | None = None,
    n_pages: int = 0,
) -> dict:
    """Insert an active shelf; the DB mints ``stable_id``. Returns the row dict."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
                INSERT INTO shelves (user_id, name, category, centroid, embedder_key, n_pages)
                VALUES (%s, %s, %s, %s::vector, %s, %s)
                RETURNING {_COLS}
                """,
            (user_id, name, category, _vec_literal(centroid), embedder_key, n_pages),
        )
        return _row(cur.fetchone())


def get_shelves(user_id: int, status: str | None = "active") -> list[dict]:
    """Shelves of ``user_id`` with the given status (None = every status)."""
    with get_conn() as conn, conn.cursor() as cur:
        if status is None:
            cur.execute(f"SELECT {_COLS} FROM shelves WHERE user_id = %s ORDER BY id", (user_id,))
        else:
            cur.execute(
                f"SELECT {_COLS} FROM shelves WHERE user_id = %s AND status = %s ORDER BY id",
                (user_id, status),
            )
        return [_row(r) for r in cur.fetchall()]


def get_shelf(shelf_id: int) -> dict | None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM shelves WHERE id = %s", (shelf_id,))
        r = cur.fetchone()
        return _row(r) if r else None


def update_shelf(shelf_id: int, **fields) -> None:
    """Update name/category/centroid/n_pages/status/merged_into/embedder_key."""
    bad = set(fields) - _UPDATABLE
    if bad:
        raise ValueError(f"unknown shelf fields: {sorted(bad)}")
    if not fields:
        return
    sets, params = [], []
    for key, value in fields.items():
        if key == "centroid":
            sets.append("centroid = %s::vector")
            params.append(_vec_literal(value))
        else:
            sets.append(f"{key} = %s")
            params.append(value)
    sets.append("updated_at = NOW()")
    params.append(shelf_id)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(f"UPDATE shelves SET {', '.join(sets)} WHERE id = %s", params)


def upsert_shelf_page(
    shelf_id: int,
    page_content_id: int,
    user_id: int,
    subtopic: str,
    method: str,
    similarity: float | None = None,
) -> None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
                INSERT INTO shelf_pages
                    (shelf_id, page_content_id, user_id, subtopic, method, similarity)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (page_content_id, user_id) DO UPDATE
                   SET shelf_id = EXCLUDED.shelf_id, subtopic = EXCLUDED.subtopic,
                       method = EXCLUDED.method, similarity = EXCLUDED.similarity,
                       assigned_at = NOW()
                """,
            (shelf_id, page_content_id, user_id, subtopic, method, similarity),
        )


def get_shelf_pages(user_id: int) -> dict[int, int]:
    """{page_content_id: shelf_id} for every shelved page of the user."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT page_content_id, shelf_id FROM shelf_pages WHERE user_id = %s",
            (user_id,),
        )
        return {r[0]: r[1] for r in cur.fetchall()}


def get_pages_for_shelf(shelf_id: int) -> list[int]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT page_content_id FROM shelf_pages WHERE shelf_id = %s ORDER BY page_content_id",
            (shelf_id,),
        )
        return [r[0] for r in cur.fetchall()]


def get_page_subtopics(shelf_id: int) -> dict[int, str]:
    """{page_content_id: raw subtopic} for the members of a shelf."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT page_content_id, subtopic FROM shelf_pages WHERE shelf_id = %s",
            (shelf_id,),
        )
        return {r[0]: r[1] for r in cur.fetchall()}


def move_shelf_pages(
    from_id: int, to_id: int, method: str, content_ids: list[int] | None = None
) -> int:
    """Re-point members of ``from_id`` (all, or just ``content_ids``) to ``to_id``.

    ``from_id == to_id`` just restamps ``method`` (used to mark the kept half of
    a split). Returns the number of rows touched.
    """
    with get_conn() as conn, conn.cursor() as cur:
        if content_ids is None:
            cur.execute(
                "UPDATE shelf_pages SET shelf_id = %s, method = %s, assigned_at = NOW() "
                "WHERE shelf_id = %s",
                (to_id, method, from_id),
            )
        else:
            cur.execute(
                "UPDATE shelf_pages SET shelf_id = %s, method = %s, assigned_at = NOW() "
                "WHERE shelf_id = %s AND page_content_id = ANY(%s)",
                (to_id, method, from_id, list(content_ids)),
            )
        return cur.rowcount


def get_shelf_string(user_id: int, subtopic_norm: str) -> int | None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT shelf_id FROM shelf_strings WHERE user_id = %s AND subtopic_norm = %s",
            (user_id, subtopic_norm),
        )
        r = cur.fetchone()
        return r[0] if r else None


def set_shelf_string(user_id: int, subtopic_norm: str, shelf_id: int) -> None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
                INSERT INTO shelf_strings (user_id, subtopic_norm, shelf_id)
                VALUES (%s, %s, %s)
                ON CONFLICT (user_id, subtopic_norm) DO UPDATE SET shelf_id = EXCLUDED.shelf_id
                """,
            (user_id, subtopic_norm, shelf_id),
        )


def repoint_shelf_strings(from_id: int, to_id: int) -> int:
    """Re-point every memoised string of ``from_id`` at ``to_id`` (merge)."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE shelf_strings SET shelf_id = %s WHERE shelf_id = %s", (to_id, from_id))
        return cur.rowcount


def recount_shelves(user_id: int) -> None:
    """Set ``n_pages`` of every shelf of the user from ``shelf_pages``."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
                UPDATE shelves s
                   SET n_pages = COALESCE(
                           (SELECT COUNT(*) FROM shelf_pages sp WHERE sp.shelf_id = s.id), 0),
                       updated_at = NOW()
                 WHERE s.user_id = %s
                """,
            (user_id,),
        )


def get_example_titles(shelf_id: int, n: int = 3) -> list[str]:
    """Titles of up to ``n`` member pages (most recent first, distinct)."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
                SELECT t.title FROM (
                    SELECT p.title, MAX(p.visited_at) AS v
                      FROM shelf_pages sp
                      JOIN pages p ON p.page_content_id = sp.page_content_id
                     WHERE sp.shelf_id = %s AND p.title IS NOT NULL AND p.title <> ''
                  GROUP BY p.title
                ) t ORDER BY t.v DESC NULLS LAST LIMIT %s
                """,
            (shelf_id, n),
        )
        return [r[0] for r in cur.fetchall()]
