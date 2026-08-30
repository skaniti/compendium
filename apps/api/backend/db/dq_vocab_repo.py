"""Vocab CRUD + cosine-nearest helpers for the dq_observations issue_type registry.

Used by the cosine gate in `dq_agent.persist_findings` to route new findings
to the closest existing canonical label, and by the Vocab tab UI to manage
canonicalize/alias/reject lifecycle.

RLS is enforced by `dq_vocab_select` / `dq_vocab_insert` / `dq_vocab_update`
policies (migration 028). Each helper SETs `app.current_user_id` defensively
in case the caller is outside an HTTP request path (e.g., the dq_agent
subprocess).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from backend.db.connection import get_conn


@dataclass
class VocabEntry:
    user_id: int
    issue_type: str
    description: Optional[str]
    status: str  # 'canonical' | 'proposed' | 'rejected'
    aliased_to: Optional[str]
    n_proposals: int
    proposal_rationale: Optional[str]


def _vec_literal(embedding: list[float]) -> str:
    """Format a Python list as a pgvector literal '[v1,v2,...]'."""
    return "[" + ",".join(str(v) for v in embedding) + "]"


def list_canonical(user_id: int) -> list[VocabEntry]:
    """Return all canonical entries for a user.

    Used by the agent prompt to render the canonical-vocab block and by the
    cosine gate as the candidate set for nearest-neighbour matching.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            SELECT user_id, issue_type, description, status, aliased_to,
                   n_proposals, proposal_rationale
            FROM dq_vocab_issue_types
            WHERE status = 'canonical' AND user_id = %s
            ORDER BY issue_type
            """,
            (user_id,),
        )
        return [VocabEntry(*row) for row in cur.fetchall()]


def lookup(user_id: int, issue_type: str) -> Optional[VocabEntry]:
    """Return one entry by (user_id, issue_type), or None."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            SELECT user_id, issue_type, description, status, aliased_to,
                   n_proposals, proposal_rationale
            FROM dq_vocab_issue_types
            WHERE user_id = %s AND issue_type = %s
            """,
            (user_id, issue_type),
        )
        row = cur.fetchone()
        return VocabEntry(*row) if row else None


def pgvector_nearest(
    user_id: int, embedding: list[float], threshold: float = 0.0
) -> Optional[tuple[VocabEntry, float]]:
    """Nearest canonical entry by cosine similarity.

    pgvector's `<=>` operator returns cosine *distance* (0=identical,
    2=opposite); we convert to similarity via 1 - distance. Returns None
    if the nearest match's similarity is below `threshold`.
    """
    vec = _vec_literal(embedding)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            SELECT user_id, issue_type, description, status, aliased_to,
                   n_proposals, proposal_rationale,
                   1 - (description_embedding <=> %s::vector) AS sim
            FROM dq_vocab_issue_types
            WHERE status = 'canonical' AND user_id = %s
              AND description_embedding IS NOT NULL
            ORDER BY description_embedding <=> %s::vector
            LIMIT 1
            """,
            (vec, user_id, vec),
        )
        row = cur.fetchone()
        if not row or row[7] < threshold:
            return None
        return VocabEntry(*row[:7]), float(row[7])


def insert_proposal(
    user_id: int,
    issue_type: str,
    rationale: Optional[str],
    run_id: Optional[int],
) -> None:
    """Insert a proposed entry, or bump the counter on an existing one.

    Resurfacing rule: if the existing entry is rejected-but-not-aliased,
    re-proposing flips it back to 'proposed' so the user sees it again.
    Aliased rejections stay rejected -- the alias decision is sticky.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            INSERT INTO dq_vocab_issue_types
                (user_id, issue_type, status, proposal_rationale,
                 last_proposed_at, last_proposing_run_id, n_proposals)
            VALUES (%s, %s, 'proposed', %s, NOW(), %s, 1)
            ON CONFLICT (user_id, issue_type)
            DO UPDATE SET
                n_proposals = dq_vocab_issue_types.n_proposals + 1,
                last_proposed_at = NOW(),
                last_proposing_run_id = EXCLUDED.last_proposing_run_id,
                status = CASE
                    WHEN dq_vocab_issue_types.status = 'rejected'
                         AND dq_vocab_issue_types.aliased_to IS NULL
                    THEN 'proposed'
                    ELSE dq_vocab_issue_types.status
                END
            """,
            (user_id, issue_type, rationale, run_id),
        )


def canonicalize(
    user_id: int,
    issue_type: str,
    description: str,
    embedding: list[float],
    canonicalized_by: int,
) -> None:
    """Promote an entry to canonical with a description + embedding."""
    vec = _vec_literal(embedding)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            UPDATE dq_vocab_issue_types
            SET status = 'canonical',
                description = %s,
                description_embedding = %s::vector,
                canonicalized_at = NOW(),
                canonicalized_by_user_id = %s,
                aliased_to = NULL
            WHERE user_id = %s AND issue_type = %s
            """,
            (description, vec, canonicalized_by, user_id, issue_type),
        )


def alias_to(user_id: int, issue_type: str, target: str) -> None:
    """Reject an entry and silently rewrite future findings to the target."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            UPDATE dq_vocab_issue_types
            SET status = 'rejected', aliased_to = %s
            WHERE user_id = %s AND issue_type = %s
            """,
            (target, user_id, issue_type),
        )


def reject(user_id: int, issue_type: str) -> None:
    """Reject without alias. Re-proposal can flip it back to proposed."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            UPDATE dq_vocab_issue_types
            SET status = 'rejected', aliased_to = NULL
            WHERE user_id = %s AND issue_type = %s
            """,
            (user_id, issue_type),
        )
