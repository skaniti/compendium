"""S1 -- Skip-gate reversal audit.

Deterministic investigation: groups user validation labels by the
skip_reasoning text that the skip-gate LLM emitted, and flags patterns
where the user frequently disagrees with the skip decision.

Threshold (from dq_agent_scope.md): >=3 total pages with the pattern AND
>=2 of them labelled 'incorrect'.

Simplification for v1: exact string match on the full skip_reasoning value.
Skip-gate output is templated, so exact matches catch most real patterns.
Substring / n-gram matching is a future refinement.

Emits findings structured for DQAgent.persist_findings.
"""

from collections import defaultdict

from backend.db.connection import get_conn

SCOPE_ID = "S1"
ACTION_TYPE = "edit_prompt"
MIN_TOTAL = 3
MIN_INCORRECT = 2


def run(user_id: int, recluster_run_id: int | None = None) -> list[dict]:
    """Return S1 findings for the given user.

    Args:
        user_id: the user to investigate.
        recluster_run_id: accepted for interface uniformity with the other
            five investigators (Task 8's full-pass snapshot calls all six
            with the same signature) but UNUSED here -- S1 scans
            validation annotations directly and has no recluster_run
            concept to scope against.

    Queries the annotations table for validate_archive labels, groups by the
    exact skip_reasoning text stored on the pages row, and emits one finding
    per pattern that meets the threshold.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.skip_reasoning, a.new_value, a.note
            FROM annotations a
            JOIN pages p ON a.entity_id = p.id
            WHERE a.user_id = %s
              AND a.entity_type = 'page'
              AND a.action = 'validate_archive'
              AND p.skip_reasoning IS NOT NULL
              AND p.skip_reasoning <> ''
            """,
            (user_id,),
        )
        rows = cur.fetchall()

    # Separate int counts from list-of-notes so pyright can narrow the
    # value types cleanly; heterogeneous dict values (int + list) confuse
    # static analysis.
    counts: dict[str, dict[str, int]] = defaultdict(
        lambda: {"total": 0, "incorrect": 0}
    )
    notes_by_reason: dict[str, list[str]] = defaultdict(list)

    for _page_id, skip_reasoning, new_value, note in rows:
        counts[skip_reasoning]["total"] += 1
        if new_value == "incorrect":
            counts[skip_reasoning]["incorrect"] += 1
            if note:
                notes_by_reason[skip_reasoning].append(note)

    qualifying = [
        (reason, c)
        for reason, c in counts.items()
        if c["total"] >= MIN_TOTAL and c["incorrect"] >= MIN_INCORRECT
    ]
    qualifying.sort(key=lambda rc: -rc[1]["incorrect"])

    findings = []
    for rank, (reason, c) in enumerate(qualifying, start=1):
        reason_preview = reason[:80] + ("..." if len(reason) > 80 else "")
        notes = notes_by_reason[reason]
        notes_str = " / ".join(notes[:3]) if notes else ""
        rationale_tail = f" User notes: {notes_str}" if notes_str else ""

        findings.append({
            "tag": "core",
            "scope_citation": SCOPE_ID,
            "adjacency_contract_ref": None,
            "issue_type": "reversal_pattern",
            "entity_type": "global",
            "entity_id": "skip_gate_prompt",
            "observation": (
                f"Skip-gate pattern '{reason_preview}' marked incorrect in "
                f"{c['incorrect']}/{c['total']} labelled pages."
            ),
            "severity": "warning",
            "rank": rank,
            "recommendation": {
                "headline": f"Revise skip-gate handling of phrase: '{reason_preview}'",
                "rationale": (
                    f"{c['incorrect']} of {c['total']} pages with reasoning "
                    f"pattern '{reason_preview}' were labelled incorrect by the user."
                    f"{rationale_tail}"
                ),
                "self_classification": "judgment",
                "action_type": ACTION_TYPE,
                "affected_entity_ids": ["skip_gate_prompt"],
            },
            "handoff_prompt_draft": None,
        })

    return findings
