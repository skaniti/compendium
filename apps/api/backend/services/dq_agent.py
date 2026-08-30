"""dqBot -- data-quality investigator agent.

Invokes Claude Code via `claude -p --output-format stream-json --verbose`
subprocess and streams JSONL events as they arrive. Each event is routed to an
optional on_event callback so the orchestrator can write it to dq_run_events in
real time (for the frontend event-log panel).

Retry logic: if the first attempt exits non-zero within 60s with empty stderr
and no result event (transient CC failure pattern), one automatic retry is made.
Slower failures and failures with stderr output are not retried.

Success is defined as receiving a `result` event with is_error=False --
NOT by returncode or stderr heuristics. This structurally resolves the
silent-success bug where empty-stderr non-zero exits triggered complete_run().

See docs/project-plans/_completed/2026-04-20-dq-helper/design.md for design intent
and the "Runtime architecture -- CC subprocess pattern" section of the
implementation plan for invocation + parsing details.
"""

import importlib
import io
import json
import logging
import os
import subprocess
import threading
import time
from pathlib import Path
from subprocess import PIPE
from typing import Callable, Optional

from backend.db import (
    dq_observations_repo,
    dq_recommendations_repo,
    dq_vocab_repo,
)

logger = logging.getLogger(__name__)

# Cosine threshold for the vocab gate. Findings whose embedded text matches
# an existing canonical entry above this threshold are routed to that entry;
# below, they spawn a vocab proposal. Tuned empirically; revisit after
# observing routing patterns over ~10 runs (see spec, Section 4).
COSINE_THRESHOLD = 0.7

# Default CC command; model can be overridden per-invocation via --model.
DQ_CLAUDE_CMD = "claude"
DQ_SUBPROCESS_TIMEOUT_SEC = 600  # 10 min ceiling per investigation pass
# Explicit tool allowlist passed to claude via --allowedTools. Avoids the
# root-restriction that --permission-mode bypassPermissions imposes in the
# worker container while keeping tight control: only tools the agent actually
# needs are pre-approved. Safety comes from subscription auth + read-only
# discipline enforced by the system prompt and scope doc.
DQ_ALLOWED_TOOLS = "Bash Read Grep Glob"
# Model: Claude Code's `opus` alias -- resolves to the newest Opus release
# dynamically (no version pin to go stale) -- with the `[1m]` 1M-token
# context-size selector appended. Required because the legacy monolithic
# prompt (scope + adjacency + up to 250 raw candidates) routinely exceeds
# the 200K context of standard Sonnet/Opus -- claude rejects the prompt
# with `is_error=true: Prompt is too long` if it tries to fit; the Tier-2
# synthesis prompt (survivors + adjudication summary + verdict history) is
# much smaller (~40-80K tokens) but keeps the same selector for
# consistency (Tier-2 spec decision 5,
# docs/project-plans/2026-07-19-131356-dqbot-tier2-role-split/spec.md).
# Runs off subscription billing under the current Anthropic ToS, so the
# `[1m]` selector's cost is not the binding constraint -- it's insurance
# against a future API-only-billing switch. Override via env var
# (DQ_CLAUDE_MODEL) if the alias+selector combo doesn't resolve in
# `claude -p`; the documented fallback is a pinned claude-opus-4-8[1m].
DQ_CLAUDE_MODEL = os.environ.get("DQ_CLAUDE_MODEL", "opus[1m]")
# Generous per-investigator cap on candidate count. Addresses prompt
# verboseness only -- not cost, not time. The investigator floor is "send
# everything that has signal"; this cap is the ceiling above which we'd be
# inflating the prompt with noise. Override via env var when iterating.
DQ_MAX_CANDIDATES_PER_INVESTIGATOR = int(
    os.environ.get("DQ_MAX_CANDIDATES_PER_INVESTIGATOR", "50")
)

_SCOPE_PATH = Path(__file__).parent / "dq_agent_scope.md"
_ADJACENCY_PATH = Path(__file__).parent / "dq_agent_adjacency.md"


def _parse_result_text(result_text: str) -> dict:
    """Parse the agent's final answer text from the result event.

    Strips markdown code fences if present, then locates the first '{'
    to tolerate any prose the model may prepend. Uses raw_decode to
    tolerate trailing content too.
    """
    stripped = result_text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines[0].startswith("```") and lines[-1].strip() == "```":
            stripped = "\n".join(lines[1:-1])

    brace_idx = stripped.find("{")
    if brace_idx < 0:
        raise ValueError("No JSON object found in CC result payload")
    stripped = stripped[brace_idx:]

    payload, _end = json.JSONDecoder().raw_decode(stripped)
    return payload


# Backward-compatible alias used by existing tests.
def parse_cc_output(stdout: str) -> tuple[dict, float]:
    """Parse CC output -> (dict payload, total_cost_usd) from the agent.

    CC --output-format json emits the full event stream as a single JSON
    array.  Test fixtures use bare-object-per-line JSONL.  This function
    handles both: it tries the whole-array parse first, then falls back to
    line-by-line JSONL so that existing unit-test stubs continue to work.

    After finding the 'result' event it extracts the .result text and
    delegates to _parse_result_text for fence-stripping + prose-prefix
    tolerance.  Returns (payload, cost_usd) tuple.
    """
    final_text = None
    cost_usd = 0.0

    stripped_stdout = stdout.strip()
    if stripped_stdout.startswith("["):
        try:
            events = json.loads(stripped_stdout)
            for event in events:
                if isinstance(event, dict) and event.get("type") == "result":
                    final_text = event.get("result", "")
                    cost_usd = event.get("total_cost_usd", 0.0) or 0.0
                    break
        except json.JSONDecodeError:
            pass  # fall through to JSONL path

    if final_text is None:
        for line in stdout.splitlines():
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and event.get("type") == "result":
                final_text = event.get("result", "")
                cost_usd = event.get("total_cost_usd", 0.0) or 0.0
                break

    if final_text is None:
        raise ValueError("No 'result' event in CC output")

    payload = _parse_result_text(final_text)
    return payload, cost_usd


def _resolve_issue_type(
    finding: dict,
    user_id: int,
    run_id: Optional[int],
) -> tuple[str, Optional[str]]:
    """Route a finding through the cosine vocab gate.

    Returns ``(label, proposed_issue_type)``:
    - ``label``: the issue_type to write to the observation row (canonical
      if a match was found, else the original/proposed label).
    - ``proposed_issue_type``: the original label if the finding spawned or
      reinforced a proposal (or was alias-rewritten); ``None`` if the finding
      matched a canonical entry and no proposal trail is needed.

    Cold-start (no canonical entries yet) and below-threshold cases both
    create a 'proposed' vocab entry so the user sees the label in the
    Vocab tab on next review.
    """
    proposed = finding["issue_type"]
    proposed_new = finding.get("proposed_issue_type")
    rationale = finding.get("proposal_rationale")

    canonical = dq_vocab_repo.list_canonical(user_id)

    # Cold start: no canonical entries -- everything routes to proposal.
    if not canonical:
        label = proposed_new or proposed
        dq_vocab_repo.insert_proposal(user_id, label, rationale, run_id)
        return label, label

    # Embed observation + entity context for similarity. Lazy-load the
    # shared SBERT singleton; idempotent across calls in the same process.
    from backend.services.sbert_loader import get_sbert_model

    finding_text = (
        f"{finding['observation']} "
        f"[entity_type={finding['entity_type']}, tag={finding.get('tag', '')}]"
    )
    embedding = get_sbert_model().encode(finding_text).tolist()

    match = dq_vocab_repo.pgvector_nearest(
        user_id, embedding, threshold=COSINE_THRESHOLD
    )
    if match is not None:
        entry, _sim = match
        return entry.issue_type, None  # canonical match; nothing to propose

    # Below threshold -- proposal path.
    label_to_propose = proposed_new or proposed
    existing = dq_vocab_repo.lookup(user_id, label_to_propose)

    if existing is not None and existing.status == "rejected" and existing.aliased_to:
        # Silent rewrite to alias target; record original on observation row.
        return existing.aliased_to, label_to_propose

    # Either new (insert) or proposed/rejected-non-aliased (bump counter).
    dq_vocab_repo.insert_proposal(user_id, label_to_propose, rationale, run_id)
    return label_to_propose, label_to_propose


def _execute_finding_sql_receipt(finding: dict, user_id: int) -> dict:
    """Execute a finding's SQL receipt (if present) and return kwargs for create_observation.

    Returns an empty dict when the finding doesn't carry a sql_query (legacy
    findings or findings emitted before Phase 4 prompt updates land). When
    present, the receipt is executed at write time so contradictions surface
    on the observation row before the user opens the card.
    """
    sql = finding.get("sql_query")
    if not sql:
        return {}

    from datetime import datetime, timezone

    from backend.services.dq_sql_receipt import execute as run_sql_receipt

    result = run_sql_receipt(user_id, sql)
    return {
        "sql_query": sql,
        "sql_query_description": finding.get("sql_query_description"),
        "sql_query_executed_at": datetime.now(timezone.utc),
        "sql_query_status": result.status,
        "sql_query_n_rows": result.n_rows,
        "sql_query_error_text": result.error_text,
    }


# Required structural fields on every finding. The validator emits a
# warning (not a hard rejection) when these are missing so existing
# findings keep flowing during the Phase 4 rollout window; observability
# first, enforcement after we see how often the agent gets it right.
_REQUIRED_FINDING_FIELDS = frozenset({
    "tag",
    "issue_type",
    "entity_type",
    "entity_id",
    "observation",
    "severity",
    "evidence",
    "reasoning",
    "ambiguities",
    "sql_query",
    "sql_query_description",
})


def _validate_finding_shape(finding: dict) -> Optional[str]:
    """Return an error string if the finding is malformed, else None.

    Used by `persist_findings` to log structural violations so we can see
    how often the agent emits the Phase 4 receipt fields. Currently lenient:
    the warning surfaces in logs but the finding is still persisted (with
    JSONB columns falling back to their ``{"items":[]}`` defaults).
    """
    missing = _REQUIRED_FINDING_FIELDS - finding.keys()
    if missing:
        return f"missing fields: {sorted(missing)}"
    if finding.get("proposed_issue_type") and not finding.get("proposal_rationale"):
        return "proposed_issue_type set but proposal_rationale missing"
    evidence = finding.get("evidence")
    if not isinstance(evidence, dict) or "items" not in evidence:
        return "evidence must be an object with an items list"
    reasoning = finding.get("reasoning")
    if not isinstance(reasoning, dict) or "steps" not in reasoning:
        return "reasoning must be an object with a steps list"
    ambiguities = finding.get("ambiguities")
    if not isinstance(ambiguities, dict) or "items" not in ambiguities:
        return "ambiguities must be an object with an items list (use {\"items\": []} for none)"
    return None


def _render_vocab_block(user_id: int) -> str:
    """Render the canonical-vocab section for the agent prompt.

    The agent picks issue_type from this list when any entry semantically
    fits the finding; otherwise it sets ``proposed_issue_type`` and
    ``proposal_rationale`` so the user can canonicalize the new label
    during review.

    Guardrail (2026-07-17, executive vocab sweep): the cold-start system
    (zero rows ever canonicalized) routed 100% of findings to proposals,
    producing run-stamped and detector-stamped one-offs
    (``duplicate_of_run_41_*``, ``s2_pre_detector_false_positive*``,
    ``wikipedia_silo_persistent_recurrence``, ...) instead of a small stable
    vocabulary -- nothing told the agent to reach for a class-level label.
    Both branches below carry the same class-not-instance rules and hard
    bans so cold-start users (151/153) get them from their very first run,
    not just after canonicalization exists.
    """
    import textwrap

    canonical = dq_vocab_repo.list_canonical(user_id)
    if not canonical:
        return (
            "## CANONICAL ISSUE_TYPE VOCABULARY\n\n"
            "(empty -- this is a cold-start run)\n\n"
            "Every finding will create a vocab proposal; the user canonicalizes "
            "during review. `issue_type` names a RECURRING CLASS of "
            "data-quality problem, never a one-off instance -- a proposal is "
            "a claim that a new PERSISTENT PROBLEM CLASS exists in this "
            "corpus, not a label for this one finding. Set `issue_type` to "
            "the most descriptive snake_case CLASS label you can produce "
            "(the target vocabulary size is ~10 classes total, so think "
            "broad category, not narrow symptom). Set `proposed_issue_type` "
            "equal to that same label and explain in `proposal_rationale` "
            "what the CLASS represents (one or two sentences), not just what "
            "this one finding says.\n\n"
            "HARD BANS in `proposed_issue_type` -- reject and re-derive your "
            "label if it contains any of these: entity names or ids (page/"
            "cluster titles, domains), run numbers, detector ids (e.g. "
            "`s2_`/`s4_` prefixes), dates, `duplicate_of_*` forms, "
            "`*_nothing_found` variants (use `no_finding` instead), and "
            "recurrence/severity qualifiers like `persistent`, `systemic`, "
            "or `recurrence` -- recurrence is the dedup ledger's job, never "
            "the label's.\n\n"
        )

    lines = [
        "## CANONICAL ISSUE_TYPE VOCABULARY",
        "",
        "`issue_type` names a RECURRING CLASS of data-quality problem, never",
        "a one-off instance. Pick the closest entry below even when the fit",
        "is imperfect -- each entry's description DEFINES the boundary of",
        "its class; it is not a narrow example you must match exactly. Set",
        "`proposed_issue_type` ONLY when NO canonical entry could plausibly",
        "cover the finding -- a proposal is a claim that a new PERSISTENT",
        "PROBLEM CLASS exists in this corpus, not a label for this one",
        "finding. `proposal_rationale` must explain why no existing class",
        "fits (one or two sentences), not just restate the finding.",
        "",
        "HARD BANS in `proposed_issue_type` -- reject and re-derive your",
        "label if it contains any of these: entity names or ids (page/",
        "cluster titles, domains), run numbers, detector ids (e.g. `s2_`/",
        "`s4_` prefixes), dates, `duplicate_of_*` forms, `*_nothing_found`",
        "variants (use `no_finding` instead), and recurrence/severity",
        "qualifiers like `persistent`, `systemic`, or `recurrence` --",
        "recurrence is the dedup ledger's job, never the label's.",
        "",
        "Target vocabulary size is ~10 classes total. If your proposed",
        "label would overlap an existing entry's class boundary, do NOT",
        "propose it -- use that entry instead.",
        "",
    ]
    for entry in canonical:
        wrapped = textwrap.fill(
            entry.description or "(no description)",
            width=70,
            subsequent_indent=" " * 30,
        )
        lines.append(f"  {entry.issue_type:<28}-- {wrapped}")
    lines.append("")
    return "\n".join(lines)


class DQAgent:
    """Data-quality investigator. One instance per investigation run."""

    def __init__(self, user_id: int):
        self.user_id = user_id
        self.scope_document = _SCOPE_PATH.read_text()
        self.adjacency_document = _ADJACENCY_PATH.read_text()

    def _run_deterministic_investigations(
        self,
        investigations: list[str],
        on_event: Optional[Callable[[dict], None]] = None,
    ) -> list[dict]:
        """Dynamically import each named investigation module from
        backend.services.dq_investigations and call its run(user_id) function.
        Aggregates the findings into a single list.

        ``on_event``, when provided, receives synthetic ``_phase`` events
        (``investigator_start`` / ``investigator_done``) bracketing each
        module's run() call, so a live watcher sees progress instead of
        silence during this (often multi-minute) deterministic pass. Optional
        and defaults to None so existing direct callers/tests are unaffected.
        """
        candidates: list[dict] = []
        for name in investigations:
            if on_event is not None:
                try:
                    on_event({"type": "_phase", "subtype": "investigator_start", "name": name})
                except Exception:
                    logger.exception("[dq] on_event callback raised on investigator_start; continuing")

            module = importlib.import_module(
                f"backend.services.dq_investigations.{name}"
            )
            inv_out = module.run(user_id=self.user_id)
            # Per-investigator cap on candidate count. Addresses prompt
            # verboseness only -- one investigator with a runaway query
            # shouldn't crowd out the other four. Default 50 per investigator
            # (250 across all five) is generous; tighten via env var if needed.
            if len(inv_out) > DQ_MAX_CANDIDATES_PER_INVESTIGATOR:
                logger.info(
                    "[dq] investigator %s produced %d candidates; capping to %d",
                    name, len(inv_out), DQ_MAX_CANDIDATES_PER_INVESTIGATOR,
                )
                inv_out = inv_out[:DQ_MAX_CANDIDATES_PER_INVESTIGATOR]
            candidates.extend(inv_out)

            if on_event is not None:
                try:
                    on_event({
                        "type": "_phase",
                        "subtype": "investigator_done",
                        "name": name,
                        "candidates": len(inv_out),
                    })
                except Exception:
                    logger.exception("[dq] on_event callback raised on investigator_done; continuing")
        return candidates

    def _build_prompt(
        self,
        trigger: str,
        candidates: list[dict] | None = None,
        verdict_history: str | None = None,
        adjudication_summary: dict | None = None,
        synthesis: bool = False,
    ) -> str:
        ranking_section = ""
        rival_hypothesis_section = ""

        if synthesis:
            # Tier-2 role split (spec decision log,
            # docs/project-plans/2026-07-19-131356-dqbot-tier2-role-split/spec.md):
            # the executor already ran deterministic detection + gpt-4o-mini
            # adjudication upstream of this call. Opus's job here is
            # synthesis ONLY -- root-cause connection, fix drafting, veto,
            # and global ranking over the survivor set. The per-candidate
            # re-detection framing and the RIVAL-HYPOTHESIS CHECK (that
            # check now runs upstream, in adjudication) are deliberately
            # absent from this branch.
            candidates_section = self._render_survivors_section(
                candidates, adjudication_summary, verdict_history
            )
        else:
            candidates_section = ""
            if candidates:
                import json as _json  # local alias to avoid shadowing module-level json
                # Compact JSON (no indent) -- pure verboseness reduction with no
                # signal loss. Indented JSON roughly doubles the token count for
                # zero parsing benefit (claude handles either fine).
                candidates_section = (
                    "## PRE-DETECTED CANDIDATES\n\n"
                    "```json\n"
                    + _json.dumps(candidates, separators=(",", ":"))
                    + "\n```\n\n"
                    "The following findings have already been detected by "
                    "deterministic investigators. Your job for these is NOT to "
                    "re-detect them -- it's to (a) enrich their prose (headline, "
                    "rationale) where helpful, (b) rank them alongside anything "
                    "else you find, and (c) filter out any that look like false "
                    "positives after your own review.\n\n"
                )
            ranking_section = (
                "## RANKING AND THE SOFT CAP\n\n"
                "Produce a RANKED list of ALL findings. The server presents only the top 5 as active recommendations; ranks 6+ appear via an expander. Rank by (1) severity (critical > warning > info), (2) concreteness of proposed fix, (3) staleness of underlying evidence (fresher = higher). Investigate exhaustively. Rank honestly. Do not self-truncate at 5.\n\n"
            )
            rival_hypothesis_section = (
                "## RIVAL-HYPOTHESIS CHECK (structural investigations only -- S2, S4)\n\n"
                "Before flagging incoherence, predict the expected source/domain mix given ONLY the label. Compare to reality. If your own prediction matches the observed spread, SUPPRESS -- heterogeneity is intentional.\n\n"
            )

        vocab_block = _render_vocab_block(self.user_id)

        return f"""You are dqBot, a data-quality investigator for user_id={self.user_id}'s personal knowledge compendium.

You are running inside Claude Code as a non-interactive invocation (`claude -p`). You have CC's standard tool surface available (Bash, Read, Grep, Glob, Task, WebFetch, etc.). Use `Bash` with `psql` against `$DATABASE_URL` to query the Postgres database. You are READ-ONLY by discipline: do not modify any user-owned tables. Your findings are returned to the Python orchestrator that invoked you; IT persists them via the repo layer. You never write to the DB directly.

Your job is defined by TWO documents. Reason against them explicitly -- cite items by ID in every finding.

## SCOPE DOCUMENT (what you INVESTIGATE as `core`)

{self.scope_document}

## ADJACENCY CONTRACT (what you may package as handoff prompts)

{self.adjacency_document}

{vocab_block}{candidates_section}## OUTPUT CONTRACT

Every finding is tagged as one of:
- `core` -- fits a scope item. MUST include `scope_citation` naming the item (e.g. "S1").
- `adjacent` -- DQ-adjacent but outside scope. MUST include `adjacency_contract_ref` (e.g. "A1") if drafting a handoff prompt. Without a valid citation, omit the handoff_prompt_draft.
- `off_topic` -- unrelated. Include briefly; server drops these.

Any finding that cannot cite a scope item or adjacency section is NOT `core`. You do not stretch scope items to fit.

If a finding fits BOTH a `core` scope item AND an `adjacency` section, file as `core`. Overlap resolves toward core.

## STRUCTURED RECEIPT FIELDS (required on every finding)

Every finding must include four structured fields that surface your reasoning trail to the user. The user reviews these in a "Receipt" pane next to each card; missing or empty fields make the agent's claim look unsupported.

- `evidence`: `{{"items": [...]}}`. Each item cites a concrete artefact behind the claim. Examples: `{{"type": "page", "id": 42, "label": "..."}}`, `{{"type": "metric", "name": "skip_pct", "value": 0.62, "threshold": 0.5}}`, `{{"type": "comparison", "current_count": 47, "baseline_count": 12}}`, `{{"type": "cluster", "id": 7, "stable_id": "...", "label": "Quantum Computing"}}` (the per-run integer cluster id + current display name -- see ENTITY REFERENCES below for why `entity_id` itself is NOT this integer). Empty `[]` is allowed only when the claim genuinely has no concrete artefact.

- `reasoning`: `{{"steps": [...]}}`. Each step is `{{"rule": "...", "applied": "...", "result": "..."}}`. Show how you got from the evidence to the claim. Empty `[]` only for trivial claims where the rule is the claim itself.

- `ambiguities`: `{{"items": [...]}}`. Each item: `{{"question": "...", "impact": "...", "needs_user_input": bool}}`. What you cannot resolve without the user's intent or domain knowledge. Empty `{{"items": []}}` is a deliberate "no ambiguity" claim, NOT a missing field -- always include the key, even if empty.

- `sql_query` + `sql_query_description`: a single SELECT statement (no CTEs, no DML, max LIMIT 100) that returns the rows behind your claim, plus a one-line plain-language description. The orchestrator runs this at write time as `dq_bot_readonly` (SELECT-only on the dq tables) and captures the result on the observation row. If the query returns 0 rows when you predicted otherwise, your claim is contradicted before the user sees the card.

{ranking_section}## SELF-CLASSIFICATION

Each recommendation: `trivial` (mechanical, single-entity, low-reversal-cost), `judgment` (needs a user call), or `risky` (multi-entity, hard-to-reverse).

{rival_hypothesis_section}## WHAT YOU MAY NEVER DO

- Propose the same issue across runs without new evidence (check `dq_observations` + `annotations` history before flagging).
- Write handoff prompts without a valid adjacency contract citation.
- Produce more than 3 new handoff prompts per run.
- Invent scope items not in the scope document.
- Modify any user-owned table (your findings are returned for the orchestrator to persist).

## OUTLIER SIGNALS (optional, on recommendations only)

When you produce multiple recommendations of the same action_type, consider which
of them are unusual RELATIVE TO THEIR SIBLINGS and annotate those with outlier
signals. These become callouts in the user's batch-approve preview so they can
see at a glance which recs need individual review.

Each signal is a short string describing one specific reason this rec stands
out. Examples by action_type:

- dedupe: "70 duplicates (median 4)", "all placeholder summaries", "spans 3 months"
- split_cluster: "23 pages (median 5)", "arxiv-heavy (78% single domain)", "spans 7 domains"
- merge_clusters: "overlaps 2 other clusters >50%", "member SBERT variance 0.8"
- relabel_cluster: "label contradicts 4 of 5 top tokens", "current label is generic 'Cluster N'"
- edit_prompt: "affects skip-gate decisions on 200+ pages", "prompt version is v1a (legacy)"

Emit outlier_signals ONLY for recs that are genuinely outliers among their
siblings. Do NOT emit signals for every rec -- they're for batch-approve peel-out,
not general decoration. Risky-classified recs are always peeled regardless of
signals; signals help non-risky recs whose size/shape warrants extra scrutiny.

Format:
  "outlier_signals": {{"labels": ["...", "..."]}}  | null

Keep labels short (under 50 chars each). Aim for 1-3 labels per outlier rec.
Omit the field entirely when not applicable.

## ENTITY REFERENCES AND ACTION PAYLOADS

Cluster ids are per-recluster-run integers -- they die every recluster. `clusters.stable_id` (a UUID string, carried forward across reclusters by Jaccard match on membership when cluster identity is enabled) is the durable handle.

- For `entity_type: "cluster"` findings, `entity_id` and `recommendation.affected_entity_ids` MUST be the cluster's `stable_id` string, NEVER the integer cluster id. Any pre-detected candidates supplied above already carry the correct `entity_id` (stable_id, or the stringified integer id with an `{{"identity": "missing"}}` action_payload flag when stable_id is NULL) -- when enriching one, PRESERVE its `entity_id` and `affected_entity_ids` as given; do not invent or substitute an integer id. When you discover a cluster finding yourself (not from a pre-detected candidate), query `clusters.stable_id` for that cluster via `psql` and use it the same way; if it is NULL, fall back to the stringified integer cluster id.
- The integer cluster id and current display name still matter for readability -- put them in `evidence` (see the `"type": "cluster"` example above), not in `entity_id`.
- `entity_type: "global"` findings (e.g. the domain-silo aggregation case, or dedup's single per-run finding) are unaffected -- they are not single cluster entities, so this rule does not apply to their `entity_id`/`affected_entity_ids`.

`recommendation.action_payload` carries machine-actionable instructions for the approve-applies path (spec S4). Shape depends on `action_type`; omit the key (or set it `null`) when you cannot derive it -- an unresolvable/missing payload degrades to a record-only approve, never an error, so it is always safe to omit rather than guess:

- `relabel_cluster`: `{{"stable_id": "...", "proposed_label": "..."}}` -- `proposed_label` is REQUIRED whenever you emit `action_type: "relabel_cluster"`; a relabel recommendation without one is not actionable. Pre-detected candidates give you `stable_id` only (labels are your judgment call to add).
- `split_cluster`: `{{"stable_id": "...", "remove_page_content_ids": [...], "page_ids": [...]}}` -- the page lists are optional (pre-detectors often omit them; add them only when you can name the specific pages that don't belong).
- `merge_clusters`: `{{"stable_ids": ["...", "..."]}}`.
- `dedupe`: `{{"groups": [{{"keep_page_id": ..., "archive_page_ids": [...]}}, ...]}}`.
- Everything else (`flag_for_review`, `edit_prompt`, `relabel_supercluster`): action_payload is not applicable -- omit it (these action types are always record-only, regardless of payload).

## RETURN FORMAT

Trigger: {trigger}

Return a SINGLE JSON object matching this schema:

{{
  "findings": [
    {{
      "tag": "core" | "adjacent" | "off_topic",
      "scope_citation": "S1" | null,
      "adjacency_contract_ref": "A1" | null,
      "issue_type": "<pick from canonical vocab above; see proposed_issue_type when none fits>",
      "proposed_issue_type": "<snake_case CLASS label, set ONLY when no canonical fits, else null -- NEVER an entity/run/detector id, date, duplicate_of_*, *_nothing_found, or persistent/systemic/recurrence qualifier>",
      "proposal_rationale": "<one or two sentences, REQUIRED when proposed_issue_type is set, else null>",
      "entity_type": "global" | "cluster" | "page" | "supercluster" | "domain" | "capture",
      "entity_id": "skip_gate_prompt" | 42 | "3fa85f64-5717-4562-b3fc-2c963f66afa6" (stable_id string -- REQUIRED for entity_type=cluster, see ENTITY REFERENCES above) | ...,
      "observation": "short plain-language summary",
      "severity": "info" | "warning" | "critical",
      "rank": 1,
      "evidence": {{"items": [...]}},
      "reasoning": {{"steps": [...]}},
      "ambiguities": {{"items": [...]}},
      "sql_query": "SELECT ... FROM <allowlisted table> ... LIMIT 100",
      "sql_query_description": "one-line plain-language description of what the SELECT returns",
      "recommendation": {{
        "headline": "one-sentence call to action",
        "rationale": "short explanation",
        "self_classification": "trivial" | "judgment" | "risky",
        "action_type": "edit_prompt" | "split_cluster" | "merge_clusters" | "relabel_cluster" | "relabel_supercluster" | "dedupe" | "flag_for_review",
        "affected_entity_ids": [...],
        "action_payload": {{"stable_id": "...", "proposed_label": "..."}} | null,
        "outlier_signals": {{"labels": ["string", ...]}} | null
      }} | null,
      "handoff_prompt_draft": "full prompt text for an external CC session" | null
    }},
    ...
  ]
}}

`evidence`, `reasoning`, `ambiguities`, `sql_query`, and `sql_query_description` are REQUIRED on every finding (see STRUCTURED RECEIPT FIELDS above). Return ONLY the JSON object. Do not wrap in markdown code fences. Do not include prose before or after.
"""

    # ------------------------------------------------------------------
    # Synthesis-mode prompt section (Tier-2 role split)
    # ------------------------------------------------------------------

    @staticmethod
    def _render_adjudication_summary_block(adjudication_summary: dict | None) -> str:
        """Render the adjudication_summary dict as a readable block, not raw repr.

        Shape (see dq_adjudicator.adjudicate's "stats" + Task 8's merged
        "suppressed_samples" list): {"judged": int, "passed_through": int,
        "suppressed": int, "skipped_batches": int, "suppressed_samples":
        [str, ...]}. Missing keys default to 0 / empty so a partial or
        absent summary never crashes prompt construction.
        """
        summary = adjudication_summary or {}
        lines = [
            f"- judged: {summary.get('judged', 0)}",
            f"- passed_through: {summary.get('passed_through', 0)}",
            f"- suppressed: {summary.get('suppressed', 0)}",
            f"- skipped_batches: {summary.get('skipped_batches', 0)}",
        ]
        samples = summary.get("suppressed_samples") or []
        if samples:
            lines.append("- suppressed_samples (sampled suppress reasons):")
            lines.extend(f'  - "{sample}"' for sample in samples)
        return "\n".join(lines)

    def _render_survivors_section(
        self,
        candidates: list[dict] | None,
        adjudication_summary: dict | None,
        verdict_history: str | None,
    ) -> str:
        """Build the synthesis-mode replacement for PRE-DETECTED CANDIDATES +
        RANKING AND THE SOFT CAP + RIVAL-HYPOTHESIS CHECK (spec Task 7):
        ADJUDICATED SURVIVORS, ADJUDICATION SUMMARY, and YOUR ROLE: SYNTHESIS
        ONLY (which folds in the global-ranking instruction and the verdict
        history block verbatim).
        """
        import json as _json  # local alias to avoid shadowing module-level json

        survivors = candidates or []
        summary_block = self._render_adjudication_summary_block(adjudication_summary)
        history_block = verdict_history or "(no verdict history provided)"

        return (
            "## ADJUDICATED SURVIVORS\n\n"
            "```json\n"
            + _json.dumps(survivors, separators=(",", ":"))
            + "\n```\n\n"
            "These candidates were pre-detected deterministically and CONFIRMED by an upstream adjudication pass (its verdict + reason ride on each). Your job is NOT re-detection or re-scoring. For each survivor: keep it (enrich prose only if genuinely helpful) or VETO it with a one-line reason in a \"vetoed\": [{\"entity_id\", \"reason\"}] top-level key. You may NOT add back anything the adjudicator suppressed (summary below is context, not a menu).\n\n"
            "## ADJUDICATION SUMMARY\n\n"
            f"{summary_block}\n\n"
            "If the suppression pattern itself looks pathological (e.g. a detector's candidates suppressed wholesale for the Nth run), file a detector_calibration finding about the DETECTOR.\n\n"
            "## YOUR ROLE: SYNTHESIS ONLY\n\n"
            "(a) Root-cause synthesis: connect surviving symptoms + history to systemic causes; file systemic/global findings with concrete evidence.\n"
            "(b) Fix drafting: edit_prompt recommendations and (within the adjacency contract) handoff drafts.\n"
            "(c) Global ranking: one ranked list across survivors + your own findings (severity, concreteness, freshness).\n\n"
            f"{history_block}\n\n"
        )

    # ------------------------------------------------------------------
    # Single-pass subprocess helper
    # ------------------------------------------------------------------

    def _run_single_pass(
        self,
        cmd: list[str],
        prompt: str,
        on_event: Optional[Callable[[dict], None]],
        on_subprocess_start: Optional[Callable[["subprocess.Popen"], None]] = None,
    ) -> dict:
        """Launch ONE claude -p subprocess and stream JSONL events.

        `on_subprocess_start(proc)` is invoked once the Popen handle exists.
        Orchestrators use it to register the proc for external control (abort).

        Returns a dict with keys:
          returncode, duration_s, findings, total_cost_usd, saw_result, error
        """
        saw_result = False
        findings: list[dict] = []
        vetoed: list[dict] = []
        cost_usd = 0.0
        stderr_buf: list[str] = []
        stderr_text = ""
        error: Optional[str] = None

        logger.info(
            "[dq-subprocess] launching prompt_bytes=%d allowed_tools=%s",
            len(prompt), DQ_ALLOWED_TOOLS,
        )
        t0 = time.monotonic()

        try:
            proc = subprocess.Popen(
                cmd,
                stdin=PIPE,
                stdout=PIPE,
                stderr=PIPE,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            dt = time.monotonic() - t0
            logger.error("[dq-subprocess] failed to launch: %s", exc)
            return {
                "returncode": -1,
                "duration_s": dt,
                "findings": [],
                "vetoed": [],
                "total_cost_usd": 0.0,
                "saw_result": False,
                "error": f"subprocess launch failed: {exc}",
            }

        if on_subprocess_start is not None:
            try:
                on_subprocess_start(proc)
            except Exception:
                logger.exception("[dq-subprocess] on_subprocess_start callback raised; continuing")

        # Hard deadline watchdog. DQ_SUBPROCESS_TIMEOUT_SEC was defined but never
        # enforced: the readline loop below blocks forever on a child that hangs
        # with stdout open/idle (the only post-loop wait fires AFTER stdout
        # closes). A child that never closes stdout therefore stalls the run in
        # 'running' indefinitely (confirmed root cause of historical DQ hangs).
        # The Timer kills the proc at the deadline; the kill makes readline hit
        # EOF, the loop exits, and the no-result + non-zero-returncode path below
        # marks the pass failed. `timed_out` lets us attach a clear error string.
        timed_out = threading.Event()

        def _kill_on_timeout() -> None:
            timed_out.set()
            logger.warning(
                "[dq-subprocess] watchdog: timeout after %ds; killing subprocess",
                DQ_SUBPROCESS_TIMEOUT_SEC,
            )
            proc.kill()

        watchdog = threading.Timer(DQ_SUBPROCESS_TIMEOUT_SEC, _kill_on_timeout)
        watchdog.daemon = True
        watchdog.start()

        try:
            # Pipe the prompt via stdin instead of argv. Linux's MAX_ARG_STRLEN caps
            # any single argv string at PAGE_SIZE*32 = 128 KB; the prompt grew past
            # that as the user's data corpus + multi-investigator output expanded
            # (~967 KB by 2026-04-26 once router default wired all five investigators
            # via 187180a), so argv-passing fails with E2BIG before claude even
            # starts. stdin has no kernel-imposed size limit.
            if proc.stdin is not None:
                try:
                    proc.stdin.write(prompt)
                    proc.stdin.close()
                except BrokenPipeError as exc:
                    logger.error("[dq-subprocess] stdin write failed (claude exited early?): %s", exc)

            # Stream stdout line-by-line
            for line in iter(proc.stdout.readline, ""):
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning("[dq-subprocess] malformed JSONL line: %r", line[:200])
                    continue

                if on_event is not None:
                    try:
                        on_event(event)
                    except Exception:
                        logger.exception("[dq-subprocess] on_event callback raised; continuing")

                if event.get("type") == "result":
                    saw_result = True
                    cost_usd = event.get("total_cost_usd", 0.0) or 0.0
                    result_text = event.get("result", "")
                    if event.get("is_error"):
                        error = f"CC result event has is_error=true: {result_text[:500]}"
                        saw_result = False  # treat is_error result as failure
                    else:
                        try:
                            payload = _parse_result_text(result_text)
                            findings = payload.get("findings", [])
                            vetoed = payload.get("vetoed", [])
                        except (ValueError, json.JSONDecodeError) as exc:
                            error = str(exc)
                            saw_result = False

            # Drain stderr (non-blocking after stdout closes)
            stderr_text = ""
            try:
                stderr_text = proc.stderr.read()
            except Exception:
                pass
            if stderr_text.strip():
                stderr_buf.append(stderr_text.strip())

            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                logger.warning("[dq-subprocess] proc.wait timed out after stdout closed; killing")
                proc.kill()
                proc.wait()
        finally:
            watchdog.cancel()

        dt = time.monotonic() - t0
        returncode = proc.returncode

        logger.info(
            "[dq-subprocess] exit=%d duration=%.1fs saw_result=%s stderr_bytes=%d",
            returncode, dt, saw_result, len(stderr_text),
        )

        if not saw_result and error is None:
            stderr_summary = "".join(stderr_buf)[:2000]
            if timed_out.is_set():
                # Watchdog killed the child at the deadline. Report it plainly so
                # it is not misread as a transient fast-fail (which keys on the
                # 'empty-stderr' marker and a sub-60s duration).
                error = (
                    f"timeout after {DQ_SUBPROCESS_TIMEOUT_SEC}s "
                    f"(watchdog killed subprocess; returncode={returncode})"
                )
            elif returncode != 0:
                if stderr_summary:
                    error = stderr_summary
                else:
                    error = (
                        f"claude -p exit={returncode} duration={dt:.1f}s "
                        "empty-stderr (likely transient CC failure)"
                    )
            else:
                # returncode==0 but no result event -- parse failure upstream
                error = "claude -p exited 0 but no result event was emitted"

        return {
            "returncode": returncode,
            "duration_s": dt,
            "findings": findings,
            "vetoed": vetoed,
            "total_cost_usd": cost_usd,
            "saw_result": saw_result,
            "error": error,
        }

    # ------------------------------------------------------------------
    # Retry classifier
    # ------------------------------------------------------------------

    @staticmethod
    def _is_transient_fast_fail(attempt: dict) -> bool:
        """True when the attempt looks like a transient CC flake worth retrying.

        Criteria: no result event, non-zero exit, finished within 60s,
        and stderr was empty (a real error almost always has stderr).
        """
        if attempt["saw_result"]:
            return False
        if attempt["returncode"] == 0:
            return False
        if attempt["duration_s"] >= 60:
            return False
        # Distinguish real-error from transient by checking whether the error
        # message contains stderr content. Transient error message looks like:
        #   "claude -p exit=N duration=X.Xs empty-stderr ..."
        error_msg = attempt.get("error") or ""
        return "empty-stderr" in error_msg

    # ------------------------------------------------------------------
    # Finalize helpers
    # ------------------------------------------------------------------

    def _finalize(self, attempt: dict, trigger: str, synthesis: bool = False) -> dict:
        """Convert a successful attempt dict to the public investigate() return shape.

        `synthesis` gates the "vetoed" key: the legacy monolithic path never
        emits vetoes (there's nothing upstream for it to veto), so it's
        omitted from the legacy return shape entirely -- only synthesis-mode
        calls (Task 8's executor) get the passthrough the veto contract needs.
        """
        logger.info(
            "[dq-subprocess] SUCCESS findings=%d cost_usd=$%.4f duration=%.1fs",
            len(attempt["findings"]), attempt["total_cost_usd"], attempt["duration_s"],
        )
        result = {
            "trigger": trigger,
            "findings": attempt["findings"],
            "total_cost_usd": attempt["total_cost_usd"],
        }
        if synthesis:
            result["vetoed"] = attempt.get("vetoed", [])
        return result

    def _finalize_as_failure(self, attempt: dict, trigger: str, reason: str) -> dict:
        """Convert a failed attempt to the public investigate() return shape with error set."""
        logger.error(
            "[dq-subprocess] FAILURE duration=%.1fs reason=%r",
            attempt["duration_s"], reason[:500],
        )
        return {
            "trigger": trigger,
            "findings": [],
            "total_cost_usd": attempt.get("total_cost_usd", 0.0),
            "error": reason or "unknown failure (no detail available)",
        }

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def investigate(
        self,
        trigger: str = "manual",
        model: Optional[str] = None,
        investigations: Optional[list[str]] = None,
        on_event: Optional[Callable[[dict], None]] = None,
        on_subprocess_start: Optional[Callable[["subprocess.Popen"], None]] = None,
        *,
        candidates: Optional[list[dict]] = None,
        verdict_history: Optional[str] = None,
        adjudication_summary: Optional[dict] = None,
    ) -> dict:
        """Invoke CC via subprocess with stream-json output.

        Streams events through on_event callback as they arrive. Returns
        findings + cost telemetry when done. Handles one automatic retry for
        transient fast-fail pattern (non-zero exit <60s empty-stderr).

        Two mutually-exclusive modes (Tier-2 role split, spec Task 7):

        - Synthesis mode: caller (Task 8's executor) passes `candidates`
          explicitly -- already deterministically detected AND adjudicated
          upstream. The deterministic pass is SKIPPED here (it already ran),
          and the prompt is built in synthesis mode with `verdict_history`
          and `adjudication_summary` embedded. The return dict includes a
          `"vetoed"` key so the executor can honor Opus's vetoes.
        - Legacy mode (`DQ_RUN_MODE=legacy`, or any caller that omits
          `candidates`): unchanged monolithic behavior, byte-for-byte --
          `investigations=[...]` runs the deterministic pass internally and
          feeds its output into the legacy PRE-DETECTED CANDIDATES prompt.
          No `"vetoed"` key on the return (there's nothing upstream for
          Opus to veto in this mode).

        The orchestrator persists findings via the repo modules; this method
        does no DB writes of its own.
        """
        synthesis = candidates is not None
        if synthesis:
            prompt = self._build_prompt(
                trigger,
                candidates=candidates,
                verdict_history=verdict_history,
                adjudication_summary=adjudication_summary,
                synthesis=True,
            )
        else:
            legacy_candidates = (
                self._run_deterministic_investigations(investigations, on_event=on_event)
                if investigations
                else None
            )
            prompt = self._build_prompt(trigger, candidates=legacy_candidates)

        cmd = [
            DQ_CLAUDE_CMD, "-p",
            "--output-format", "stream-json",
            "--verbose",
            "--allowedTools", DQ_ALLOWED_TOOLS,
        ]
        # Default to DQ_CLAUDE_MODEL (the `opus[1m]` alias+selector, or the
        # pinned legacy fallback) when the caller passes nothing, so the
        # prompt fits in the model's context window. Caller can override
        # for testing / specific runs.
        effective_model = model or DQ_CLAUDE_MODEL
        if effective_model:
            cmd += ["--model", effective_model]
        # prompt is now piped via stdin (see _run_single_pass) -- no longer argv.

        if on_event is not None:
            try:
                on_event({"type": "_phase", "subtype": "agent_starting", "prompt_bytes": len(prompt)})
            except Exception:
                logger.exception("[dq-subprocess] on_event callback raised on agent_starting phase event; continuing")

        attempt_1 = self._run_single_pass(cmd, prompt, on_event, on_subprocess_start)

        if attempt_1["saw_result"]:
            return self._finalize(attempt_1, trigger, synthesis=synthesis)

        if self._is_transient_fast_fail(attempt_1):
            logger.warning(
                "[dq-subprocess] attempt 1 transient fast-fail (exit=%d duration=%.1fs); retrying once",
                attempt_1["returncode"], attempt_1["duration_s"],
            )
            if on_event is not None:
                try:
                    on_event({
                        "type": "_retry",
                        "subtype": "starting",
                        "attempt": 2,
                        "reason": "transient fast-fail on attempt 1",
                    })
                except Exception:
                    logger.exception("[dq-subprocess] on_event callback raised on _retry event; continuing")

            attempt_2 = self._run_single_pass(cmd, prompt, on_event, on_subprocess_start)
            if attempt_2["saw_result"]:
                return self._finalize(attempt_2, trigger, synthesis=synthesis)
            return self._finalize_as_failure(
                attempt_2,
                trigger,
                f"attempt 1 + attempt 2 both failed; last: {attempt_2['error']}",
            )

        return self._finalize_as_failure(attempt_1, trigger, attempt_1["error"] or "unknown failure")

    def persist_findings(
        self,
        user_id: int,
        run_id: int,
        findings: list[dict],
    ) -> dict:
        """Persist agent findings via the repo layer.

        For each finding:
        - Resolve the issue_type via the vocab gate (cosine-similarity match
          against canonical entries, with proposal/alias fallbacks). The
          resolved label is what feeds the dedup ledger and observation row;
          the original (pre-gate) label is captured in `proposed_issue_type`
          when the finding spawned a proposal.
        - Skip if `has_observation(user_id, entity_type, entity_id, issue_type)`
          returns True -- pending-only dedup ledger (spec S2): this blocks a
          refile only while a PRIOR recommendation on the same entity+issue
          is still `pending`. Resolved history does not suppress re-detection.
        - Otherwise create the observation unconditionally, and, if the
          finding carries a `recommendation` sub-dict: look up the newest
          prior recommendation for this entity+issue via
          `dq_observations_repo.newest_rec_for_entity_issue`. If one exists
          (necessarily resolved, since has_observation would have blocked a
          pending one), the new recommendation SUPERSEDES it via
          `dq_recommendations_repo.supersede` instead of starting an
          orphaned chain -- this is what makes recur%/trend calibration real.
          Otherwise create a fresh recommendation as before. `action_payload`
          (spec S4, machine-actionable apply instructions) is passed through
          from `finding["recommendation"].get("action_payload")` either way.

        Returns `{"observations_written": int, "recommendations_written": int}`.
        """
        observations_written = 0
        recommendations_written = 0

        for finding in findings:
            shape_error = _validate_finding_shape(finding)
            if shape_error is not None:
                # Lenient during the Phase 4 rollout: log + persist anyway,
                # so we observe how often the agent omits structured fields
                # before deciding whether to drop or retry on violations.
                logger.warning(
                    "finding shape violation (persisting anyway): %s -- finding=%s",
                    shape_error,
                    {k: finding.get(k) for k in ("issue_type", "entity_type", "entity_id")},
                )

            entity_type = finding["entity_type"]
            entity_id = str(finding["entity_id"])
            issue_type, proposed_issue_type = _resolve_issue_type(
                finding, user_id, run_id
            )

            if dq_observations_repo.has_observation(
                user_id=user_id,
                entity_type=entity_type,
                entity_id=entity_id,
                issue_type=issue_type,
            ):
                logger.info(
                    "dedup: skipping %s/%s/%s (already observed)",
                    entity_type, entity_id, issue_type,
                )
                continue

            sql_kwargs = _execute_finding_sql_receipt(finding, user_id)

            obs = dq_observations_repo.create_observation(
                user_id=user_id,
                run_id=run_id,
                tag=finding["tag"],
                entity_type=entity_type,
                entity_id=entity_id,
                issue_type=issue_type,
                observation=finding["observation"],
                severity=finding.get("severity", "info"),
                scope_citation=finding.get("scope_citation"),
                adjacency_contract_ref=finding.get("adjacency_contract_ref"),
                handoff_prompt_draft=finding.get("handoff_prompt_draft"),
                evidence=finding.get("evidence"),
                reasoning=finding.get("reasoning"),
                ambiguities=finding.get("ambiguities"),
                proposed_issue_type=proposed_issue_type,
                **sql_kwargs,
            )
            observations_written += 1

            rec_data = finding.get("recommendation")
            if rec_data:
                action_payload = rec_data.get("action_payload")
                # Refile/supersede path (spec S2): has_observation is
                # pending-only now, so reaching here can mean either a
                # brand-new entity+issue OR a regression whose prior
                # recommendation already resolved (approved/rejected/
                # dismissed/snoozed/superseded). newest_rec_for_entity_issue
                # finds that prior rec (if any); when present, the new rec
                # supersedes it instead of starting an orphaned chain, so
                # trends/recur% reflect the re-detection. The observation
                # row above is written unconditionally either way.
                prior_rec = dq_observations_repo.newest_rec_for_entity_issue(
                    user_id=user_id,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    issue_type=issue_type,
                )
                if prior_rec is not None:
                    dq_recommendations_repo.supersede(
                        old_rec_id=prior_rec["id"],
                        new_payload={
                            "user_id": user_id,
                            "run_id": run_id,
                            "observation_id": obs["id"],
                            "action_type": rec_data["action_type"],
                            "headline": rec_data["headline"],
                            "rationale": rec_data["rationale"],
                            "self_classification": rec_data["self_classification"],
                            "rank_in_run": finding.get("rank", 0),
                            "affected_entity_type": entity_type,
                            "affected_entity_ids": rec_data["affected_entity_ids"],
                            "outlier_signals": rec_data.get("outlier_signals"),
                            "action_payload": action_payload,
                        },
                    )
                else:
                    dq_recommendations_repo.create_recommendation(
                        user_id=user_id,
                        run_id=run_id,
                        observation_id=obs["id"],
                        action_type=rec_data["action_type"],
                        headline=rec_data["headline"],
                        rationale=rec_data["rationale"],
                        self_classification=rec_data["self_classification"],
                        rank_in_run=finding.get("rank", 0),
                        affected_entity_type=entity_type,
                        affected_entity_ids=rec_data["affected_entity_ids"],
                        outlier_signals=rec_data.get("outlier_signals"),
                        action_payload=action_payload,
                    )
                recommendations_written += 1

        return {
            "observations_written": observations_written,
            "recommendations_written": recommendations_written,
        }
