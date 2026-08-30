"""Hybrid supercluster discovery: data-driven grouping + topic mapping + interest tiers.

Clustering-rethink increment 3 (findings F13/F17/F18, Q2 = Hybrid). Groups are
discovered from leaf-cluster centroid geometry (agglomerative, cosine, original
embedding space); the user's ``topic_interests`` keywords are then mapped ONTO
discovered groups by embedding similarity — inverting the legacy design where
an LLM classified clusters INTO the keyword list. Unmatched groups surface as
suggested topics. Interest tiers rank groups by behavioral evidence (temporal
recurrence of visits) with the explicit keyword match as the dominant signal.

Pure computation over numpy arrays and plain dicts: no DB writes and no prod
call sites in this increment. The eval harness (evaluation/clustering/
cluster_eval.py) drives these functions now; ``super_cluster_service`` adopts
them when prod wiring lands with the cluster-identity-persistence batch
(rethink direction 4 + 5) — see plan-increment-3.md for why persistence is a
prerequisite.

Interest acts ABOVE the partition, never on it: nothing here feeds back into
embeddings or HDBSCAN. Tiers drive presentation (expand/collapse), suggested-
topic ordering, and later LLM evidence sampling.
"""

import logging
from datetime import datetime

import numpy as np

logger = logging.getLogger(__name__)

# Winsorization cap for per-visit dwell seconds. Dwell is finalized on
# tab-switch/close, so background tabs don't accumulate — but a foreground
# tab left open does. 600s keeps "read a long article" while flattening
# "left it open over lunch" (the 2026-07-10 probe showed a pile-up at
# exactly this failure mode).
DWELL_CAP_SECONDS = 600

# First-cut tier thresholds (plan-increment-3.md decision 4). Deliberately
# few and transparent; tuned on the qualitative pass, not optimized.
RECURRENT_MIN_WEEKS = 3
RECURRENT_ALT_WEEKS = 2
RECURRENT_ALT_SPAN_DAYS = 21
# Pass feedback 2026-07-10: recurrence needs substance, not just spread —
# 2-3 stray sightings of a 3-4 page topic (WWII, Washington cities,
# behavioral econ, leetspeak) read as casual, while same-shaped groups with
# real volume (crochet 5p, travel 8p, autism 13p) read as recurrent.
RECURRENT_MIN_PAGES = 5
BINGE_MAX_DAYS = 2
BINGE_MIN_PAGES = 8

TIER_ORDER = ["declared", "recurrent", "casual", "binge"]


# ── 3a: group discovery ─────────────────────────────────────────────────


def discover_groups(centroids: np.ndarray, distance_threshold: float) -> np.ndarray:
    """Group cluster centroids by agglomerative clustering (average, cosine).

    Args:
        centroids: (n_clusters, dim) L2-normalized cluster centroids in the
            ORIGINAL embedding space (not UMAP-reduced — group affinity keeps
            its semantics across reduction configs, same reasoning as the
            increment-2 outlier-score decision).
        distance_threshold: cosine-distance cut; pairs of groups closer than
            this keep merging. Higher = coarser groups.

    Returns:
        (n_clusters,) int array of group labels, 0..G-1, ordered by first
        appearance. Every cluster gets a group; singleton groups are legal
        (a cluster that is its own group). Deterministic — no randomness.
    """
    n = len(centroids)
    if n == 0:
        return np.empty(0, dtype=int)
    if n == 1:
        return np.zeros(1, dtype=int)

    from sklearn.cluster import AgglomerativeClustering

    raw = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=distance_threshold,
        metric="cosine",
        linkage="average",
    ).fit_predict(centroids)

    # Relabel to first-appearance order so group ids are stable/readable.
    remap: dict[int, int] = {}
    labels = np.empty(n, dtype=int)
    for i, g in enumerate(raw):
        if g not in remap:
            remap[g] = len(remap)
        labels[i] = remap[g]
    return labels


def subdivide_groups(
    group_labels: np.ndarray,
    fine_labels: np.ndarray,
    groups_to_split: set[int],
) -> np.ndarray:
    """Re-cut selected groups along the finer partition (batch C C2 accept).

    For each group id in ``groups_to_split``, its members are re-assigned by
    their ``fine_labels`` value — the same linkage tree cut lower, so pieces
    nest exactly. Returns a NEW contiguous label array (first-appearance
    order); groups not selected keep their membership (ids may renumber).
    A selected group whose members share one fine label stays whole.
    """
    raw = np.empty(len(group_labels), dtype=object)
    for i, g in enumerate(group_labels):
        if int(g) in groups_to_split:
            raw[i] = ("split", int(g), int(fine_labels[i]))
        else:
            raw[i] = ("keep", int(g))

    remap: dict = {}
    out = np.empty(len(group_labels), dtype=int)
    for i, key in enumerate(raw):
        if key not in remap:
            remap[key] = len(remap)
        out[i] = remap[key]
    return out


def compute_group_centroids(
    centroids: np.ndarray, group_labels: np.ndarray
) -> np.ndarray:
    """(G, dim) L2-normalized mean of member cluster centroids per group."""
    n_groups = int(group_labels.max()) + 1 if len(group_labels) else 0
    out = np.zeros((n_groups, centroids.shape[1] if len(centroids) else 0))
    for g in range(n_groups):
        members = centroids[group_labels == g]
        mean = members.mean(axis=0)
        norm = np.linalg.norm(mean)
        out[g] = mean / norm if norm > 0 else mean
    return out


# ── 3a: topic mapping ───────────────────────────────────────────────────


def map_topics_to_groups(
    group_centroids: np.ndarray,
    keywords: list[str],
    keyword_vectors: np.ndarray,
    match_threshold: float,
    sims: np.ndarray | None = None,
) -> dict[int, dict]:
    """Map user topic keywords onto discovered groups by cosine similarity.

    A group takes its argmax keyword when similarity >= match_threshold; a
    keyword may label multiple groups (umbrella keywords like "science" are
    legitimate), but a group carries at most one keyword. Groups below
    threshold get topic=None → suggested-topic candidates.

    Args:
        sims: optional precomputed (G, K) similarity matrix (the hybrid
            orchestrator passes ``keyword_sim_matrix`` output so group- and
            cluster-level scoring share one definition, including expansion
            terms); ``keyword_vectors`` is ignored when given.

    Returns {group_id: {"topic": str|None, "similarity": float,
                        "runner_up": str|None, "runner_up_similarity": float}}.
    Similarities are rounded for report readability; runner-up is recorded so
    the qualitative pass can see near-misses and threshold sensitivity.
    """
    result: dict[int, dict] = {}
    if len(group_centroids) == 0:
        return result
    if not keywords:
        return {
            g: {"topic": None, "similarity": 0.0,
                "runner_up": None, "runner_up_similarity": 0.0}
            for g in range(len(group_centroids))
        }

    if sims is None:
        sims = group_centroids @ keyword_vectors.T  # (G, K), both L2-normalized
    for g in range(len(group_centroids)):
        order = np.argsort(-sims[g])
        best, second = int(order[0]), int(order[1]) if len(keywords) > 1 else None
        best_sim = float(sims[g][best])
        result[g] = {
            "topic": keywords[best] if best_sim >= match_threshold else None,
            "similarity": round(best_sim, 4),
            "runner_up": keywords[second] if second is not None else None,
            "runner_up_similarity": (
                round(float(sims[g][second]), 4) if second is not None else 0.0
            ),
        }
    return result


def keyword_sim_matrix(
    target_cents: np.ndarray, term_vectors: list[np.ndarray]
) -> np.ndarray:
    """(n_targets, K) keyword similarities with depth-1 expansion.

    ``term_vectors[k]``: (T_k, dim) L2-normalized rows — the keyword's own
    embedding first, then its expansion terms. Score = MAX over the term
    set: a cluster about fluid dynamics should count as near "science" via
    the physics facet even though the bare word embeds far away
    (2026-07-14 spec; prod evidence: science peaked at 0.29 direct). With
    single-row entries (no expansion) this reduces exactly to the legacy
    ``targets @ keywords.T``."""
    if not term_vectors:
        return np.empty((len(target_cents), 0))
    return np.column_stack(
        [(target_cents @ tv.T).max(axis=1) for tv in term_vectors]
    )


def refine_by_cluster(
    group_labels: np.ndarray,
    group_topics: dict[int, str | None],
    keywords: list[str],
    sims: np.ndarray,
    match_threshold: float,
    margin: float,
) -> dict[int, dict]:
    """Cluster-level carve-out claims (fix B+C, 2026-07-14 spec).

    Group-level mapping stays the recall mechanism — coherent groups have
    centroids MORE topic-like than their individual members (prod evidence:
    zoology's group hit 0.38 while its members sat ~0.27, so pure
    cluster-level claiming would gut recall). This pass adds precision on
    top: a cluster whose INDIVIDUAL argmax keyword clears ``match_threshold``
    and differs from its group's post-verify topic is claimed by that
    keyword — when the group HAS a topic, only if the claim beats the
    cluster's sim to that topic by ``margin`` (prevents churn between
    near-tied keywords). Catches both diluted-then-demoted members (an AI
    cluster at 0.48 inside a rejected 12-member group) and absorbed members
    (astronomy clusters at 0.41/0.32 inside the Volcanic Phenomena group).

    Args:
        group_labels: (N,) group index per cluster, aligned to sims rows.
        group_topics: {group_index: keyword or None} AFTER verifier
            demotions — claims are judged against final group ownership.
        keywords: declared keyword list, order matching sims columns.
        sims: (N, K) cluster-to-keyword similarities (max-over-terms when
            keyword expansion is active — the caller computes it so group-
            and cluster-level scoring share one definition).
        match_threshold: same bar as group-level mapping.
        margin: required superiority over the current topic's sim.

    Returns:
        {cluster_row_index: {"keyword": str, "similarity": float}} — only
        clusters with a claim. The caller materializes carved groups.
    """
    claims: dict[int, dict] = {}
    if not keywords or len(group_labels) == 0:
        return claims
    kw_idx = {k: j for j, k in enumerate(keywords)}
    for i in range(len(group_labels)):
        best = int(np.argmax(sims[i]))
        best_sim = float(sims[i][best])
        if best_sim < match_threshold:
            continue
        current = group_topics.get(int(group_labels[i]))
        if current == keywords[best]:
            continue
        if current is not None:
            cur_j = kw_idx.get(current)
            if cur_j is not None and best_sim < float(sims[i][cur_j]) + margin:
                continue
        claims[i] = {"keyword": keywords[best], "similarity": round(best_sim, 4)}
    return claims


def embed_keywords(
    keywords: list[str], user_id: int | None = None, harness: bool = False
) -> np.ndarray:
    """Embed topic keywords in the same space as the page embeddings.

    Routes on ``settings.clustering_embedding_model`` exactly like
    ``ClusteringService._compute_embeddings``: OpenAI for ``text-embedding-*``
    (cost-evented — keyword lists are a handful of tokens, cost is noise but
    Q1 says all API embedding spend joins monitoring; ``harness`` marks
    eval-harness spend vs prod recluster spend), local SBERT otherwise.
    Rows L2-normalized. No caching: the input is tiny and keywords change
    with user edits.
    """
    from backend.config.settings import settings

    if not keywords:
        return np.empty((0, 0))

    model_name = settings.clustering_embedding_model
    if model_name.startswith("text-embedding-"):
        from openai import OpenAI

        client = OpenAI(api_key=settings.openai_api_key)
        resp = client.embeddings.create(model=model_name, input=list(keywords))
        vectors = np.array(
            [item.embedding for item in sorted(resp.data, key=lambda d: d.index)]
        )
        if user_id is not None:
            try:
                from backend.db import trends_repo

                trends_repo.insert_cost_event(
                    user_id=user_id,
                    event_type="clustering_embedding",
                    model=model_name,
                    input_tokens=resp.usage.total_tokens,
                    cost_usd=resp.usage.total_tokens / 1_000_000 * 0.02,
                    metadata={"harness": harness, "keywords": len(keywords)},
                )
            except Exception:
                logger.debug("keyword embedding cost event failed", exc_info=True)
    else:
        from backend.services.sbert_loader import get_sbert_model

        vectors = np.asarray(get_sbert_model().encode(list(keywords)))

    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return vectors / norms


# ── 3b: interest evidence + tiers ───────────────────────────────────────


def aggregate_visit_evidence(visit_rows: list[dict]) -> dict:
    """Reduce raw visit rows to the interest-evidence dict for one group.

    ``visit_rows``: every visit row (revisits included) for the group's member
    pages, shape {"visit_id", "page_content_id", "visited_at": datetime,
    "dwell_seconds": int|None}. Rows are deduped by visit_id here so callers
    can concatenate per-cluster row lists without worrying about member pages
    that share a page_content_id.
    """
    seen: dict[int, tuple] = {}
    for r in visit_rows:
        seen[r["visit_id"]] = (
            r["page_content_id"],
            r["visited_at"],
            min(int(r.get("dwell_seconds") or 0), DWELL_CAP_SECONDS),
        )
    if not seen:
        return {
            "n_visits": 0, "n_days": 0, "n_weeks": 0, "span_days": 0,
            "re_url_count": 0, "dwell_median": 0, "dwell_p90": 0,
        }

    by_content: dict[int, int] = {}
    days: set = set()
    weeks: set = set()
    dwells: list[int] = []
    for content_id, ts, dwell in seen.values():
        if isinstance(ts, str):
            ts = datetime.fromisoformat(ts)
        days.add(ts.date())
        weeks.add(ts.isocalendar()[:2])
        dwells.append(dwell)
        if content_id is not None:
            by_content[content_id] = by_content.get(content_id, 0) + 1

    dwells.sort()
    return {
        "n_visits": len(seen),
        "n_days": len(days),
        "n_weeks": len(weeks),
        "span_days": (max(days) - min(days)).days,
        "re_url_count": sum(1 for c in by_content.values() if c > 1),
        "dwell_median": int(np.median(dwells)),
        "dwell_p90": int(dwells[max(0, int(len(dwells) * 0.9) - 1)]),
    }


def interest_tier(evidence: dict, n_pages: int, declared: bool) -> str:
    """Assign the qualitative interest tier for a group.

    declared > recurrent > casual > binge (TIER_ORDER). Declared dominates by
    design: temporal recurrence alone also crowns recurrent-UTILITY topics
    (password resets, dev tooling) — the explicit signal is what separates
    "recurrent because I care" from "recurrent because life makes me".
    Dwell is surfaced as evidence but does not gate tiers in this increment
    (weakest, noisiest signal).
    """
    if declared:
        return "declared"
    if n_pages >= RECURRENT_MIN_PAGES and (
        evidence["n_weeks"] >= RECURRENT_MIN_WEEKS
        or (
            evidence["n_weeks"] >= RECURRENT_ALT_WEEKS
            and evidence["span_days"] >= RECURRENT_ALT_SPAN_DAYS
        )
    ):
        return "recurrent"
    if evidence["n_days"] <= BINGE_MAX_DAYS and n_pages >= BINGE_MIN_PAGES:
        return "binge"
    return "casual"
