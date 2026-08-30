"""Repository for the annotations table (human override audit trail)."""

from backend.db.connection import get_conn


# ── Write ───────────────────────────────────────────────────────────────


def create_annotation(
    user_id: int,
    entity_type: str,
    entity_id: int,
    action: str,
    *,
    old_value: str | None = None,
    new_value: str | None = None,
    note: str | None = None,
    model_version: str | None = None,
    prompt_version: str | None = None,
) -> dict:
    """Record a human override or note in the audit trail.

    Returns the created annotation dict with id and created_at.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO annotations
                    (user_id, entity_type, entity_id, action,
                     old_value, new_value, note,
                     model_version, prompt_version)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, created_at
                """,
                (
                    user_id,
                    entity_type,
                    entity_id,
                    action,
                    old_value,
                    new_value,
                    note,
                    model_version,
                    prompt_version,
                ),
            )
            row = cur.fetchone()

    return {
        "id": row[0],
        "entity_type": entity_type,
        "entity_id": entity_id,
        "action": action,
        "old_value": old_value,
        "new_value": new_value,
        "note": note,
        "created_at": row[1],
    }


# ── Read ────────────────────────────────────────────────────────────────


def get_annotations_for_entity(entity_type: str, entity_id: int) -> list[dict]:
    """All annotations for a page or capture, newest first."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, user_id, entity_type, entity_id, action,
                       old_value, new_value, note,
                       model_version, prompt_version, created_at
                FROM annotations
                WHERE entity_type = %s AND entity_id = %s
                ORDER BY created_at DESC
                """,
                (entity_type, entity_id),
            )
            return [_row_to_dict(r) for r in cur.fetchall()]


def get_annotations_by_action(user_id: int, action: str, *, limit: int = 100) -> list[dict]:
    """Annotations filtered by action type, for analytics."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, user_id, entity_type, entity_id, action,
                       old_value, new_value, note,
                       model_version, prompt_version, created_at
                FROM annotations
                WHERE user_id = %s AND action = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (user_id, action, limit),
            )
            return [_row_to_dict(r) for r in cur.fetchall()]


def get_disagreement_summary(user_id: int) -> dict:
    """Aggregate where human overrides disagree with LLM decisions.

    Returns counts grouped by domain and by original skip_reasoning,
    plus total override counts.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            # Status overrides by domain
            cur.execute(
                """
                SELECT p.domain, COUNT(*) AS cnt
                FROM pages p
                WHERE p.user_id = %s
                  AND p.human_status IS NOT NULL
                  AND p.human_status != p.status
                GROUP BY p.domain
                ORDER BY cnt DESC
                """,
                (user_id,),
            )
            by_domain = [{"domain": r[0], "count": r[1]} for r in cur.fetchall()]

            # Depth overrides by original skip_reasoning
            cur.execute(
                """
                SELECT p.skip_reasoning, COUNT(*) AS cnt
                FROM pages p
                WHERE p.user_id = %s
                  AND p.human_processing_depth IS NOT NULL
                  AND p.human_processing_depth != p.processing_depth
                GROUP BY p.skip_reasoning
                ORDER BY cnt DESC
                """,
                (user_id,),
            )
            by_reasoning = [{"skip_reasoning": r[0], "count": r[1]} for r in cur.fetchall()]

            # Totals
            cur.execute(
                """
                SELECT
                    COUNT(*) FILTER (
                        WHERE human_status IS NOT NULL
                    ) AS status_overrides,
                    COUNT(*) FILTER (
                        WHERE human_processing_depth IS NOT NULL
                    ) AS depth_overrides,
                    COUNT(*) FILTER (
                        WHERE human_status IS NOT NULL
                          AND human_status != status
                    ) AS status_disagreements,
                    COUNT(*) FILTER (
                        WHERE human_processing_depth IS NOT NULL
                          AND human_processing_depth != processing_depth
                    ) AS depth_disagreements
                FROM pages
                WHERE user_id = %s
                """,
                (user_id,),
            )
            totals = cur.fetchone()

    return {
        "by_domain": by_domain,
        "by_skip_reasoning": by_reasoning,
        "status_overrides": totals[0],
        "depth_overrides": totals[1],
        "status_disagreements": totals[2],
        "depth_disagreements": totals[3],
    }


# ── Helpers ─────────────────────────────────────────────────────────────


def _row_to_dict(row: tuple) -> dict:
    return {
        "id": row[0],
        "user_id": row[1],
        "entity_type": row[2],
        "entity_id": row[3],
        "action": row[4],
        "old_value": row[5],
        "new_value": row[6],
        "note": row[7],
        "model_version": row[8],
        "prompt_version": row[9],
        "created_at": row[10],
    }
