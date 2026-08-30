"""S4 -- Supercluster label vs. child-cluster drift.

Detects superclusters whose TEXT label is semantically distant from the
centroid of their child clusters' labels. SBERT cosine distance > 0.55
flags the supercluster; every candidate that clears the threshold is
emitted -- this module makes NO rival-hypothesis judgment call of its own
and performs NO LLM calls. The old per-candidate ``rival_hypothesis_guard``
(2-call gpt-4o-mini, evidence-poor -- label + 5-outlier prose, no child
evidence) retired with this change; the rival-hypothesis check now runs
upstream, batched, over richer child evidence in
``backend/services/dq_adjudicator.py`` (see
``docs/project-plans/2026-07-19-131356-dqbot-tier2-role-split/`` for the
Tier-2 role-split rationale). Each candidate carries a top-level
``children`` list (every child cluster's label) as that adjudicator's
evidence.

Calibration (updated 2026-07-17, executive triage sweep):
- ``DRIFT_DISTANCE_THRESHOLD = 0.55`` -- flag when cosine distance from
  the supercluster label embedding to the centroid of child label
  embeddings exceeds this. Raised from the 0.4 starter after two rejected
  'zoology' flags (recs 82/160): academic-vocabulary label distance (e.g.
  'zoology' vs. child labels like 'Ornithology', 'Marine Biology') pushed
  cosine distance past 0.4 for groupings that were topically sound. See
  dq_agent_scope.md §S4 for the full rationale; re-tune again at the next
  user-triggered role review if further false positives accumulate.
- ``MIN_CHILD_CLUSTERS = 3`` -- skip superclusters with fewer than 3
  children; the centroid is too noisy to be a meaningful target on tiny
  groups.

Default ``action_type`` is ``flag_for_review`` (consistent with S2):
deterministic detection cannot tell relabel-supercluster from
reassign-child-cluster (that needs content semantics the downstream LLM
enrichment is better at). Severity is ``warning`` because a misleading
supercluster label corrupts the navigational story but doesn't break
the underlying data.

Schema note: ``clusters.super_cluster`` is a TEXT topic keyword string,
NOT an FK to a separate ``super_clusters`` table. The TEXT IS the label.
``affected_entity_ids`` therefore mixes the supercluster keyword
(string) with drifting child cluster ids (ints) -- this matches the
spec's intent of "supercluster + drifting children" and is the only
honest way to reference both kinds of entity in one list given the
current schema.

Emits findings structured for ``DQAgent.persist_findings``.
"""

from __future__ import annotations

import numpy as np

from backend.db.connection import get_conn
from backend.services.sbert_loader import get_sbert_model

SCOPE_ID = "S4"
ACTION_TYPE = "flag_for_review"
ISSUE_TYPE = "supercluster_drift"
DRIFT_DISTANCE_THRESHOLD = 0.55
MIN_CHILD_CLUSTERS = 3
_OUTLIER_PREVIEW_LIMIT = 5


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two 1-D float vectors. Falls back to 0 on
    a zero-norm input (defensive: a stored zero-vector embedding is not a
    crash signal)."""
    norm_a = float(np.linalg.norm(a))
    norm_b = float(np.linalg.norm(b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def _resolve_run_id(user_id: int, recluster_run_id: int | None) -> int | None:
    """Resolve the recluster_run id to scope this investigation to.

    An explicit ``recluster_run_id`` (Task 8's full-pass generation
    snapshot -- resolved ONCE at pass start and threaded to every
    investigator, so a recluster completing mid-pass can't split findings
    across two generations) is used verbatim. ``None`` falls back to this
    user's latest completed run, preserving direct/manual-invocation
    back-compat.
    """
    if recluster_run_id is not None:
        return recluster_run_id
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id FROM recluster_runs
            WHERE user_id = %s AND status = 'completed'
            ORDER BY completed_at DESC LIMIT 1
            """,
            (user_id,),
        )
        row = cur.fetchone()
    return row[0] if row else None


def run(user_id: int, recluster_run_id: int | None = None) -> list[dict]:
    """Return S4 findings for the given user.

    Args:
        user_id: the user to investigate.
        recluster_run_id: explicit generation snapshot to scope membership
            queries to (Task 8's full-pass snapshot); an explicit id is
            used verbatim. ``None`` resolves this user's latest completed
            recluster_run internally (back-compat for direct/manual
            invocation).

    1. Resolve the recluster_run to scope to (explicit id, or this user's
       latest completed run); bail if none.
    2. Pull all clusters for that run with non-NULL ``super_cluster``;
       group by the TEXT keyword.
    3. For each supercluster:
       a. Skip if fewer than ``MIN_CHILD_CLUSTERS`` children.
       b. Encode the supercluster keyword + every child name via SBERT.
       c. Compute the centroid of child embeddings; cosine distance
          between supercluster vector and centroid.
       d. If distance <= ``DRIFT_DISTANCE_THRESHOLD``, skip.
       e. Else identify the most divergent children (lowest cos sim to
          the supercluster label).
       f. Emit a finding for every candidate that clears the threshold
          (no suppression -- see module docstring; NO LLM calls anywhere
          in this function).
    """
    run_id = _resolve_run_id(user_id, recluster_run_id)
    if run_id is None:
        return []

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, cluster_name, super_cluster
            FROM clusters
            WHERE user_id = %s
              AND recluster_run = %s
              AND super_cluster IS NOT NULL
            """,
            (user_id, run_id),
        )
        rows = cur.fetchall()

    if not rows:
        return []

    # Group by supercluster keyword.
    groups: dict[str, list[tuple[int, str]]] = {}
    for cluster_id, cluster_name, super_label in rows:
        groups.setdefault(super_label, []).append((cluster_id, cluster_name))

    # Lazy-load SBERT only when at least one supercluster has enough children.
    sbert = None
    candidates: list[dict] = []

    for super_label, children in groups.items():
        if len(children) < MIN_CHILD_CLUSTERS:
            continue

        if sbert is None:
            sbert = get_sbert_model()

        label_vec = np.asarray(sbert.encode(super_label), dtype=float)
        child_names = [name for _cid, name in children]
        child_embs = np.asarray(sbert.encode(child_names), dtype=float)

        centroid = np.mean(child_embs, axis=0)
        centroid_sim = _cosine_similarity(label_vec, centroid)
        distance = 1.0 - centroid_sim
        if distance <= DRIFT_DISTANCE_THRESHOLD:
            continue

        # Identify most-divergent children: lowest cos sim to supercluster
        # label. Stable tiebreak by cluster_id ascending.
        per_child_sim: list[tuple[float, int, str]] = []
        for (cid, name), emb in zip(children, child_embs):
            sim = _cosine_similarity(label_vec, emb)
            per_child_sim.append((sim, cid, name))
        per_child_sim.sort(key=lambda t: (t[0], t[1]))
        outliers = [(cid, name) for _sim, cid, name in per_child_sim]

        candidates.append({
            "super_label": super_label,
            "n_children": len(children),
            "distance": distance,
            "child_names": child_names,
            "outliers": outliers,
        })

    if not candidates:
        return []

    # Rank by distance descending (most-divergent first); supercluster keyword
    # asc as tiebreak for deterministic ordering.
    candidates.sort(key=lambda c: (-c["distance"], c["super_label"]))

    findings: list[dict] = []
    rank = 0
    for cand in candidates:
        super_label = cand["super_label"]
        n_children = cand["n_children"]
        distance = cand["distance"]
        outliers_full = cand["outliers"]
        outliers_preview = outliers_full[:_OUTLIER_PREVIEW_LIMIT]

        rank += 1
        outlier_lines = "\n".join(
            f"- '{name}' (cluster {cid})" for cid, name in outliers_preview
        )
        rationale = (
            f"Cosine distance {distance:.2f} from supercluster label to "
            f"child-label centroid (threshold {DRIFT_DISTANCE_THRESHOLD}).\n"
            f"Most divergent children:\n{outlier_lines}"
        )

        top_3_names = [name for _cid, name in outliers_preview[:3]]
        findings.append({
            "tag": "core",
            "scope_citation": SCOPE_ID,
            "adjacency_contract_ref": None,
            "issue_type": ISSUE_TYPE,
            "entity_type": "supercluster",
            "entity_id": super_label,
            "observation": (
                f"Supercluster '{super_label}' has cosine distance "
                f"{distance:.2f} from the centroid of its {n_children} child "
                f"cluster labels (threshold {DRIFT_DISTANCE_THRESHOLD}); most "
                f"divergent children: {top_3_names}."
            ),
            "severity": "warning",
            "rank": rank,
            "children": cand["child_names"],
            "recommendation": {
                "headline": (
                    f"Supercluster '{super_label}' may not fit its child "
                    f"clusters (distance {distance:.2f} > threshold "
                    f"{DRIFT_DISTANCE_THRESHOLD})"
                ),
                "rationale": rationale,
                "self_classification": "judgment",
                "action_type": ACTION_TYPE,
                "affected_entity_ids": (
                    [super_label] + [cid for cid, _name in outliers_full]
                ),
            },
            "handoff_prompt_draft": None,
        })

    return findings
