"""Drive the production clustering code offline and score the partition.

One run = load pages -> ``ClusteringService._filter_clusterable_pages`` -> embeddings
-> ``ClusteringService._run_hdbscan`` -> structure metrics + guard sets + label scores
-> a JSON run record. Two page sources:

- ``export``: an :class:`~evaluation.clustering.export_loader.ExportSnapshot`. Pages
  come from the export's tables and embeddings from its cache tables; a page whose
  vector is not cached is dropped (counted as ``missing_embeddings``) -- the harness
  never calls the embedding API in this mode, so it runs with no keys and no DB.
- ``db``: the configured database, through the same ``ClusteringService`` methods the
  nightly job uses. ``_compute_embeddings`` may fill the embedding cache (and record a
  cost event) for pages not yet embedded, exactly as the nightly run would; nothing
  else is written.

Settings are overridden in-process for the run (``clustering_embedding_model``,
``clustering_text_contract``, ``clustering_umap_dims`` ...) and restored afterwards.
"""

from __future__ import annotations

import logging
import time
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import numpy as np

from evaluation.clustering import scoring
from evaluation.clustering.export_loader import ExportSnapshot

logger = logging.getLogger(__name__)

KNOB_SETTINGS = {
    "model": "clustering_embedding_model",
    "text_contract": "clustering_text_contract",
    "umap_dims": "clustering_umap_dims",
    "umap_neighbors": "clustering_umap_n_neighbors",
    "min_cluster_size": "hdbscan_min_cluster_size",
    "min_samples": "hdbscan_min_samples",
    "selection_method": "hdbscan_selection_method",
    "selection_epsilon": "hdbscan_selection_epsilon",
}
"""CLI knob name -> ``backend.config.settings`` attribute it overrides for the run."""

RECORD_VERSION = 1


@contextmanager
def settings_overrides(overrides: dict[str, object]) -> Iterator[None]:
    """Temporarily set ``settings.<attr>`` for each knob in ``overrides`` (None = leave)."""
    from backend.config.settings import settings

    saved: dict[str, object] = {}
    try:
        for knob, value in overrides.items():
            if value is None:
                continue
            attr = KNOB_SETTINGS[knob]
            saved[attr] = getattr(settings, attr)
            setattr(settings, attr, value)
        yield
    finally:
        for attr, value in saved.items():
            setattr(settings, attr, value)


def config_snapshot(n_pages: int) -> dict:
    """The clustering settings that determine a partition, as recorded in a run."""
    from backend.config.settings import settings
    from backend.services.clustering_service import MIN_CLUSTER_SIZE_DIVISOR

    return {
        "embedding_model": settings.clustering_embedding_model,
        "text_contract": settings.clustering_text_contract,
        "model_key": model_key_for(settings),
        "min_cluster_size_floor": settings.hdbscan_min_cluster_size,
        "effective_min_cluster_size": max(
            settings.hdbscan_min_cluster_size, n_pages // MIN_CLUSTER_SIZE_DIVISOR
        ),
        "min_samples": settings.hdbscan_min_samples,
        "selection_method": settings.hdbscan_selection_method,
        "selection_epsilon": settings.hdbscan_selection_epsilon,
        "umap_dims": settings.clustering_umap_dims,
        "umap_n_neighbors": settings.clustering_umap_n_neighbors,
    }


def model_key_for(settings) -> str:
    """Cache key the service uses: ``<model>@<contract>`` for API models, else the model."""
    model = settings.clustering_embedding_model
    if model.startswith("text-embedding-"):
        return f"{model}@{settings.clustering_text_contract}"
    return model


# ── metrics ──────────────────────────────────────────────────────────────


def structure_metrics(labels: np.ndarray, embeddings: np.ndarray | None = None) -> dict:
    """Label-free partition shape: counts, noise, sizes, cosine silhouette."""
    n = len(labels)
    cluster_ids = sorted({int(c) for c in labels if c != -1})
    sizes = sorted((int((labels == cid).sum()) for cid in cluster_ids), reverse=True)
    noise = int((labels == -1).sum())
    clustered = n - noise
    metrics = {
        "n_pages": n,
        "n_clusters": len(cluster_ids),
        "noise_count": noise,
        "noise_pct": round(noise / n * 100, 1) if n else 0.0,
        "size_median": float(np.median(sizes)) if sizes else 0.0,
        "size_max": sizes[0] if sizes else 0,
        "pct_in_largest": round(sizes[0] / clustered * 100, 1) if sizes and clustered else 0.0,
        "n_2page_shards": sum(1 for s in sizes if s == 2),
        "silhouette_cosine": None,
    }
    if embeddings is not None and len(cluster_ids) >= 2 and clustered > len(cluster_ids):
        from sklearn.metrics import silhouette_score

        mask = labels != -1
        metrics["silhouette_cosine"] = round(
            float(silhouette_score(embeddings[mask], labels[mask], metric="cosine")), 4
        )
    return metrics


def guard_set_metrics(assign: dict[int, int], guard_sets: list[dict]) -> list[dict]:
    """Modal-cluster share per named page-id set that should stay co-clustered.

    A page absent from the partition or in noise counts against its set (the set only
    scores well when its pages are co-clustered somewhere). Same definition as the
    predecessor harness so historical guard numbers stay comparable.
    """
    results = []
    for gs in guard_sets:
        page_ids = [int(p) for p in gs.get("page_ids", [])]
        landed = []
        absent_or_noise = 0
        for pid in page_ids:
            lbl = assign.get(pid)
            if lbl is None or lbl == -1:
                absent_or_noise += 1
            else:
                landed.append(lbl)
        counts = Counter(landed)
        modal = max(counts.values()) if counts else 0
        n = len(page_ids)
        results.append(
            {
                "name": gs.get("name"),
                "n_pages": n,
                "modal_cluster_share": round(modal / n * 100, 1) if n else 0.0,
                "n_absent_or_noise": absent_or_noise,
            }
        )
    return results


def load_guard_sets(path: str | Path | None) -> list[dict]:
    """``{"guard_sets": [{"name", "page_ids"}]}`` from a private JSON file; [] when None."""
    if not path:
        return []
    import json

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return list(data.get("guard_sets", []))


# ── the run ──────────────────────────────────────────────────────────────


def _embeddings_from_cache(
    pages: list[dict], cache: dict[int, list[float]]
) -> tuple[list[dict], np.ndarray, int]:
    """Matrix for the pages whose content id has a cached vector; drops the others."""
    kept: list[dict] = []
    vectors: list[list[float]] = []
    for page in pages:
        cid = page.get("page_content_id")
        vec = cache.get(cid) if cid is not None else None
        if vec is None:
            continue
        kept.append(page)
        vectors.append(vec)
    if not vectors:
        return kept, np.empty((0, 0)), len(pages)
    matrix = np.asarray(vectors, dtype=np.float64)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return kept, matrix / norms, len(pages) - len(kept)


def run_clustering(
    *,
    source: str,
    user_id: int,
    snapshot: ExportSnapshot | None = None,
    knobs: dict[str, object] | None = None,
    as_of: str | None = None,
) -> dict:
    """Load, filter, embed and cluster; returns pages, labels, embeddings and stats.

    Pure computation (no record writing). ``source`` is ``"export"`` (needs
    ``snapshot``) or ``"db"``. ``as_of`` restricts an export to pages created up to
    that instant (see :meth:`ExportSnapshot.active_page_rows`).
    """
    from backend.services.clustering_service import ClusteringService

    with settings_overrides(knobs or {}):
        from backend.config.settings import settings

        svc = ClusteringService(user_id=user_id)
        t0 = time.perf_counter()
        if source == "export":
            if snapshot is None:
                raise ValueError("source='export' needs a snapshot")
            rows = snapshot.active_page_rows(user_id, as_of=as_of)
            all_pages = svc._pages_from_rows(rows)
        elif source == "db":
            all_pages = svc._load_all_pages(user_id)
        else:
            raise ValueError(f"unknown source {source!r}")

        pages, filter_stats = svc._filter_clusterable_pages(all_pages)
        missing_embeddings = 0
        if source == "export":
            cache = snapshot.embeddings(model_key_for(settings))
            pages, embeddings, missing_embeddings = _embeddings_from_cache(pages, cache)
            if missing_embeddings:
                logger.warning(
                    "%d clusterable page(s) have no cached %s vector in the export; dropped",
                    missing_embeddings,
                    model_key_for(settings),
                )
        else:
            embeddings = svc._compute_embeddings(pages)

        if len(pages) >= 2 and embeddings.size:
            labels, _outliers, _probs = svc._run_hdbscan(embeddings)
        else:
            labels = np.full(len(pages), -1)
        elapsed = time.perf_counter() - t0
        config = config_snapshot(len(pages))

    return {
        "pages": pages,
        "labels": np.asarray(labels),
        "embeddings": embeddings,
        "filter_stats": filter_stats,
        "n_loaded": len(all_pages),
        "missing_embeddings": missing_embeddings,
        "elapsed_seconds": round(elapsed, 2),
        "config": config,
        "as_of": as_of,
    }


def stability_trials(
    embeddings: np.ndarray,
    labels: np.ndarray,
    knobs: dict[str, object] | None,
    user_id: int,
    trials: int,
    seed: int = 0,
) -> dict | None:
    """Leave-one-out sensitivity: recluster with one page removed, ``trials`` times.

    Reports the membership ARI between each perturbed partition and the full one on
    the common pages (all pages, noise = its own label; and clustered-in-both only).
    A pipeline whose partition reshuffles when one page changes cannot be reproduced
    exactly across nights, and its score deltas below that noise floor mean nothing.
    """
    if trials <= 0 or len(labels) < 3:
        return None
    from sklearn.metrics import adjusted_rand_score

    from backend.services.clustering_service import ClusteringService

    rng = np.random.default_rng(seed)
    drop = rng.choice(len(labels), size=min(trials, len(labels)), replace=False)
    ari_all: list[float] = []
    ari_clustered: list[float] = []
    with settings_overrides(knobs or {}):
        svc = ClusteringService(user_id=user_id)
        for idx in drop:
            keep = np.ones(len(labels), dtype=bool)
            keep[idx] = False
            perturbed, _o, _p = svc._run_hdbscan(embeddings[keep])
            base = labels[keep]
            ari_all.append(float(adjusted_rand_score(base, perturbed)))
            both = (base != -1) & (perturbed != -1)
            if both.sum() >= 2:
                ari_clustered.append(float(adjusted_rand_score(base[both], perturbed[both])))
    return {
        "trials": len(drop),
        "mean_ari_all": round(float(np.mean(ari_all)), 3),
        "min_ari_all": round(float(np.min(ari_all)), 3),
        "mean_ari_clustered_both": (
            round(float(np.mean(ari_clustered)), 3) if ari_clustered else None
        ),
    }


def build_record(
    *,
    label: str,
    source: dict,
    result: dict,
    ann: dict[int, dict] | None,
    guard_sets: list[dict],
    with_titles: bool = False,
) -> dict:
    """Assemble the JSON-serialisable run record from :func:`run_clustering` output."""
    pages = result["pages"]
    labels = result["labels"]
    assign = {int(pages[i]["db_id"]): int(labels[i]) for i in range(len(pages))}
    clusters = []
    for cid in sorted({int(c) for c in labels if c != -1}):
        idxs = [i for i in range(len(pages)) if int(labels[i]) == cid]
        entry = {
            "cluster": cid,
            "size": len(idxs),
            "page_ids": [int(pages[i]["db_id"]) for i in idxs],
        }
        if with_titles:
            entry["titles"] = [pages[i].get("title") for i in idxs]
        clusters.append(entry)
    clusters.sort(key=lambda c: -c["size"])
    record = {
        "record_version": RECORD_VERSION,
        "label": label,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": source,
        "config": result["config"],
        "filter_stats": result["filter_stats"],
        "n_loaded": result["n_loaded"],
        "missing_embeddings": result["missing_embeddings"],
        "as_of": result.get("as_of"),
        "elapsed_seconds": result["elapsed_seconds"],
        "metrics": structure_metrics(labels, result.get("embeddings")),
        "scores": scoring.score_all(assign, ann) if ann is not None else None,
        "guard_sets": guard_set_metrics(assign, guard_sets),
        "assignments": {str(k): v for k, v in assign.items()},
        "clusters": clusters,
    }
    return record


def score_stored_run(
    snapshot: ExportSnapshot,
    run_id: int,
    universe: list[int],
    ann: dict[int, dict] | None,
    guard_sets: list[dict],
) -> dict:
    """Score a stored production run on ``universe`` (page ids; unassigned -> noise).

    This is the baseline side of the identity check: the stored run and a fresh
    harness run are scored on the same page set, so differences come from the
    partition, not from which pages were counted.
    """
    stored = snapshot.run_assignments(run_id)
    assign = {int(pid): stored.get(int(pid), -1) for pid in universe}
    labels = np.asarray([assign[pid] for pid in universe]) if universe else np.empty(0)
    return {
        "record_version": RECORD_VERSION,
        "label": f"stored-run-{run_id}",
        "source": {"kind": "export-run", "path": str(snapshot.export_dir), "run_id": run_id},
        "n_assigned_in_export": sum(1 for v in stored.values() if v != -1),
        "metrics": structure_metrics(labels),
        "scores": scoring.score_all(assign, ann) if ann is not None else None,
        "guard_sets": guard_set_metrics(assign, guard_sets),
        "assignments": {str(k): v for k, v in assign.items()},
    }
