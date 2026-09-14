"""S2 -- Cluster coherence drift.

Flags clusters whose member pages are internally incoherent: their summary
embeddings semantically diverge from the cluster's assigned label. Detection
is SBERT-only (the scope-doc's noun-phrase variant is deferred -- it would
require spaCy and bring no signal that label-vs-member cosine similarity
doesn't already capture). Every candidate that clears the coherence-ratio
threshold is emitted -- this module makes NO rival-hypothesis judgment call
of its own and performs NO LLM calls. The old per-candidate
``rival_hypothesis_guard`` (2-call gpt-4o-mini, evidence-poor -- label +
5-outlier prose, no member evidence) retired with this change; the
rival-hypothesis check now runs upstream, batched, over richer member
evidence in ``backend/services/dq_adjudicator.py`` (see
the 2026-07-19 dqbot-tier2-role-split plan (private) for the
Tier-2 role-split rationale). Each candidate carries a top-level
``members`` list (title/domain/page_content_id for every member with a
cached embedding, coherent and outlier alike) as that adjudicator's
evidence.

Calibration starters (tune at the first user-triggered role review):
- ``MEMBER_SIMILARITY_THRESHOLD = 0.35`` -- a member is "label-coherent"
  when cos sim with the label embedding meets or exceeds this.
- ``COHERENCE_RATIO_THRESHOLD = 0.60`` -- flag when fewer than 60% of
  members with embeddings clear the per-member threshold.
- ``MIN_CLUSTER_SIZE = 3`` -- skip clusters smaller than this; signal
  is unreliable on tiny clusters.

Default ``action_type`` is ``flag_for_review``: deterministic detection
cannot tell relabel-cluster from split-cluster (that needs content
semantics the downstream LLM enrichment is better at). Severity is
``warning`` because incoherent clusters degrade the graph's usefulness.

Emits findings structured for ``DQAgent.persist_findings``.
"""

from __future__ import annotations

import numpy as np

from backend.db import embedding_repo
from backend.db.connection import get_conn
from backend.services.sbert_loader import get_sbert_model

SCOPE_ID = "S2"
ACTION_TYPE = "flag_for_review"
ISSUE_TYPE = "cluster_coherence_drift"
SBERT_MODEL_NAME = "all-MiniLM-L6-v2"
MEMBER_SIMILARITY_THRESHOLD = 0.35
COHERENCE_RATIO_THRESHOLD = 0.60
MIN_CLUSTER_SIZE = 3
# Same numeric floor as MIN_CLUSTER_SIZE today, but the gates are
# semantically distinct: one filters on total membership, the other on
# how many members have a cached SBERT embedding to actually score.
# Aliased so they can be tuned independently without silent coupling.
MIN_EMBEDDED_MEMBERS = MIN_CLUSTER_SIZE
_OUTLIER_PREVIEW_LIMIT = 5


def _cluster_entity_ref(cluster_id: int, stable_id: str | None) -> tuple[str, dict]:
    """Return (entity_id_str, action_payload) for a cluster finding (spec S1/S4).

    entity_id is the cluster's stable_id (survives reclusters) when present;
    falls back to the stringified integer cluster id when stable_id is NULL
    (identity disabled, or a legacy/pre-036 row) -- never crashes. The
    action_payload mirrors that: {"stable_id": ...} when derivable, else a
    degrade-signal {"identity": "missing"} so the apply layer (spec S5) falls
    back to record-only rather than erroring on an unresolvable payload.
    """
    if stable_id is not None:
        return stable_id, {"stable_id": stable_id}
    return str(cluster_id), {"identity": "missing"}


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
    """Return S2 findings for the given user.

    Args:
        user_id: the user to investigate.
        recluster_run_id: explicit generation snapshot to scope membership
            queries to (Task 8's full-pass snapshot); an explicit id is
            used verbatim. ``None`` resolves this user's latest completed
            recluster_run internally (back-compat for direct/manual
            invocation).

    1. Resolve the recluster_run to scope to (explicit id, or this user's
       latest completed run); bail if none.
    2. For each cluster in that run, pull active member pages.
    3. Skip clusters below MIN_CLUSTER_SIZE.
    4. Pull cached member embeddings; skip clusters where none are cached.
    5. Encode the cluster label via SBERT (once per cluster).
    6. Compute coherence_ratio; emit a finding for every candidate at or
       below COHERENCE_RATIO_THRESHOLD (no suppression -- see module
       docstring; NO LLM calls anywhere in this function).
    """
    run_id = _resolve_run_id(user_id, recluster_run_id)
    if run_id is None:
        return []

    with get_conn() as conn, conn.cursor() as cur:
        # Pull (cluster_id, cluster_name, stable_id, page_id, page_content_id,
        # title, domain) for every active member of every cluster in this
        # run. stable_id (migration 036) survives reclusters when identity is
        # enabled; NULL when identity is off or the row predates 036.
        cur.execute(
            """
            SELECT c.id, c.cluster_name, c.stable_id, p.id, p.page_content_id,
                   p.title, p.domain
            FROM clusters c
            JOIN page_clusters pc ON pc.cluster_id = c.id
            JOIN pages p ON pc.page_id = p.id
            WHERE c.user_id = %s
              AND c.recluster_run = %s
              AND p.user_id = %s
              AND p.status = 'active'
            """,
            (user_id, run_id, user_id),
        )
        rows = cur.fetchall()

    if not rows:
        return []

    # Group members by cluster.
    cluster_names: dict[int, str] = {}
    cluster_stable_ids: dict[int, str | None] = {}
    cluster_members: dict[int, list[dict]] = {}
    for cluster_id, cluster_name, stable_id, page_id, page_content_id, title, domain in rows:
        cluster_names[cluster_id] = cluster_name
        cluster_stable_ids[cluster_id] = stable_id
        cluster_members.setdefault(cluster_id, []).append({
            "page_id": page_id,
            "page_content_id": page_content_id,
            "title": title,
            "domain": domain,
        })

    # Lazy-load SBERT only when at least one cluster might need encoding.
    sbert = None
    candidates: list[dict] = []

    for cluster_id, members in cluster_members.items():
        if len(members) < MIN_CLUSTER_SIZE:
            continue

        content_ids = [
            m["page_content_id"] for m in members if m["page_content_id"] is not None
        ]
        if not content_ids:
            continue

        emb_map = embedding_repo.get_embeddings_for_content_ids(
            content_ids, model_name=SBERT_MODEL_NAME
        )
        if not emb_map:
            continue

        # Only members that actually have a cached embedding contribute to
        # the ratio's denominator. A cluster of 5 with 2 cached embeddings
        # is judged on those 2; a cluster with 0 cached embeddings is
        # silently skipped (handled above).
        members_with_emb = [
            m for m in members if m["page_content_id"] in emb_map
        ]
        if len(members_with_emb) < MIN_EMBEDDED_MEMBERS:
            continue

        if sbert is None:
            sbert = get_sbert_model()
        label = cluster_names[cluster_id]
        label_vec = np.asarray(sbert.encode(label), dtype=float)

        coherent_count = 0
        outlier_pairs: list[tuple[float, dict]] = []
        for m in members_with_emb:
            emb_vec = np.asarray(emb_map[m["page_content_id"]], dtype=float)
            sim = _cosine_similarity(label_vec, emb_vec)
            if sim >= MEMBER_SIMILARITY_THRESHOLD:
                coherent_count += 1
            else:
                outlier_pairs.append((sim, m))

        n_members = len(members_with_emb)
        coherence_ratio = coherent_count / n_members
        if coherence_ratio >= COHERENCE_RATIO_THRESHOLD:
            continue

        # Sort outliers most-divergent-first; deterministic tiebreak by
        # page_id so output is stable across runs.
        outlier_pairs.sort(key=lambda p: (p[0], p[1]["page_id"]))
        outliers = [m for _sim, m in outlier_pairs]
        # Full member set (coherent + outlier), page_id-ascending for
        # deterministic output -- this is the adjudicator's evidence, so it
        # is NOT limited to outliers the way the rationale preview is.
        members_evidence = sorted(members_with_emb, key=lambda m: m["page_id"])

        candidates.append({
            "cluster_id": cluster_id,
            "label": label,
            "n_members": n_members,
            "coherent_count": coherent_count,
            "n_outliers": n_members - coherent_count,
            "coherence_ratio": coherence_ratio,
            "outliers": outliers,
            "members": members_evidence,
        })

    if not candidates:
        return []

    # Rank by 1 - coherence_ratio descending (most-divergent first); cluster_id
    # asc as tiebreak.
    candidates.sort(key=lambda c: (-(1.0 - c["coherence_ratio"]), c["cluster_id"]))

    findings: list[dict] = []
    rank = 0
    for cand in candidates:
        cluster_id = cand["cluster_id"]
        label = cand["label"]
        n_members = cand["n_members"]
        n_outliers = cand["n_outliers"]
        ratio = cand["coherence_ratio"]
        outliers = cand["outliers"][:_OUTLIER_PREVIEW_LIMIT]

        rank += 1
        outlier_lines = "\n".join(
            f"- '{m['title'] or '(untitled)'}' ({m['domain'] or 'no-domain'})"
            for m in outliers
        )
        rationale = (
            f"Coherence ratio {ratio:.2f} below threshold "
            f"{COHERENCE_RATIO_THRESHOLD}.\n"
            f"Top outlier pages:\n{outlier_lines}"
        )

        stable_id = cluster_stable_ids.get(cluster_id)
        entity_id, action_payload = _cluster_entity_ref(cluster_id, stable_id)
        members_field = [
            {
                "title": m["title"],
                "domain": m["domain"],
                "page_content_id": m["page_content_id"],
            }
            for m in cand["members"]
        ]

        findings.append({
            "tag": "core",
            "scope_citation": SCOPE_ID,
            "adjacency_contract_ref": None,
            "issue_type": ISSUE_TYPE,
            "entity_type": "cluster",
            "entity_id": entity_id,
            "observation": (
                f"Cluster {cluster_id} ('{label}') has coherence ratio "
                f"{ratio:.2f} (threshold {COHERENCE_RATIO_THRESHOLD}); "
                f"{n_outliers}/{n_members} member summaries diverge from "
                f"the label embedding."
            ),
            "severity": "warning",
            "rank": rank,
            "members": members_field,
            "evidence": {
                "items": [
                    {
                        "type": "cluster",
                        "id": cluster_id,
                        "stable_id": stable_id,
                        "label": label,
                    }
                ]
            },
            "recommendation": {
                "headline": (
                    f"Cluster {cluster_id} ('{label}'): {n_outliers}/{n_members} "
                    f"members diverge from label embedding"
                ),
                "rationale": rationale,
                "self_classification": "judgment",
                "action_type": ACTION_TYPE,
                "affected_entity_ids": [entity_id],
                "action_payload": action_payload,
            },
            "handoff_prompt_draft": None,
        })

    return findings
