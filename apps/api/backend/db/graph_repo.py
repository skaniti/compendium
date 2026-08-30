"""Repository for the graph_cache table."""

import json
from datetime import datetime

from backend.db.connection import get_conn


def save_graph_cache(user_id: int, graph_data: dict) -> None:
    """Upsert the cached graph JSON for a user."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO graph_cache (user_id, graph_data, updated_at)
                VALUES (%s, %s, NOW())
                ON CONFLICT (user_id) DO UPDATE
                SET graph_data = EXCLUDED.graph_data,
                    updated_at = NOW()
                """,
                (user_id, json.dumps(graph_data)),
            )


def load_graph_cache(user_id: int) -> dict | None:
    """Load the cached graph for a user. Returns None if no cache exists."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT graph_data, updated_at FROM graph_cache WHERE user_id = %s",
                (user_id,),
            )
            row = cur.fetchone()

    if row is None:
        return None

    return row[0] if isinstance(row[0], dict) else json.loads(row[0])


def get_cache_updated_at(user_id: int) -> datetime | None:
    """Return the updated_at timestamp of the graph cache, or None."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT updated_at FROM graph_cache WHERE user_id = %s",
                (user_id,),
            )
            row = cur.fetchone()
    return row[0] if row else None
