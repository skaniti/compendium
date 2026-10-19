"""Production HDBSCAN pipeline ("prod parity") as a benchmark candidate.

Calls the real ``ClusteringService._run_hdbscan`` (UMAP -> sklearn HDBSCAN) under
``harness.settings_overrides``. Superclusters: the hybrid-mode geometry of
``super_cluster_service.assign_super_clusters_hybrid`` with zero typed keywords, minus its
DB/LLM parts (see ``supercluster_geometry``).
"""

from __future__ import annotations

import time

import numpy as np

PROD_KNOBS = {
    "model": "text-embedding-3-small",
    "umap_dims": 10,
    "umap_neighbors": 15,
    "min_samples": 3,
    "selection_method": "eom",
    "min_cluster_size": 2,
    "selection_epsilon": 0.0,
}


def supercluster_geometry(labels: np.ndarray, emb: np.ndarray, group_threshold: float | None = None,
                          singleton_threshold: float | None = None) -> dict[int, int]:
    """cluster id -> supercluster id.

    Same steps as ``assign_super_clusters_hybrid`` with no keywords: L2-normalised cluster
    centroids in the original embedding space -> ``supercluster_discovery.discover_groups``
    (average-linkage cosine cut, ``supercluster_group_threshold``) -> singleton collapse
    (``_collapse_singleton_groups``: a one-cluster group folds into the nearest multi-cluster
    group when centroid cosine distance <= ``supercluster_singleton_merge_threshold``; distances
    against pre-collapse target centroids). The production singleton pass lives inside a
    DB/LLM-coupled function, so it is re-implemented here (no exclusions / same-label guards,
    which only apply to keyword groups).
    """
    from backend.config.settings import settings
    from backend.services import supercluster_discovery as sd

    gt = settings.supercluster_group_threshold if group_threshold is None else group_threshold
    st = (settings.supercluster_singleton_merge_threshold
          if singleton_threshold is None else singleton_threshold)
    cids = sorted(int(c) for c in np.unique(labels[labels != -1]))
    if not cids:
        return {}
    cents = np.vstack([emb[labels == c].mean(axis=0) for c in cids])
    norms = np.linalg.norm(cents, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    cents = cents / norms
    gl = sd.discover_groups(cents, distance_threshold=gt)
    members: dict[int, list[int]] = {}
    for i, g in enumerate(gl):
        members.setdefault(int(g), []).append(i)
    if st > 0:
        def cen(idx):
            m = cents[idx].mean(axis=0)
            nm = np.linalg.norm(m)
            return m / nm if nm > 0 else m
        targets = {g: cen(ix) for g, ix in members.items() if len(ix) >= 2}
        if targets:
            tg = list(targets)
            tm = np.vstack([targets[g] for g in tg])
            for g, ix in list(members.items()):
                if len(ix) != 1:
                    continue
                d = 1.0 - tm @ cen(ix)
                j = int(np.argmin(d))
                if d[j] <= st:
                    members[tg[j]] = members[tg[j]] + ix
                    del members[g]
    out = {}
    for new, (g, ix) in enumerate(sorted(members.items())):
        for i in ix:
            out[cids[i]] = new
    return out


def run_hdbscan_prod(ids: list[int], emb: np.ndarray) -> dict:
    from backend.services.clustering_service import ClusteringService, min_cluster_size_for
    from evaluation.clustering.harness import settings_overrides

    emb = np.asarray(emb, dtype=np.float32)
    n = len(ids)
    svc = ClusteringService(user_id=0)  # __init__ only builds LLM clients if keys exist; no DB
    timing: dict[str, float] = {}
    orig = ClusteringService._reduce_embeddings

    def timed(e, k):
        t = time.perf_counter()
        r = orig(e, k)
        timing["umap_s"] = time.perf_counter() - t
        return r

    with settings_overrides(PROD_KNOBS):
        from backend.config.settings import settings
        floor = settings.hdbscan_min_cluster_size
        eff_min_size = min_cluster_size_for(n)
        ClusteringService._reduce_embeddings = staticmethod(timed)
        t0 = time.perf_counter()
        try:
            labels, _, _ = svc._run_hdbscan(emb)
        finally:
            ClusteringService._reduce_embeddings = staticmethod(orig)
        total = time.perf_counter() - t0
    labels = np.asarray(labels)
    timing["hdbscan_s"] = total - timing.get("umap_s", 0.0)
    sup = supercluster_geometry(labels, emb)
    assign = {int(i): int(c) for i, c in zip(ids, labels)}
    super_ = {int(i): (sup[int(c)] if c != -1 else -1) for i, c in zip(ids, labels)}
    return {
        "assign": assign,
        "super": super_,
        "meta": {
            "min_cluster_size": eff_min_size,
            "min_cluster_size_floor": floor,
            "n_clusters": int(len(set(labels.tolist()) - {-1})),
            "n_noise": int((labels == -1).sum()),
            "n_super": len(set(sup.values())),
            "umap_seconds": round(timing.get("umap_s", 0.0), 2),
            "hdbscan_seconds": round(timing["hdbscan_s"], 2),
            "knobs": PROD_KNOBS,
        },
    }
