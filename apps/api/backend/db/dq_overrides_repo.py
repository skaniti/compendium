"""Repository for dq_overrides -- durable constraints the clustering pipeline
consumes on every recluster (dqBot Tier 1, spec S6).

Four override_types: pin_label, exclude_from_cluster, never_cocluster,
merge_clusters. `subject` identifies what the override targets (e.g. a
stable_id or list of stable_ids); `payload` carries action-specific detail
(e.g. the pinned label, or the page_content_ids to exclude). Both are opaque
JSONB here -- interpretation lives in the override-application pass
(clustering_service._apply_dq_overrides, a later phase), not this repo.
"""

import json
import logging

from backend.db.connection import get_conn

logger = logging.getLogger(__name__)

_VALID_OVERRIDE_TYPES = frozenset(
    {"pin_label", "exclude_from_cluster", "never_cocluster", "merge_clusters"}
)

_SELECT_COLUMNS = """
    id, user_id, override_type, subject, payload, status, source_rec_id,
    created_at, last_applied_run, last_applied_at, apply_count
"""


def _row_to_dict(r) -> dict:
    return {
        "id": r[0],
        "user_id": r[1],
        "override_type": r[2],
        "subject": r[3],
        "payload": r[4],
        "status": r[5],
        "source_rec_id": r[6],
        "created_at": r[7],
        "last_applied_run": r[8],
        "last_applied_at": r[9],
        "apply_count": r[10],
    }


def create_override(
    user_id: int,
    override_type: str,
    subject: dict,
    payload: dict | None = None,
    source_rec_id: int | None = None,
) -> dict:
    """Insert an override into dq_overrides.

    subject and payload are marshaled to JSONB via json.dumps. Raises
    ValueError for an override_type outside the four recognized types
    (the same set the CHECK constraint enforces -- fail fast in Python
    with a clear message rather than surfacing a raw IntegrityError).
    Returns the inserted row as dict.
    """
    if override_type not in _VALID_OVERRIDE_TYPES:
        raise ValueError(f"invalid override_type: {override_type}")

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO dq_overrides
                (user_id, override_type, subject, payload, source_rec_id)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING {_SELECT_COLUMNS}
            """,
            (
                user_id,
                override_type,
                json.dumps(subject),
                json.dumps(payload) if payload is not None else None,
                source_rec_id,
            ),
        )
        r = cur.fetchone()

    return _row_to_dict(r)


def list_active(user_id: int) -> list[dict]:
    """List active overrides for a user, newest first.

    This is the set the clustering pipeline's override-application pass
    consumes each recluster.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {_SELECT_COLUMNS}
            FROM dq_overrides
            WHERE user_id = %s AND status = 'active'
            ORDER BY created_at DESC
            """,
            (user_id,),
        )
        return [_row_to_dict(r) for r in cur.fetchall()]


def list_all(user_id: int) -> list[dict]:
    """List all overrides for a user: active first, then retired, newest
    first within each group. Backs the Overrides tab (spec S7)."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {_SELECT_COLUMNS}
            FROM dq_overrides
            WHERE user_id = %s
            ORDER BY (status = 'active') DESC, created_at DESC
            """,
            (user_id,),
        )
        return [_row_to_dict(r) for r in cur.fetchall()]


def retire(override_id: int, user_id: int) -> dict | None:
    """Set status='retired' on a user's override. Returns the updated row,
    or None if not found / not owned by user."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE dq_overrides
            SET status = 'retired'
            WHERE id = %s AND user_id = %s
            RETURNING {_SELECT_COLUMNS}
            """,
            (override_id, user_id),
        )
        r = cur.fetchone()

    if r is None:
        return None
    return _row_to_dict(r)


def mark_applied(override_ids: list[int], run_id: int) -> int:
    """Bulk-mark overrides as applied in a given recluster run: bumps
    last_applied_run/last_applied_at/apply_count. Returns the number of rows
    updated. No-ops (returns 0) on an empty override_ids list -- guards
    against an unqualified UPDATE ... WHERE id = ANY('{}') matching nothing,
    which it wouldn't, but an empty list is also just never a real call."""
    if not override_ids:
        return 0

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE dq_overrides
            SET last_applied_run = %s,
                last_applied_at = NOW(),
                apply_count = apply_count + 1
            WHERE id = ANY(%s)
            """,
            (run_id, override_ids),
        )
        return cur.rowcount
