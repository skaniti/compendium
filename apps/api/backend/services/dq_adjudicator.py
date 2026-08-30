"""Upstream rival-hypothesis adjudicator for pre-detected structural findings.

Rec 260: the rival-hypothesis false-positive check for S2 (cluster
coherence) and S4 (supercluster drift) candidates used to run only inside
the expensive Opus dqBot pass, one candidate at a time
(``dq_investigations.rival_hypothesis_guard``). This module moves that
check upstream of the Opus pass, batched, so structurally-obvious false
positives never reach the expensive agent at all: it judges S2/S4
candidates ``BATCH_SIZE`` at a time against a single cheap
(``ADJUDICATION_MODEL``) LLM call, suppressing the ones a rival hypothesis
already explains and refining the surviving ones' recommended action
(relabel / split / flag-for-review) in the same pass.

S1/S3/S5/S6 candidates never needed the rival-hypothesis guard (see
``dq_agent_scope.md``'s "Rival-hypothesis pattern" meta note) and pass
through untouched.

Synchronous wrapper around the async ``LLMService.complete()`` -- same
precedent as the old guard: safe to call from investigators/workers that
run on a thread with no event loop (``asyncio.run()``); calling from an
already-running asyncio context will raise.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
from typing import Optional

from backend.services.llm_service import LLMService

logger = logging.getLogger(__name__)

# Cheap model for the batched adjudication call -- this is the whole point
# of moving the check upstream of the Opus pass (rec 260).
ADJUDICATION_MODEL = "gpt-4o-mini"

# Candidates per LLM call. Keeps the per-call prompt (up to 30 members
# rendered per candidate) bounded regardless of how many S2/S4 candidates
# a run produces.
BATCH_SIZE = 15

# Env var name for the operator kill switch. Read at CALL time (inside
# _adjudication_disabled), never cached at import time, so tests can
# monkeypatch os.environ freely and callers can flip it without a reload.
DQ_ADJUDICATION_DISABLED_ENV = "DQ_ADJUDICATION_DISABLED"

# Only these scope citations carry the rival-hypothesis judgment call --
# see dq_agent_scope.md's "Rival-hypothesis pattern" meta note. Everything
# else (S1, S3, S5, S6, or missing/unrecognized citations) passes through.
_ADJUDICATED_SCOPES = frozenset({"S2", "S4"})

# Member preview cap per candidate -- prompt-verboseness guard, same
# rationale as DQ_MAX_CANDIDATES_PER_INVESTIGATOR in dq_agent.py.
_MEMBER_PREVIEW_LIMIT = 30

_PROMPT = """You are adjudicating pre-detected data-quality findings about a personal
knowledge compendium's topic clusters. For EACH candidate below, run a
rival-hypothesis check: given ONLY the cluster label, would you have
predicted the observed membership? If the membership is consistent with the
label's natural scope, the finding is a false positive -- suppress it.
Heterogeneity-as-intentional is the default; incoherence is the exception.
Judge each candidate independently, on its member evidence, not its metric.

For confirmed cluster-coherence candidates also refine the action:
"relabel_cluster" (membership coherent, label wrong -- give proposed_label),
"split_cluster" (minority of members don't belong -- list their
page_content_ids in evict_page_content_ids), or "flag_for_review" (unclear).
Label discipline: a proposed_label must describe the FULL membership and
stay accurate if similar pages join; when no such label exists, prefer
flag_for_review over a weak label.

Candidates:
{candidates_block}

Respond ONLY with JSON: {{"verdicts": [{{"index": <int>, "verdict":
"confirm"|"suppress", "confidence": <0..1>, "reason": "<one line>",
"refined_action": "relabel_cluster"|"split_cluster"|"flag_for_review"|null,
"proposed_label": "<string>"|null, "evict_page_content_ids": [<int>...]|null}}]}}
One verdicts entry per candidate index, no extras."""

# Lazy LLM instance -- created on first use, reused across calls (same
# pattern as dq_investigations.rival_hypothesis_guard._get_llm).
_llm_service: Optional[LLMService] = None


def _get_llm() -> LLMService:
    global _llm_service
    if _llm_service is None:
        _llm_service = LLMService()
    return _llm_service


def _llm_call(prompt: str) -> str:
    """Sync wrapper around async LLMService.complete(). Returns text content."""
    response = asyncio.run(
        _get_llm().complete(
            prompt,
            model=ADJUDICATION_MODEL,
            temperature=0.0,
            seed=42,
            max_tokens=4000,
            response_format="json_object",
        )
    )
    return response.content


def _adjudication_disabled() -> bool:
    return os.environ.get(DQ_ADJUDICATION_DISABLED_ENV, "0") == "1"


def _candidate_label(candidate: dict) -> str:
    """Best-effort human label for a candidate, for the prompt block.

    S2 candidates carry the cluster label in evidence.items[0] (type
    "cluster"); S4's entity_id IS the supercluster label already. Falls
    back to entity_id for anything else / malformed evidence so a missing
    field never crashes prompt construction.
    """
    if candidate.get("scope_citation") == "S2":
        items = (candidate.get("evidence") or {}).get("items") or []
        if items and isinstance(items[0], dict) and items[0].get("type") == "cluster":
            label = items[0].get("label")
            if label:
                return str(label)
    return str(candidate.get("entity_id", ""))


def _render_candidate_block(index: int, candidate: dict) -> str:
    scope = candidate.get("scope_citation", "")
    label = _candidate_label(candidate)
    observation = candidate.get("observation", "")
    lines = [
        f'[{index}] scope={scope} label="{label}"',
        f"metrics: {observation}",
    ]

    members = candidate.get("members")
    children = candidate.get("children")
    if members is not None:
        preview = members[:_MEMBER_PREVIEW_LIMIT]
        lines.append(f"members ({len(members)} total, showing {len(preview)}):")
        for member in preview:
            title = member.get("title") or "(untitled)"
            domain = member.get("domain") or "no-domain"
            page_content_id = member.get("page_content_id")
            lines.append(
                f'  - "{title}" ({domain}) [page_content_id={page_content_id}]'
            )
    elif children is not None:
        lines.append(f"children: {', '.join(str(c) for c in children)}")

    return "\n".join(lines)


def _build_prompt(batch: list[dict]) -> str:
    candidates_block = "\n\n".join(
        _render_candidate_block(i, candidate) for i, candidate in enumerate(batch)
    )
    return _PROMPT.format(candidates_block=candidates_block)


def _validate_verdicts(parsed: dict, n: int) -> dict[int, dict]:
    """Parse+validate the {"verdicts": [...]} payload into {index: entry}.

    Raises ValueError on any structural problem: missing/non-list
    "verdicts", a missing "index"/"verdict" key, an unrecognized verdict
    value, or index coverage that doesn't exactly match {0, ..., n-1}
    (missing indices or extras both fail). Callers treat any ValueError as
    "retry once, then skip the batch."
    """
    verdicts = parsed["verdicts"]
    if not isinstance(verdicts, list):
        raise ValueError("'verdicts' is not a list")

    by_index: dict[int, dict] = {}
    for entry in verdicts:
        index = entry["index"]
        verdict = entry["verdict"]
        if verdict not in ("confirm", "suppress"):
            raise ValueError(f"unrecognized verdict {verdict!r}")
        by_index[index] = entry

    expected = set(range(n))
    if set(by_index.keys()) != expected:
        raise ValueError(
            f"index coverage mismatch: expected {sorted(expected)}, "
            f"got {sorted(by_index.keys())}"
        )
    return by_index


def _judge_batch(batch: list[dict], user_id: int) -> Optional[dict[int, dict]]:
    """Run one adjudication LLM call for a batch, with one retry on failure.

    Returns {batch_index: verdict_entry} on success, or None if both the
    initial call and the retry failed to parse/validate -- signaling the
    caller to mark the whole batch skipped (pass through, fail-open).
    """
    prompt = _build_prompt(batch)
    last_error: Optional[Exception] = None
    for attempt in (1, 2):
        # The LLM call itself lives INSIDE the try: a transport/API error
        # (timeout, 5xx) must hit the same retry + fail-open path as a
        # parse failure -- otherwise one OpenAI hiccup crashes the whole
        # weekly full run instead of skipping a batch (final-review F1).
        try:
            raw = _llm_call(prompt)
            parsed = json.loads(raw)
            return _validate_verdicts(parsed, len(batch))
        except Exception as exc:  # noqa: BLE001 - fail-open by design
            last_error = exc
            logger.warning(
                "[dq-adjudicator] batch call/parse/validation failed "
                "(attempt %d/2) user_id=%s batch_size=%d: %s",
                attempt, user_id, len(batch), exc,
            )
    logger.error(
        "[dq-adjudicator] batch skipped after retry exhausted; "
        "user_id=%s batch_size=%d last_error=%s",
        user_id, len(batch), last_error,
    )
    return None


def _apply_refinement(candidate: dict, verdict_entry: dict) -> None:
    """Rewrite a confirmed candidate's recommendation per refined_action.

    Mutates ``candidate`` in place (caller passes a fresh copy). No-op when
    there's no recommendation sub-dict to refine, or refined_action is
    null/unrecognized/missing its required payload field -- degrading to
    "leave the deterministic default action_type alone" rather than
    guessing, same fail-open discipline as the rest of dqBot's
    action_payload handling.
    """
    refined_action = verdict_entry.get("refined_action")
    if not refined_action:
        return

    # Refinement is an S2-only concept (relabel/split/flag on a leaf
    # cluster). S4 supercluster recs are record-only (spec non-goals); a
    # stray refined_action on an S4 verdict must not rewrite one into an
    # inapplicable cluster action (final-review F3).
    if candidate.get("scope_citation") != "S2":
        return

    recommendation = candidate.get("recommendation")
    if not isinstance(recommendation, dict):
        return

    if refined_action == "relabel_cluster":
        proposed_label = verdict_entry.get("proposed_label")
        if not proposed_label:
            return
        recommendation["action_type"] = "relabel_cluster"
        payload = recommendation.get("action_payload") or {}
        payload["proposed_label"] = proposed_label
        recommendation["action_payload"] = payload

    elif refined_action == "split_cluster":
        evict_ids = verdict_entry.get("evict_page_content_ids")
        if not evict_ids:
            return
        recommendation["action_type"] = "split_cluster"
        payload = recommendation.get("action_payload") or {}
        payload["remove_page_content_ids"] = evict_ids
        recommendation["action_payload"] = payload

    elif refined_action == "flag_for_review":
        recommendation["action_type"] = "flag_for_review"


def adjudicate(candidates: list[dict], user_id: int) -> dict:
    """Run the upstream rival-hypothesis adjudication pass.

    S1/S3/S5/S6 (and anything else not S2/S4) candidates pass through
    untouched -- they never needed the rival-hypothesis guard. S2/S4
    candidates are judged BATCH_SIZE at a time via one cheap LLM call per
    batch: "suppress" verdicts are pulled into ``suppressed`` (never
    persisted downstream), "confirm" verdicts survive with an
    ``adjudication`` receipt and, when the model proposed a refined_action,
    a rewritten ``recommendation.action_type``/``action_payload``.

    Fail-open throughout: DQ_ADJUDICATION_DISABLED=1 skips the LLM
    entirely (every candidate passes through flagged skipped); a batch
    whose response fails to parse/validate twice also passes through
    flagged skipped rather than dropping candidates or raising.

    Returns:
        {
          "survivors": [...],       # candidates that were not suppressed
          "suppressed": [           # {"candidate", "reason", "confidence"}
              {"candidate": ..., "reason": "...", "confidence": 0.9}, ...
          ],
          "stats": {
              "judged": int,          # candidates that got a real verdict
              "passed_through": int,  # never judged (wrong scope, or
                                       # disabled/skipped-batch fail-open)
              "suppressed": int,      # subset of judged: verdict=suppress
              "skipped_batches": int, # batches that failed twice and were
                                       # passed through instead
          },
        }
    """
    stats = {"judged": 0, "passed_through": 0, "suppressed": 0, "skipped_batches": 0}

    if _adjudication_disabled():
        logger.info(
            "[dq-adjudicator] disabled via %s; passing through %d candidates",
            DQ_ADJUDICATION_DISABLED_ENV, len(candidates),
        )
        survivors = []
        for candidate in candidates:
            skipped = dict(candidate)
            skipped["adjudication"] = "skipped"
            survivors.append(skipped)
        stats["passed_through"] = len(candidates)
        return {"survivors": survivors, "suppressed": [], "stats": stats}

    survivors: list[dict] = []
    suppressed: list[dict] = []
    to_judge: list[dict] = []

    for candidate in candidates:
        if candidate.get("scope_citation") in _ADJUDICATED_SCOPES:
            to_judge.append(candidate)
        else:
            survivors.append(candidate)
            stats["passed_through"] += 1

    for start in range(0, len(to_judge), BATCH_SIZE):
        batch = to_judge[start:start + BATCH_SIZE]
        verdicts = _judge_batch(batch, user_id)

        if verdicts is None:
            stats["skipped_batches"] += 1
            for candidate in batch:
                skipped = dict(candidate)
                skipped["adjudication"] = "skipped"
                survivors.append(skipped)
                stats["passed_through"] += 1
            continue

        for i, candidate in enumerate(batch):
            entry = verdicts[i]
            stats["judged"] += 1
            confidence = entry.get("confidence")
            reason = entry.get("reason")

            if entry["verdict"] == "suppress":
                stats["suppressed"] += 1
                suppressed.append({
                    "candidate": copy.deepcopy(candidate),
                    "reason": reason,
                    "confidence": confidence,
                })
                continue

            confirmed = copy.deepcopy(candidate)
            confirmed["adjudication"] = {
                "verdict": "confirm",
                "confidence": confidence,
                "reason": reason,
            }
            _apply_refinement(confirmed, entry)
            survivors.append(confirmed)

    return {"survivors": survivors, "suppressed": suppressed, "stats": stats}
