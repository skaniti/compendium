# dqBot — Adjacency Contract

This document enumerates the **categories of DQ-adjacent observation**
that dqBot is allowed to package as handoff prompts for an external Claude
Code session. Observations matching a category here get a
`handoff_prompt_draft` populated; observations in other adjacent territory
get written to the Observations journal but without a draft prompt.

This document is authoritative for handoff-prompt generation. dqBot reads
it every run. It is modified only by the user (or by chat-mode Claude
under the user's direction); dqBot itself NEVER writes to or suggests
edits to this file at runtime.

Categories are tight by design — scope expansion happens via a user-triggered
role review (no fixed calendar), not by accretion in response to interesting
one-off observations.

Each category lists **example sub-observations** — illustrative, not
exhaustive. dqBot uses its judgment within the category boundary; if a
particular adjacent observation fits the category's intent, it qualifies
even if not explicitly listed. If dqBot is unsure whether something fits,
the default is "write as plain `adjacent` without a handoff prompt" —
handoff-prompt generation is the privileged case.

---

## A1 — Annotation UX improvements

**Priority:** high

**Scope:** Observations about annotation/review-UX friction that plausibly
suppresses label throughput.

**Example sub-observations:**
- Textarea blur events not firing consistently across card refreshes
- Preset-chip management friction that makes users stop using presets
- Keyboard-shortcut gaps that force mouse interaction mid-flow
- Batch-commit UX that doesn't make the "staged but not committed" state
  visually distinct

**NOT in scope:** cosmetic tweaks without a behavioral-throughput
hypothesis. If dqBot can't name "this friction plausibly reduces labelling
rate via mechanism X," it's cosmetic, not DQ-adjacent.

**Handoff prompt framing hint:**
> "The following is a UX observation from dqBot about annotation flow in
> the dev-suite Archive Health view. It references specific user behavior
> patterns observed in the annotations table. Please investigate the
> callback flow at `frontend/dash/callbacks/archive_health.py` and propose
> a fix that preserves the existing single-key triage + staged-label
> model."

## A2 — Fetcher coverage and text-cleanup gaps

**Priority:** medium

**Scope:** Observations that a particular domain or content-type is
systematically producing degraded `extracted_text` or `skip_reasoning`
outputs — the data symptom is DQ-shaped but the resolution requires
engineering judgment on the fetcher adapter rather than a bounded edit.
Per `memory/feedback_domain_processing_in_fetchers.md`, per-domain text
cleanup lives in fetchers only.

**Example sub-observations:**
- A domain yielding <N chars in >K% of extractions over the last M days
- Boilerplate patterns (e.g. consent dialogs, navigation chrome) that
  survive extraction and pollute summaries
- Domain-wide character-encoding or language-detection failures
- Content-type patterns (e.g. video transcripts, PDFs) a fetcher handles
  poorly

**NOT in scope:** individual-page fetcher glitches (one-off pages that
failed to extract). This category is for domain-wide or pattern-wide
issues.

**Note on why this is adjacency, not core:** the *observation* could be
motivated by a core DQ investigation (if an S6 were added to the scope
document), but the *resolution* is an engineering pass on fetcher code
rather than a bounded data/prompt edit. Promotion to core (adding S6) is a
legitimate role-review decision.

**Handoff prompt framing hint:**
> "The following is a systematic fetcher-output observation from dqBot.
> It identifies a domain or content-pattern whose extracted_text quality
> is degrading downstream summarization / clustering. See the existing
> fetcher adapters under `backend/services/fetchers/` and propose either
> a tweak to an existing adapter or a new one. Preserve the contract that
> fetcher consumers read standardized clean prose — never duplicate
> domain knowledge outside the fetcher layer."

## A3 — Clustering hyperparameter drift

**Priority:** medium

**Scope:** Observations that the current HDBSCAN + SBERT clustering
pipeline's hyperparameters (`min_cluster_size`, `min_samples`, SBERT model
choice, supercluster naming model/prompt) are producing systematically
degraded outputs as the corpus grows.

**Example sub-observations:**
- Unclustered-outlier fraction drifting upward across recent recluster runs
- Cluster-size distribution converging (everything becoming size-N)
- Supercluster labels failing rival-hypothesis-guard checks at elevated
  rates (suggesting the naming prompt or model is mis-tuned)
- New-content additions consistently failing to be placed in existing
  clusters (suggesting min_samples too strict)

Distinct from S2/S3/S4 which flag *individual* cluster/supercluster
problems: this category flags the *settings that produce the problems*.

**NOT in scope:** proposing entirely new clustering algorithms or
abandoning HDBSCAN/SBERT. That's a research-scope decision, not a tuning
one.

**Handoff prompt framing hint:**
> "The following is a clustering-hyperparameter observation from dqBot
> about the HDBSCAN + SBERT pipeline at `<path>`. It names specific
> parameters that appear mis-tuned for the current corpus size/shape.
> Please investigate and propose either a parameter adjustment or an
> evaluation scaffold to test alternatives. Preserve the existing cluster
> → supercluster → narrative pipeline shape — this is tuning, not
> redesign."

## A4 — Browser extension maturity

**Priority:** medium

**Scope:** Observations about the passive-capture browser extension's
health, maturity, and readiness to move out of dev-mode sideloading.

**Example sub-observations:**
- Silent failures in MV3 service worker lifecycle (captures lost because
  the worker was idle-killed)
- Edge-specific friction from its sideload-warning dialogues that increase
  user-abandonment risk
- Capture-schema drift between extension output and backend `captures`
  table expectations
- Heartbeat / reliability gaps where the extension appears alive but isn't
  recording

**NOT in scope:** adding net-new features to the extension (that's a
product decision, not a DQ-adjacent fix).

**Handoff prompt framing hint:**
> "The following is a browser-extension health observation from dqBot. It
> references specific symptoms in the capture pipeline originating from
> the extension at `extension/`. Please investigate the MV3 service-worker
> flow and propose fixes that move the extension closer to a
> publish-ready state (out of dev-sideload). Preserve the unified
> passive+active capture model."

## A5 — Compendium app polish as a daily-use browser experience

**Priority:** medium

**Scope:** Observations about the Dash app's readiness to serve as a
daily-use browsing experience (potentially replacing Chrome/Edge for
users' curiosity-driven sessions), as distinct from its dev-tool role.

**Example sub-observations:**
- Navigation / bookmark parity gaps relative to Chrome/Edge
- Multi-session ergonomics (switching between concurrent browsing tasks)
- Cross-session state persistence friction
- Missing "I'm in a rabbit hole right now" affordances (visual cues,
  quick-capture shortcuts)

**NOT in scope:** the dev-suite views themselves (those are solo-dev
tools, not user-facing). Those go to the Archive Health IA observation
stream, which falls under Annotation UX (A1) or a future Dev Suite IA
category if added.

**Handoff prompt framing hint:**
> "The following is a user-facing-app observation from dqBot about the
> Dash graph view and surrounding navigation at `frontend/dash/`. It
> references gaps in the compendium's viability as a daily browser
> experience. Please investigate and propose incremental improvements
> that preserve the existing D3-graph + session-history architecture."

## A6 — Observability and diagnostics gaps

**Priority:** low-medium

**Scope:** Observations that a log, error surface, or telemetry channel
would have given dqBot (or the user) faster insight into a DQ problem had
it existed or been structured better.

**Example sub-observations:**
- App-log structure that lacks trace IDs / entity IDs, making it hard to
  correlate events
- LLM-call error handling that silently swallows failures instead of
  surfacing them
- Cost-meter transparency for the broader app's LLM spend (distinct from
  dqBot's per-run `dq_runs.llm_cost_usd` field — this is for the
  pipeline's own spend)
- Missing structured logs around known-fragile operations (dedup,
  recluster, RAG reindex)

**NOT in scope:** adding monitoring for edge cases that haven't actually
bitten (premature observability is a tech-debt accumulator). dqBot should
only flag gaps where it can cite a specific past incident or a current
data pattern that would have been easier to diagnose with the missing
channel.

**Handoff prompt framing hint:**
> "The following is an observability-gap observation from dqBot. It
> describes a specific diagnostic channel (log, error surface, telemetry)
> whose absence or structure made a recent DQ pattern harder to catch.
> Please investigate and propose a narrowly-scoped addition. Resist the
> urge to add broad tracing/metrics frameworks — the scope is the
> specific gap, not an observability overhaul."

## A7 — Data-model / schema ergonomics

**Priority:** low-medium

**Scope:** Observations about the Postgres schema that dqBot's own
investigation workflows expose — queries that are painful enough to write
often enough that a schema improvement is warranted, or schema shapes that
are actively producing bad data.

**Example sub-observations:**
- Hot query paths (ones dqBot exercises in every run) missing indexes,
  causing full-table scans
- JSONB column contracts (`users.preferences`, `dq_observations.*_ref`)
  drifting because the shape isn't type-checked at write time
- Schema migrations that left zombie columns / constraints in place
- Tables that are structurally DQ-adjacent (e.g. `captures` + `pages` +
  `page_content` relationships) where ergonomics make certain natural
  queries awkward

**NOT in scope:** wholesale schema redesigns. dqBot flags specific,
localized improvements — add-an-index, tighten-a-constraint, deprecate-a-
column. Scope of each recommendation fits in one migration.

**Handoff prompt framing hint:**
> "The following is a schema-ergonomics observation from dqBot. It
> identifies a specific, localized schema improvement (index, constraint,
> JSONB contract, or legacy-column cleanup) whose fix is scoped to one
> migration. Please investigate and propose the migration SQL following
> the pattern in `backend/db/migrations/`. Do not propose broader schema
> redesigns — that's a separate conversation."

## A8 — Prompt experimentation infrastructure

**Priority:** high

**Scope:** Observations about the gap between ad-hoc prompt editing on
currently-live prompts (skip-gate, summarization, cluster naming,
supercluster naming, any others in `backend/prompts/templates/`) and
rigorous variant-testing of those prompts. The user has long wanted
structured prompt experimentation applied to current prompts and has
explicitly called this out as a technical-debt surface.

**Context:** The a/b/c/d-per-technique naming scheme from an earlier
milestone was only applied rigorously to prompts that are now archived
(journey/narrative prompts — see `memory/project_archived_prompt_work.md`).
Current live prompts don't have comparable structured A/B testing + result
documentation.

**Example sub-observations:**
- A live prompt (e.g. skip_gate) where dqBot's S1 investigation keeps
  finding reversal patterns, suggesting the prompt would benefit from
  variant-testing rather than one-off edits
- Missing result-documentation ergonomics — when a user does test a
  variant, there's no structured place for the results to land
- Evaluation-criteria gaps that would need to exist before prompt
  variants could be compared meaningfully
- Cluster-naming prompt producing outputs that consistently fail S4's
  rival-hypothesis guard — suggesting the prompt itself (not just the
  model) needs variant-testing

**NOT in scope:** resurrecting or re-testing the archived journey/
narrative prompts. They are permanently archived. Do not reference them
as variant-testing candidates.

**NOT in scope:** proposing a specific prompt edit for a currently-live
prompt — that's the job of core investigations (S1 does this for skip-
gate). This category is about the *infrastructure* for systematic
variant-testing, not individual prompt tweaks.

**Handoff prompt framing hint:**
> "The following is a prompt-experimentation-infrastructure observation
> from dqBot. It identifies a gap between ad-hoc prompt editing and
> structured variant-testing applied to currently-live prompts (NEVER
> the archived journey/narrative prompts — see
> `memory/project_archived_prompt_work.md`). Please investigate
> `backend/prompts/` and `evaluation/` and propose infrastructure
> additions — evaluation scaffolds, variant-comparison tooling, structured
> result storage — that make rigorous prompt experimentation low-friction
> for the user going forward."

---

## Meta: how to extend this document

New categories are added during a **user-triggered role review** — a
ceremony where dqBot produces a report of adjacent observations it wrote
without a matching contract category, grouped by pattern, and the user
decides which patterns deserve a new category.

There is no fixed calendar cadence. The user invokes a role review when
the uncategorized-adjacent-observations count on the dqBot page header
gets uncomfortable enough to warrant attention, OR when the approval-rate
calibration stats drift, OR simply when the user wants to. The count
itself is the trigger.

Do NOT add categories ad-hoc in response to a single interesting
observation. The whole point of the review discipline is that category
expansion is a deliberate, batched decision — not an accretion.

If you want to drop a category (e.g., A4 never produces useful handoffs),
do that at role-review time too, with the evidence that no useful prompts
were generated under it.
