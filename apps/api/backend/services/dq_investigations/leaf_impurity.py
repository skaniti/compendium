"""S6 -- Leaf impurity.

Deterministic investigation: flags clusters ("leaves") whose members are not
mutually similar enough in the clustering-embedding space to plausibly be one
coherent topic. Unlike S2 (``cluster_coherence_drift``), which compares each
member against the cluster's LLM-assigned label, this investigation looks
only at member-to-member pairwise similarity -- it catches "junk drawer"
leaves where a small minority of pages ride along with an otherwise coherent
majority, independent of whether the assigned label still reads sensibly.

Threshold provenance: the WS2 leaf-impurity audit (prod run 142, 97
hand-labeled leaves) found min-pairwise-cosine-similarity to be the best
cheap single-metric detector for MIXED vs PURE leaves -- precision 0.80,
recall 0.63, F1 0.71 at a <= 0.19 threshold (see
``docs/project-plans/2026-07-14-164302-sc-misfire-fix-design/artifacts/ws2_report.md``
section 2). That same audit found this signal to be *independent* of the
supercluster-misfire mechanism (only 1 of 19 MIXED leaves in the audited run
actually caused a downstream SC misfire) -- this investigation is a
standalone leaf-hygiene signal, not a fix for SC quality, and should not be
read as evidence that a flagged leaf is causing any supercluster problem.

``MIN_CLUSTER_SIZE = 3``: a 2-page leaf has exactly one pairwise similarity,
and a low value there is just as likely to reflect legitimate topic breadth
in a tiny cluster as genuine impurity -- 2-page leaves are noise-adjacent by
nature and would swamp the signal if included.

Deterministic, no LLM/API calls: embeddings come from the clustering cache
(``clustering_embeddings``, keyed by ``model_key =
f"{settings.clustering_embedding_model}@{settings.clustering_text_contract}"``).
Clusters with incomplete embedding coverage (any member missing a cached
embedding under that key) are SKIPPED entirely -- no partial scoring, no
fallback compute.

Emits findings structured for DQAgent.persist_findings.
"""

from __future__ import annotations

from itertools import combinations

import numpy as np

from backend.config.settings import settings
from backend.db import embedding_repo
from backend.db.connection import get_conn

SCOPE_ID = "S6"
ACTION_TYPE = "split_cluster"
ISSUE_TYPE = "impure_leaf"
MIN_CLUSTER_SIZE = 3
MIN_PAIRWISE_SIM_THRESHOLD = 0.19


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


def _l2_normalize(vec: np.ndarray) -> np.ndarray:
    """L2-normalize a 1-D vector. Zero-norm input is returned unchanged
    (defensive: a stored zero-vector embedding is not a crash signal)."""
    norm = float(np.linalg.norm(vec))
    if norm == 0.0:
        return vec
    return vec / norm


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
    """Return S6 findings for the given user.

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
    4. Pull cached clustering-cache embeddings for all members; skip
       clusters where coverage is incomplete.
    5. L2-normalize each member vector and compute the minimum pairwise
       cosine similarity across all member pairs.
    6. Flag clusters at or below MIN_PAIRWISE_SIM_THRESHOLD.
    7. Rank ascending by min-sim (worst/most-impure leaf first).
    """
    model_key = (
        f"{settings.clustering_embedding_model}@{settings.clustering_text_contract}"
    )

    run_id = _resolve_run_id(user_id, recluster_run_id)
    if run_id is None:
        return []

    with get_conn() as conn, conn.cursor() as cur:
        # Pull (cluster_id, cluster_name, stable_id, page_id, page_content_id,
        # title) for every active member of every cluster in this run.
        # stable_id (migration 036) survives reclusters when identity is
        # enabled; NULL when identity is off or the row predates 036.
        cur.execute(
            """
            SELECT c.id, c.cluster_name, c.stable_id, p.id, p.page_content_id, p.title
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
    for cluster_id, cluster_name, stable_id, page_id, page_content_id, title in rows:
        cluster_names[cluster_id] = cluster_name
        cluster_stable_ids[cluster_id] = stable_id
        cluster_members.setdefault(cluster_id, []).append({
            "page_id": page_id,
            "page_content_id": page_content_id,
            "title": title,
        })

    candidates: list[dict] = []

    for cluster_id, members in cluster_members.items():
        if len(members) < MIN_CLUSTER_SIZE:
            continue

        content_ids = [m["page_content_id"] for m in members]
        if any(cid is None for cid in content_ids):
            # A member with no linked page_content can't be embedded at
            # all -- coverage is incomplete by definition; skip.
            continue

        emb_map = embedding_repo.get_clustering_embeddings(content_ids, model_key)
        if len(emb_map) < len(members):
            # Incomplete embedding coverage under this model_key -- skip
            # rather than partially score or fall back to a fresh compute.
            continue

        vectors = {
            m["page_content_id"]: _l2_normalize(
                np.asarray(emb_map[m["page_content_id"]], dtype=float)
            )
            for m in members
        }

        min_sim: float | None = None
        worst_pair: tuple[dict, dict] | None = None
        for m_a, m_b in combinations(members, 2):
            sim = float(
                np.dot(vectors[m_a["page_content_id"]], vectors[m_b["page_content_id"]])
            )
            if min_sim is None or sim < min_sim:
                min_sim = sim
                worst_pair = (m_a, m_b)

        if min_sim is None or min_sim > MIN_PAIRWISE_SIM_THRESHOLD:
            continue

        candidates.append({
            "cluster_id": cluster_id,
            "label": cluster_names[cluster_id],
            "n_members": len(members),
            "min_sim": min_sim,
            "worst_pair": worst_pair,
        })

    if not candidates:
        return []

    # Rank ascending by min-sim (most impure first); cluster_id asc as
    # tiebreak for full determinism.
    candidates.sort(key=lambda c: (c["min_sim"], c["cluster_id"]))

    findings: list[dict] = []
    for rank, cand in enumerate(candidates, start=1):
        cluster_id = cand["cluster_id"]
        label = cand["label"]
        n_members = cand["n_members"]
        min_sim = cand["min_sim"]
        page_a, page_b = cand["worst_pair"]
        title_a = page_a["title"] or "(untitled)"
        title_b = page_b["title"] or "(untitled)"

        stable_id = cluster_stable_ids.get(cluster_id)
        entity_id, action_payload = _cluster_entity_ref(cluster_id, stable_id)

        findings.append({
            "tag": "core",
            "scope_citation": SCOPE_ID,
            "adjacency_contract_ref": None,
            "issue_type": ISSUE_TYPE,
            "entity_type": "cluster",
            "entity_id": entity_id,
            "observation": (
                f"Cluster {cluster_id} ('{label}', {n_members} members) has "
                f"minimum pairwise similarity {min_sim:.2f} (threshold "
                f"{MIN_PAIRWISE_SIM_THRESHOLD}); most-distant pair: "
                f"'{title_a}' vs '{title_b}'."
            ),
            "severity": "info",
            "rank": rank,
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
                    f"Cluster {cluster_id} ('{label}') may mix topics -- "
                    f"min pairwise similarity {min_sim:.2f}"
                ),
                "rationale": (
                    f"The most-distant member pair in cluster '{label}' -- "
                    f"'{title_a}' and '{title_b}' -- has cosine similarity "
                    f"{min_sim:.2f}, at or below the "
                    f"{MIN_PAIRWISE_SIM_THRESHOLD} threshold calibrated "
                    f"against a hand-labeled leaf-purity audit (precision "
                    f"0.80 / recall 0.63 / F1 0.71 on run-142 ground truth). "
                    f"Review whether this leaf mixes unrelated topics and "
                    f"would benefit from a split."
                ),
                "self_classification": "judgment",
                "action_type": ACTION_TYPE,
                "affected_entity_ids": [entity_id],
                "action_payload": action_payload,
            },
            "handoff_prompt_draft": None,
        })

    return findings
