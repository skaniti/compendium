"""Repository for dq_observations -- working memory + dedup ledger for dqBot."""

import json
import logging
from datetime import datetime

from backend.db.connection import get_conn

logger = logging.getLogger(__name__)


def create_observation(
    user_id: int,
    run_id: int,
    tag: str,
    entity_type: str,
    entity_id: str,
    issue_type: str,
    observation: str,
    severity: str,
    *,
    scope_citation: str | None = None,
    adjacency_contract_ref: str | None = None,
    handoff_prompt_draft: str | None = None,
    # Receipt columns (migration 028)
    evidence: dict | None = None,
    reasoning: dict | None = None,
    ambiguities: dict | None = None,
    proposed_issue_type: str | None = None,
    # SQL receipt columns (migration 028)
    sql_query: str | None = None,
    sql_query_description: str | None = None,
    sql_query_executed_at: datetime | None = None,
    sql_query_status: str | None = None,
    sql_query_n_rows: int | None = None,
    sql_query_error_text: str | None = None,
) -> dict:
    """Insert an observation into the ledger.

    If handoff_prompt_draft is provided, handoff_status is set to 'draft'.
    Uses ON CONFLICT to deduplicate on (user_id, entity_type, entity_id, issue_type).
    If a conflict is detected, returns the existing row instead of raising.

    Receipt columns (evidence/reasoning/ambiguities) are JSONB; pass Python
    dicts and they'll be json-encoded. None falls back to the per-column
    DEFAULT (``{"items": []}`` / ``{"steps": []}``).

    proposed_issue_type captures the agent's original label when the cosine
    gate rewrote it to a different canonical (e.g., via alias). NULL when the
    agent's label was used as-is.
    """
    with get_conn() as conn, conn.cursor() as cur:
        # Set handoff_status to 'draft' if handoff_prompt_draft is provided
        handoff_status = "draft" if handoff_prompt_draft is not None else None

        cur.execute(
            """
            INSERT INTO dq_observations
                (user_id, run_id, tag, entity_type, entity_id, issue_type,
                 observation, severity, scope_citation, adjacency_contract_ref,
                 handoff_prompt_draft, handoff_status,
                 evidence, reasoning, ambiguities, proposed_issue_type,
                 sql_query, sql_query_description, sql_query_executed_at,
                 sql_query_status, sql_query_n_rows, sql_query_error_text)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    COALESCE(%s::jsonb, '{"items": []}'::jsonb),
                    COALESCE(%s::jsonb, '{"steps": []}'::jsonb),
                    COALESCE(%s::jsonb, '{"items": []}'::jsonb),
                    %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (user_id, entity_type, entity_id, issue_type)
            DO NOTHING
            RETURNING id, tag, entity_type, entity_id, issue_type,
                      observation, severity, scope_citation,
                      adjacency_contract_ref, handoff_prompt_draft,
                      handoff_status, observed_at
            """,
            (
                user_id,
                run_id,
                tag,
                entity_type,
                entity_id,
                issue_type,
                observation,
                severity,
                scope_citation,
                adjacency_contract_ref,
                handoff_prompt_draft,
                handoff_status,
                json.dumps(evidence) if evidence is not None else None,
                json.dumps(reasoning) if reasoning is not None else None,
                json.dumps(ambiguities) if ambiguities is not None else None,
                proposed_issue_type,
                sql_query,
                sql_query_description,
                sql_query_executed_at,
                sql_query_status,
                sql_query_n_rows,
                sql_query_error_text,
            ),
        )
        r = cur.fetchone()

        # If conflict occurred, RETURNING will be empty. Fetch the existing row.
        if r is None:
            cur.execute(
                """
                SELECT id, tag, entity_type, entity_id, issue_type,
                       observation, severity, scope_citation,
                       adjacency_contract_ref, handoff_prompt_draft,
                       handoff_status, observed_at
                FROM dq_observations
                WHERE user_id = %s AND entity_type = %s AND entity_id = %s
                  AND issue_type = %s
                """,
                (user_id, entity_type, entity_id, issue_type),
            )
            r = cur.fetchone()

    return {
        "id": r[0],
        "tag": r[1],
        "entity_type": r[2],
        "entity_id": r[3],
        "issue_type": r[4],
        "observation": r[5],
        "severity": r[6],
        "scope_citation": r[7],
        "adjacency_contract_ref": r[8],
        "handoff_prompt_draft": r[9],
        "handoff_status": r[10],
        "observed_at": r[11],
    }


def get_observation(user_id: int, obs_id: int) -> dict | None:
    """Return one observation with all receipt + SQL columns, or None.

    Used by the Receipt pane to render Layers 1-4 + the SQL block.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, run_id, tag, entity_type, entity_id, issue_type,
                   observation, severity, scope_citation, adjacency_contract_ref,
                   handoff_prompt_draft, handoff_status, observed_at,
                   evidence, reasoning, ambiguities, proposed_issue_type,
                   sql_query, sql_query_description, sql_query_executed_at,
                   sql_query_status, sql_query_n_rows, sql_query_error_text
            FROM dq_observations
            WHERE id = %s AND user_id = %s
            """,
            (obs_id, user_id),
        )
        r = cur.fetchone()
    if r is None:
        return None
    return {
        "id": r[0],
        "run_id": r[1],
        "tag": r[2],
        "entity_type": r[3],
        "entity_id": r[4],
        "issue_type": r[5],
        "observation": r[6],
        "severity": r[7],
        "scope_citation": r[8],
        "adjacency_contract_ref": r[9],
        "handoff_prompt_draft": r[10],
        "handoff_status": r[11],
        "observed_at": r[12].isoformat() if r[12] else None,
        "evidence": r[13],
        "reasoning": r[14],
        "ambiguities": r[15],
        "proposed_issue_type": r[16],
        "sql_query": r[17],
        "sql_query_description": r[18],
        "sql_query_executed_at": r[19].isoformat() if r[19] else None,
        "sql_query_status": r[20],
        "sql_query_n_rows": r[21],
        "sql_query_error_text": r[22],
    }


def has_observation(
    user_id: int,
    entity_type: str,
    entity_id: str,
    issue_type: str,
) -> bool:
    """Dedup filter for the agent -- pending-only semantics (spec S2).

    Returns True only when a matching observation on (user, entity_type,
    entity_id, issue_type) has at least one recommendation with
    status='pending'. Resolved history (approved/rejected/dismissed/snoozed/
    superseded) no longer suppresses re-detection -- a regression refiles as
    a NEW observation, whose recommendation supersedes the newest prior rec
    for that entity+issue via newest_rec_for_entity_issue() + supersede().

    Note dq_observations still carries a UNIQUE(user_id, entity_type,
    entity_id, issue_type) index (the ON CONFLICT dedup in
    create_observation) -- has_observation being pending-only doesn't change
    that a "new" observation for an already-seen tuple is actually a no-op
    INSERT that returns the existing row. The refile path (dq_agent.py,
    Phase 1 Worker L) is expected to route through supersede() using that
    existing observation, not rely on a second distinct observation row.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1
            FROM dq_observations o
            JOIN dq_recommendations r ON r.observation_id = o.id
            WHERE o.user_id = %s AND o.entity_type = %s AND o.entity_id = %s
              AND o.issue_type = %s AND r.status = 'pending'
            LIMIT 1
            """,
            (user_id, entity_type, entity_id, issue_type),
        )
        return cur.fetchone() is not None


def newest_rec_for_entity_issue(
    user_id: int,
    entity_type: str,
    entity_id: str,
    issue_type: str,
) -> dict | None:
    """Return the newest recommendation (any status) linked to any
    observation matching (user, entity_type, entity_id, issue_type).

    Used by the refile/supersede path (spec S2): when has_observation is
    False but a resolved prior observation exists, the caller supersedes
    this rec instead of starting a fresh recommendation chain -- this is
    what makes the resulting trend/recur% real (supersede() links old -> new
    rather than orphaning the history).

    Returns the full recommendation row as dict (same shape as
    dq_recommendations_repo row dicts), or None if no observation/rec exists
    for the tuple.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT r.id, r.user_id, r.run_id, r.observation_id, r.action_type,
                   r.headline, r.rationale, r.self_classification, r.rank_in_run,
                   r.affected_entity_type, r.affected_entity_ids, r.status,
                   r.user_note, r.reviewed_at, r.superseded_by, r.created_at,
                   r.promoted_at, r.outlier_signals, r.action_payload,
                   r.applied_at, r.applied_detail
            FROM dq_recommendations r
            JOIN dq_observations o ON o.id = r.observation_id
            WHERE o.user_id = %s AND o.entity_type = %s AND o.entity_id = %s
              AND o.issue_type = %s
            ORDER BY r.created_at DESC
            LIMIT 1
            """,
            (user_id, entity_type, entity_id, issue_type),
        )
        r = cur.fetchone()

    if r is None:
        return None
    return {
        "id": r[0],
        "user_id": r[1],
        "run_id": r[2],
        "observation_id": r[3],
        "action_type": r[4],
        "headline": r[5],
        "rationale": r[6],
        "self_classification": r[7],
        "rank_in_run": r[8],
        "affected_entity_type": r[9],
        "affected_entity_ids": r[10],
        "status": r[11],
        "user_note": r[12],
        "reviewed_at": r[13],
        "superseded_by": r[14],
        "created_at": r[15],
        "promoted_at": r[16],
        "outlier_signals": r[17],
        "action_payload": r[18],
        "applied_at": r[19],
        "applied_detail": r[20],
    }


def list_for_run(run_id: int, limit: int = 100) -> list[dict]:
    """List all observations for a given run, ordered by observed_at."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, tag, entity_type, entity_id, issue_type,
                   observation, severity, scope_citation,
                   adjacency_contract_ref, handoff_prompt_draft,
                   handoff_status, observed_at
            FROM dq_observations
            WHERE run_id = %s
            ORDER BY observed_at
            LIMIT %s
            """,
            (run_id, limit),
        )
        return [
            {
                "id": r[0],
                "tag": r[1],
                "entity_type": r[2],
                "entity_id": r[3],
                "issue_type": r[4],
                "observation": r[5],
                "severity": r[6],
                "scope_citation": r[7],
                "adjacency_contract_ref": r[8],
                "handoff_prompt_draft": r[9],
                "handoff_status": r[10],
                "observed_at": r[11],
            }
            for r in cur.fetchall()
        ]


def list_for_run_with_recommendation(run_id: int, limit: int = 100) -> list[dict]:
    """List observations for a run, each enriched with its newest recommendation.

    Slimmer field set than list_for_run (no adjacency_contract_ref/handoff_*/
    observed_at) plus a nested `recommendation` key: {id, action_type,
    headline, self_classification, status}, or None when the observation has
    no recommendation yet. One rec per observation is the norm; the LATERAL
    join picks the newest by created_at in the rare case more than one exists
    (e.g. a supersession chain). Used by GET /api/dq/runs/{run_id}/detail.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.id, o.tag, o.entity_type, o.entity_id, o.issue_type,
                   o.observation, o.severity, o.scope_citation,
                   r.id, r.action_type, r.headline, r.self_classification, r.status
            FROM dq_observations o
            LEFT JOIN LATERAL (
                SELECT id, action_type, headline, self_classification, status
                FROM dq_recommendations
                WHERE observation_id = o.id
                ORDER BY created_at DESC
                LIMIT 1
            ) r ON TRUE
            WHERE o.run_id = %s
            ORDER BY o.observed_at
            LIMIT %s
            """,
            (run_id, limit),
        )
        rows = cur.fetchall()

    out: list[dict] = []
    for r in rows:
        recommendation = None
        if r[8] is not None:
            recommendation = {
                "id": r[8],
                "action_type": r[9],
                "headline": r[10],
                "self_classification": r[11],
                "status": r[12],
            }
        out.append({
            "id": r[0],
            "tag": r[1],
            "entity_type": r[2],
            "entity_id": r[3],
            "issue_type": r[4],
            "observation": r[5],
            "severity": r[6],
            "scope_citation": r[7],
            "recommendation": recommendation,
        })
    return out


def update_handoff_status(obs_id: int, new_status: str) -> dict | None:
    """Update the handoff_status of an observation.

    Validates new_status is in ('draft', 'sent', 'dismissed') before executing.
    Returns the updated row as dict.
    """
    if new_status not in ("draft", "sent", "dismissed"):
        raise ValueError(
            f"Invalid handoff_status '{new_status}'. "
            "Must be one of: 'draft', 'sent', 'dismissed'"
        )

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE dq_observations
            SET handoff_status = %s
            WHERE id = %s
            RETURNING id, tag, entity_type, entity_id, issue_type,
                      observation, severity, scope_citation,
                      adjacency_contract_ref, handoff_prompt_draft,
                      handoff_status, observed_at
            """,
            (new_status, obs_id),
        )
        r = cur.fetchone()

    if r is None:
        return None
    return {
        "id": r[0],
        "tag": r[1],
        "entity_type": r[2],
        "entity_id": r[3],
        "issue_type": r[4],
        "observation": r[5],
        "severity": r[6],
        "scope_citation": r[7],
        "adjacency_contract_ref": r[8],
        "handoff_prompt_draft": r[9],
        "handoff_status": r[10],
        "observed_at": r[11],
    }


def list_for_user(
    user_id: int,
    tag: str | None = None,
    has_handoff: bool | None = None,
    limit: int = 200,
) -> list[dict]:
    """List observations for a user with optional filters.

    tag: if provided, filter to rows where tag = tag.
    has_handoff: if True, only rows with handoff_prompt_draft IS NOT NULL;
                 if False, only rows with handoff_prompt_draft IS NULL;
                 if None, no filter applied.
    """
    conditions = ["user_id = %s"]
    params: list = [user_id]

    if tag is not None:
        conditions.append("tag = %s")
        params.append(tag)

    if has_handoff is True:
        conditions.append("handoff_prompt_draft IS NOT NULL")
    elif has_handoff is False:
        conditions.append("handoff_prompt_draft IS NULL")

    params.append(limit)
    where_clause = " AND ".join(conditions)

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT id, tag, entity_type, entity_id, issue_type,
                   observation, severity, scope_citation,
                   adjacency_contract_ref, handoff_prompt_draft,
                   handoff_status, observed_at
            FROM dq_observations
            WHERE {where_clause}
            ORDER BY observed_at DESC
            LIMIT %s
            """,
            params,
        )
        return [
            {
                "id": r[0],
                "tag": r[1],
                "entity_type": r[2],
                "entity_id": r[3],
                "issue_type": r[4],
                "observation": r[5],
                "severity": r[6],
                "scope_citation": r[7],
                "adjacency_contract_ref": r[8],
                "handoff_prompt_draft": r[9],
                "handoff_status": r[10],
                "observed_at": r[11],
            }
            for r in cur.fetchall()
        ]


def list_handoff_prompts(
    user_id: int, status: str = "draft", limit: int = 50
) -> list[dict]:
    """List handoff prompts for a user filtered by status.

    Returns observations with handoff_prompt_draft IS NOT NULL,
    ordered by observed_at DESC.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, tag, entity_type, entity_id, issue_type,
                   observation, severity, scope_citation,
                   adjacency_contract_ref, handoff_prompt_draft,
                   handoff_status, observed_at
            FROM dq_observations
            WHERE user_id = %s AND handoff_prompt_draft IS NOT NULL
              AND handoff_status = %s
            ORDER BY observed_at DESC
            LIMIT %s
            """,
            (user_id, status, limit),
        )
        return [
            {
                "id": r[0],
                "tag": r[1],
                "entity_type": r[2],
                "entity_id": r[3],
                "issue_type": r[4],
                "observation": r[5],
                "severity": r[6],
                "scope_citation": r[7],
                "adjacency_contract_ref": r[8],
                "handoff_prompt_draft": r[9],
                "handoff_status": r[10],
                "observed_at": r[11],
            }
            for r in cur.fetchall()
        ]
