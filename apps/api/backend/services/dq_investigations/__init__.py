"""Deterministic DQ investigation modules (S1-S6).

Each module exposes a single public function:

    def run(user_id: int, recluster_run_id: int | None = None) -> list[dict]

``recluster_run_id`` is Task 8's full-pass generation snapshot: an explicit
id is used verbatim in the (S2/S3/S4/S6) membership queries, so a recluster
completing mid-pass can't split findings across two generations (see
the 2026-07-19 dqbot-tier2-role-split plan, private). ``None``
resolves each user's latest completed recluster_run internally
(back-compat for direct/manual invocation). S1/S5 accept the parameter for
signature uniformity but ignore it -- neither is scoped to a recluster run.

The returned dicts match the agent-output finding schema consumed by
DQAgent.persist_findings (see backend/services/dq_agent.py). These
investigators run WITHOUT LLM calls -- true zero-LLM as of Tier 2: the old
per-candidate rival_hypothesis_guard (S2/S4's 2-call gpt-4o-mini check)
retired, and every threshold candidate is now emitted, with S2 carrying
member evidence and S4 carrying child-cluster evidence for the upstream
batched adjudicator (backend/services/dq_adjudicator.py) to judge instead.
The DQAgent invokes these investigators before or alongside its CC
subprocess to pre-populate deterministic findings.
"""

# Canonical list of investigation names that the manual "Run now" button
# AND the weekly scheduler both dispatch. Lifted out of the router so the
# scheduler (backend.services.dq_scheduler) can reuse the same set without
# duplicating the literal -- if a new investigator is added, this is the
# one place to register it for both run paths.
DEFAULT_INVESTIGATIONS: list[str] = [
    "skip_gate_reversal_audit",  # S1
    "cluster_coherence_drift",  # S2
    "domain_silo_clusters",  # S3
    "supercluster_drift",  # S4
    "dedup_escapees",  # S5
    "leaf_impurity",  # S6
]

# Structural investigations only -- fired by the recluster-event hook (Task 6.3).
# S1 (annotations) and S5 (page-pair similarity) are independent of cluster
# structure, so re-running them on every recluster is wasted compute. The
# hook in backend.services.dq_scheduler.enqueue_recluster_dq ENQUEUES this
# subset whenever a recluster finishes for an opted-in user; the worker dispatches.
#
# Invariant: STRUCTURAL_INVESTIGATIONS must be a strict subset of
# DEFAULT_INVESTIGATIONS. Adding a new investigator here without adding it
# to DEFAULT_INVESTIGATIONS would mean the recluster path runs something
# the manual / weekly path never sees.
STRUCTURAL_INVESTIGATIONS: list[str] = [
    "cluster_coherence_drift",  # S2
    "domain_silo_clusters",  # S3
    "supercluster_drift",  # S4
    "leaf_impurity",  # S6
]
