"""Opt-in: ask the LLM for description suggestions on each proposed vocab entry.

The Vocab tab requires a 1-2 sentence description before an entry can be
canonicalized -- that description is what the cosine gate compares against.
This helper drafts those descriptions in bulk so the user can paste them into
the Vocab tab during canonicalization rather than writing each one cold.

Behavior:
  - Reads every ``status='proposed'`` vocab entry for the target user
  - For each, fetches up to 5 sample observations using that label
  - Prompts gpt-4o-mini for a 1-2 sentence description
  - Writes results to ``backend/scripts/output/vocab_description_suggestions.json``

Does NOT mutate the database. The user reviews the JSON, edits as needed, and
applies via the Vocab tab's canonicalize flow.

Usage:

    python -m backend.scripts.suggest_vocab_descriptions <user_id>

Example output structure:

    [
      {
        "issue_type": "cluster_coherence_drift",
        "n_proposals": 3,
        "rationale": "...",
        "n_examples": 5,
        "suggested_description": "When a cluster ..."
      },
      ...
    ]
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path

from backend.db.connection import get_conn, set_current_user_id
from backend.services.llm_service import LLMService

logger = logging.getLogger(__name__)

OUTPUT_PATH = Path("backend/scripts/output/vocab_description_suggestions.json")
SUGGESTION_MODEL = "gpt-4o-mini"
MAX_EXAMPLES_PER_ENTRY = 5


def _fetch_proposed_with_examples(user_id: int) -> list[dict]:
    """Return one row per proposed vocab entry, with its sample observations."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            SELECT v.issue_type,
                   v.proposal_rationale,
                   v.n_proposals,
                   COALESCE(
                     (SELECT json_agg(observation)
                      FROM (
                        SELECT observation FROM dq_observations
                        WHERE user_id = v.user_id AND issue_type = v.issue_type
                        ORDER BY observed_at DESC LIMIT %s
                      ) x),
                     '[]'::json
                   ) AS examples
            FROM dq_vocab_issue_types v
            WHERE v.user_id = %s AND v.status = 'proposed'
            ORDER BY v.n_proposals DESC, v.issue_type
            """,
            (MAX_EXAMPLES_PER_ENTRY, user_id),
        )
        rows = cur.fetchall()
    return [
        {
            "issue_type": r[0],
            "rationale": r[1] or "(no rationale provided by dqbot)",
            "n_proposals": r[2],
            "examples": r[3] or [],
        }
        for r in rows
    ]


async def _suggest_one(svc: LLMService, entry: dict) -> str:
    """Ask the LLM for a 1-2 sentence description of one issue_type."""
    examples = entry["examples"] or []
    examples_block = (
        "\n".join(f"- {ex[:240]}" for ex in examples[:MAX_EXAMPLES_PER_ENTRY])
        if examples
        else "(no observations have used this label yet)"
    )
    prompt = (
        f"You are helping define the canonical description of a data-quality "
        f"issue type called '{entry['issue_type']}'. The description will be "
        f"used by a cosine-similarity gate to route future findings to the "
        f"right canonical label, so it should capture the structural pattern, "
        f"not just one symptom.\n\n"
        f"Rationale dqbot gave when proposing this label: {entry['rationale']}\n\n"
        f"Examples (recent observations using this label):\n{examples_block}\n\n"
        f"Write ONE OR TWO sentences (no more) that describe the structural "
        f"pattern this issue_type captures. Plain prose, no preface, no quote "
        f"marks. Aim for the kind of definition you would put in a glossary."
    )
    response = await svc.complete(
        prompt=prompt,
        model=SUGGESTION_MODEL,
        temperature=0.3,
        max_tokens=200,
    )
    return (response.content or "").strip()


async def main(user_id: int) -> None:
    set_current_user_id(user_id)

    entries = _fetch_proposed_with_examples(user_id)
    if not entries:
        print(f"No proposed vocab entries for user_id={user_id}. Nothing to suggest.")
        return

    print(
        f"Found {len(entries)} proposed entries for user_id={user_id}. "
        f"Drafting suggestions via {SUGGESTION_MODEL}..."
    )

    svc = LLMService()
    out = []
    for i, entry in enumerate(entries, 1):
        try:
            suggestion = await _suggest_one(svc, entry)
        except Exception as exc:
            logger.exception("LLM call failed for %s", entry["issue_type"])
            suggestion = f"(LLM call failed: {exc})"
        out.append(
            {
                "issue_type": entry["issue_type"],
                "n_proposals": entry["n_proposals"],
                "rationale": entry["rationale"],
                "n_examples": len(entry["examples"]),
                "suggested_description": suggestion,
            }
        )
        print(f"  [{i}/{len(entries)}] {entry['issue_type']}: {suggestion[:80]}...")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(out, indent=2))
    print(f"\nWrote {len(out)} suggestions to {OUTPUT_PATH}")
    print(
        "Review the JSON, edit descriptions as needed, then paste the chosen "
        "text into the Vocab tab and click 'canonicalize' on each entry."
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    if len(sys.argv) != 2:
        print("Usage: python -m backend.scripts.suggest_vocab_descriptions <user_id>")
        sys.exit(2)
    try:
        target_user = int(sys.argv[1])
    except ValueError:
        print(f"user_id must be an integer (got {sys.argv[1]!r})")
        sys.exit(2)
    asyncio.run(main(target_user))
