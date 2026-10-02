"""Pure shaping for the Clusters dev view (no DB).

``edge_summary`` bins centroid-similarity edge weights; ``build_config`` lists
the clustering and naming parameters the pipeline actually uses. The config is
built field by field: ``settings`` also carries API keys, hosts and database
URLs, so it is never serialised wholesale.
"""

from __future__ import annotations

import math

from backend.config.settings import settings

RUN_HISTORY_LIMIT = 200
MEMBERS_LIMIT = 200
EDGE_BINS = 10
RUN_KEYS = (
    "id",
    "status",
    "started_at",
    "completed_at",
    "cluster_count",
    "noise_count",
    "naming_cost",
    "elapsed_seconds",
)


def run_row(run: dict, *, with_status: bool) -> dict:
    """A recluster run reduced to the view's keys; REAL columns rounded."""
    keys = RUN_KEYS if with_status else tuple(k for k in RUN_KEYS if k != "status")
    row = {k: run.get(k) for k in keys}
    if row.get("naming_cost") is not None:
        row["naming_cost"] = round(float(row["naming_cost"]), 6)
    if row.get("elapsed_seconds") is not None:
        row["elapsed_seconds"] = round(float(row["elapsed_seconds"]), 2)
    return row


def edge_summary(weights: list[float]) -> dict:
    bins = [
        {"lo": round(i / EDGE_BINS, 1), "hi": round((i + 1) / EDGE_BINS, 1), "count": 0}
        for i in range(EDGE_BINS)
    ]
    for w in weights:
        # Round first: weights are REAL (float4), so 0.7 reads back as 0.69999998.
        i = math.floor(round(w * EDGE_BINS, 6))
        bins[min(max(i, 0), EDGE_BINS - 1)]["count"] += 1  # 1.0 lands in the last bin
    if not weights:
        return {"count": 0, "min": None, "max": None, "mean": None, "bins": bins}
    return {
        "count": len(weights),
        "min": round(min(weights), 3),
        "max": round(max(weights), 3),
        "mean": round(sum(weights) / len(weights), 3),
        "bins": bins,
    }


def effective_min_cluster_size(considered: int | None) -> int | None:
    from backend.services.clustering_service import MIN_CLUSTER_SIZE_DIVISOR

    if considered is None:
        return None
    return max(settings.hdbscan_min_cluster_size, considered // MIN_CLUSTER_SIZE_DIVISOR)


def build_config(considered: int | None) -> dict:
    # Lazy: clustering_service pulls in the ML stack.
    from backend.prompts.templates import get_prompt_template
    from backend.services import clustering_service as cs

    prompt_name = f"cluster_naming_{settings.cluster_naming_prompt_version}"
    try:
        prompt: str | None = get_prompt_template(prompt_name)
    except KeyError:
        prompt = None
    return {
        "clustering": {
            "embedding_model": settings.clustering_embedding_model,
            "text_contract": settings.clustering_text_contract,
            "min_cluster_size": settings.hdbscan_min_cluster_size,
            "min_cluster_size_divisor": cs.MIN_CLUSTER_SIZE_DIVISOR,
            "effective_min_cluster_size": effective_min_cluster_size(considered),
            "min_samples": settings.hdbscan_min_samples,
            "selection_method": settings.hdbscan_selection_method,
            "selection_epsilon": settings.hdbscan_selection_epsilon,
            "metric": "euclidean" if settings.clustering_umap_dims > 0 else "cosine",
            "umap_dims": settings.clustering_umap_dims,
            "umap_n_neighbors": settings.clustering_umap_n_neighbors,
            "edge_threshold": cs.SIMILARITY_THRESHOLD,
            "max_edges_per_cluster": cs.MAX_EDGES_PER_CLUSTER,
        },
        "naming": {
            "model": cs.NAMING_MODEL,
            "temperature": cs.NAMING_TEMPERATURE,
            "max_tokens": cs.NAMING_MAX_TOKENS,
            "sample_size": cs.NAMING_SAMPLE_SIZE,
            "prompt_name": prompt_name,
            "prompt": prompt,
        },
    }
