"""Verdict-history renderer for dqBot Tier 2
(the 2026-07-19 dqbot-tier2-role-split plan, private).

Renders the user's accumulated approve/reject/dismiss verdicts on past
dq_recommendations into one markdown block -- deterministic and
guaranteed-seen by the Opus synthesis pass, rather than left for Opus to
query live via psql (spec's "Verdict history" section). Task 7
(dq_agent.py) embeds the returned string verbatim into the synthesis
prompt; Task 8 (dq_run_executor.py) calls this once per full run.

Pure formatting + SQL -- no LLM calls.
"""

import logging

from backend.db.connection import get_conn
from backend.db.dq_recommendations_repo import calibration_by_action_type

logger = logging.getLogger(__name__)

_HEADER = "## VERDICT HISTORY (how this user has judged your past findings)"
_EMPTY_STUB = f"{_HEADER}\n\n(no verdict history yet)\n"

_RECENT_RESOLVED_LIMIT = 15
_RECURRENCE_LIMIT = 10


def render_verdict_history(user_id: int, max_chars: int = 16000) -> str:
    """## VERDICT HISTORY (how this user has judged your past findings)

    Sections, in priority order (later sections trimmed first to fit
    max_chars):
      1. Calibration rates by action_type (calibration_by_action_type).
      2. Per-issue_type outcome rollup (SQL GROUP BY o.issue_type, r.status).
      3. REJECTED verdicts, verbatim user_note each (never trimmed).
      4. Recent resolved notes: newest 15 approved/dismissed user_notes
         (id, action_type, status, note), newest first.
      5. Recurrence: per entity_id with a supersession chain,
         COUNT(DISTINCT run_id) over the chain (top 10 by count).

    Trimming drops sections in order 5 -> 4 -> 2, one item at a time from
    the tail of each (lowest-count recurrence entries first; oldest
    resolved notes first since section 4 is rendered newest-first),
    stopping the moment the assembled text fits max_chars. Sections 1
    (calibration) and 3 (rejected) always survive in full -- even if the
    result then still exceeds max_chars -- because calibration and
    rejections are the exact signal this renderer exists to guarantee
    Opus sees.

    Returns a "(no verdict history yet)" stub when the user has no
    calibration, rollup, rejected, resolved, or recurrence data at all.
    """
    calibration = calibration_by_action_type(user_id, limit=20)
    issue_rollup = _fetch_issue_type_rollup(user_id)
    rejected = _fetch_rejected_notes(user_id)
    resolved = _fetch_recent_resolved_notes(user_id, limit=_RECENT_RESOLVED_LIMIT)
    recurrence = _fetch_recurrence(user_id, limit=_RECURRENCE_LIMIT)

    if not (calibration or issue_rollup or rejected or resolved or recurrence):
        return _EMPTY_STUB

    calibration_block = _render_calibration_block(calibration)
    rejected_block = _render_rejected_block(rejected)
    issue_header, issue_items = _render_issue_rollup_items(issue_rollup)
    resolved_header, resolved_items = _render_resolved_items(resolved)
    recurrence_header, recurrence_items = _render_recurrence_items(recurrence)

    return _assemble(
        max_chars,
        calibration_block,
        rejected_block,
        issue_header,
        issue_items,
        resolved_header,
        resolved_items,
        recurrence_header,
        recurrence_items,
    )


def _assemble(
    max_chars: int,
    calibration_block: str,
    rejected_block: str,
    issue_header: str,
    issue_items: list[str],
    resolved_header: str,
    resolved_items: list[str],
    recurrence_header: str,
    recurrence_items: list[str],
) -> str:
    """Join sections and trim to max_chars, order 5 -> 4 -> 2, tail-first.

    issue_items/resolved_items/recurrence_items are consumed (popped) as
    local copies -- calibration_block and rejected_block are immutable
    strings and never touched.
    """
    issue_items = list(issue_items)
    resolved_items = list(resolved_items)
    recurrence_items = list(recurrence_items)

    def build() -> str:
        parts = [_HEADER, calibration_block]
        if issue_items:
            parts.append(issue_header + "\n" + "\n".join(issue_items))
        parts.append(rejected_block)
        if resolved_items:
            parts.append(resolved_header + "\n" + "\n".join(resolved_items))
        if recurrence_items:
            parts.append(recurrence_header + "\n" + "\n".join(recurrence_items))
        return "\n\n".join(parts) + "\n"

    text = build()
    while len(text) > max_chars and recurrence_items:
        recurrence_items.pop()  # lowest-count entry first (list sorted desc by count)
        text = build()
    while len(text) > max_chars and resolved_items:
        resolved_items.pop()  # oldest note first (list is newest-first)
        text = build()
    while len(text) > max_chars and issue_items:
        issue_items.pop()
        text = build()
    return text


def _render_calibration_block(rows: list[dict]) -> str:
    lines = ["### Calibration by action type"]
    if not rows:
        lines.append("(no reviewed recommendations yet)")
    for row in rows:
        pct = round(row["approval_rate"] * 100)
        lines.append(
            f"- {row['action_type']}: {row['approved']}/{row['total_reviewed']} approved ({pct}%)"
        )
    return "\n".join(lines)


def _render_rejected_block(rows: list[tuple[int, str, str]]) -> str:
    lines = ["### Rejected recommendations (your notes -- never trimmed)"]
    if not rows:
        lines.append("(none yet)")
    for rec_id, action_type, note in rows:
        lines.append(f'- [rec {rec_id}] {action_type}: "{note}"')
    return "\n".join(lines)


def _render_issue_rollup_items(rows: list[tuple[str, str, int]]) -> tuple[str, list[str]]:
    header = "### Outcomes by issue type"
    by_issue: dict[str, dict[str, int]] = {}
    for issue_type, status, count in rows:
        by_issue.setdefault(issue_type, {})[status] = count
    items = [
        f"- {issue_type}: " + ", ".join(f"{status} {n}" for status, n in sorted(counts.items()))
        for issue_type, counts in sorted(by_issue.items())
    ]
    return header, items


def _render_resolved_items(rows: list[tuple[int, str, str, str]]) -> tuple[str, list[str]]:
    header = "### Recent approved/dismissed notes (newest first)"
    items = [
        f'- [rec {rec_id}] {action_type} {status}: "{note}"'
        for rec_id, action_type, status, note in rows
    ]
    return header, items


def _render_recurrence_items(rows: list[tuple[str, int]]) -> tuple[str, list[str]]:
    header = "### Recurring findings (same entity flagged across multiple runs)"
    items = [
        f"- entity {entity_id}: recommended in {n_runs} separate runs" for entity_id, n_runs in rows
    ]
    return header, items


def _fetch_issue_type_rollup(user_id: int) -> list[tuple[str, str, int]]:
    """(issue_type, status, count) for every (issue_type, status) pair the
    user's recs have landed in, joined via observation_id. Recs with no
    observation_id (record-only/legacy) are excluded -- they have no
    issue_type to roll up under."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.issue_type, r.status, COUNT(*)
            FROM dq_recommendations r
            JOIN dq_observations o ON o.id = r.observation_id
            WHERE r.user_id = %s
            GROUP BY o.issue_type, r.status
            ORDER BY o.issue_type, r.status
            """,
            (user_id,),
        )
        return cur.fetchall()


def _fetch_rejected_notes(user_id: int) -> list[tuple[int, str, str]]:
    """(id, action_type, user_note) for ALL rejected recs with a note --
    the corpus's hard negatives, never trimmed from the render."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, action_type, user_note
            FROM dq_recommendations
            WHERE user_id = %s AND status = 'rejected'
              AND user_note IS NOT NULL AND user_note <> ''
            ORDER BY reviewed_at DESC NULLS LAST, id DESC
            """,
            (user_id,),
        )
        return cur.fetchall()


def _fetch_recent_resolved_notes(user_id: int, limit: int) -> list[tuple[int, str, str, str]]:
    """(id, action_type, status, user_note) for the newest `limit`
    approved/dismissed notes, newest first."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, action_type, status, user_note
            FROM dq_recommendations
            WHERE user_id = %s AND status IN ('approved', 'dismissed')
              AND user_note IS NOT NULL AND user_note <> ''
            ORDER BY reviewed_at DESC NULLS LAST, id DESC
            LIMIT %s
            """,
            (user_id, limit),
        )
        return cur.fetchall()


def _fetch_recurrence(user_id: int, limit: int) -> list[tuple[str, int]]:
    """(entity_id, distinct_run_count) for entities whose recs form a
    supersession chain, top `limit` by run count.

    Chain membership: a rec is part of a chain if it was itself superseded
    (superseded_by IS NOT NULL) or if it is the target another rec's
    superseded_by points at (the chain's current head).
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.entity_id, COUNT(DISTINCT r.run_id) AS n_runs
            FROM dq_recommendations r
            JOIN dq_observations o ON o.id = r.observation_id
            WHERE r.user_id = %s
              AND (
                  r.superseded_by IS NOT NULL
                  OR r.id IN (
                      SELECT superseded_by FROM dq_recommendations
                      WHERE user_id = %s AND superseded_by IS NOT NULL
                  )
              )
            GROUP BY o.entity_id
            ORDER BY n_runs DESC, o.entity_id
            LIMIT %s
            """,
            (user_id, user_id, limit),
        )
        return cur.fetchall()
