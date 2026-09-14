"""Unit tests for increment 2 of the clustering rethink: UMAP reduction branch
and exposed HDBSCAN knobs (min_samples / selection method / selection epsilon).
See the 2026-07-08 clustering-supercluster-rethink plan (private),
plan-increment-2.md.
"""

import numpy as np
import pytest

from backend.config.settings import settings
from backend.services.clustering_service import ClusteringService


def _blob_embeddings(n_per=20, dim=32, seed=7):
    """Three well-separated gaussian blobs, unit-normalized."""
    rng = np.random.default_rng(seed)
    centers = np.eye(3, dim) * 10
    pts = np.vstack([rng.normal(c, 0.3, size=(n_per, dim)) for c in centers])
    return pts / np.linalg.norm(pts, axis=1, keepdims=True)


def test_default_settings_skip_reduction(monkeypatch):
    """With clustering_umap_dims=0 (the code default), the UMAP helper must
    not run. The setting is forced rather than asserted — the ambient .env
    sets CLUSTERING_UMAP_DIMS=10 for prod parity, and this test's subject is
    the dims=0 branch, not the environment."""
    monkeypatch.setattr(settings, "clustering_umap_dims", 0)

    def _boom(embeddings, n_components):
        raise AssertionError("reduction must not run at default settings")

    monkeypatch.setattr(ClusteringService, "_reduce_embeddings", staticmethod(_boom))
    svc = ClusteringService(user_id=1)
    labels, scores, _probs = svc._run_hdbscan(_blob_embeddings())
    assert len(labels) == 60
    assert len(set(labels[labels != -1])) >= 2


def test_knobs_are_plumbed_through(monkeypatch):
    """min_samples / selection method / epsilon reach the HDBSCAN constructor."""
    captured = {}

    class FakeHDBSCAN:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def fit(self, X):
            self.labels_ = np.full(len(X), -1)
            return self

    monkeypatch.setattr(
        "backend.services.clustering_service.HDBSCAN", FakeHDBSCAN
    )
    monkeypatch.setattr(settings, "clustering_umap_dims", 0)  # legacy branch
    monkeypatch.setattr(settings, "hdbscan_min_samples", 5)
    monkeypatch.setattr(settings, "hdbscan_selection_method", "leaf")
    monkeypatch.setattr(settings, "hdbscan_selection_epsilon", 0.25)

    svc = ClusteringService(user_id=1)
    svc._run_hdbscan(_blob_embeddings())

    assert captured["min_samples"] == 5
    assert captured["cluster_selection_method"] == "leaf"
    assert captured["cluster_selection_epsilon"] == 0.25
    assert captured["metric"] == "precomputed"  # umap off -> legacy metric


def test_umap_branch_clusters_and_is_deterministic(monkeypatch):
    """dims>0 -> euclidean-on-reduced; blobs recovered; repeat run identical.

    Selection knobs are pinned to the code defaults (eom etc.) — the ambient
    .env runs leaf selection for prod parity, which legitimately shatters
    the three planted blobs into fine leaves and is not this test's subject.
    """
    monkeypatch.setattr(settings, "clustering_umap_dims", 5)
    monkeypatch.setattr(settings, "clustering_umap_n_neighbors", 10)
    monkeypatch.setattr(settings, "hdbscan_selection_method", "eom")
    monkeypatch.setattr(settings, "hdbscan_selection_epsilon", 0.0)
    monkeypatch.setattr(settings, "hdbscan_min_samples", 2)

    emb = _blob_embeddings()
    svc = ClusteringService(user_id=1)
    labels1, scores1, _probs1 = svc._run_hdbscan(emb)
    labels2, _scores2, _probs2 = svc._run_hdbscan(emb)

    assert len(labels1) == 60
    # three planted blobs should be recoverable in reduced space
    assert len(set(labels1[labels1 != -1])) == 3
    # random_state pins UMAP -> identical partitions run-to-run
    np.testing.assert_array_equal(labels1, labels2)
    # outlier scores computed in the ORIGINAL space: finite, right length
    assert len(scores1) == 60
    assert np.isfinite(scores1).all()


def test_umap_n_neighbors_clamped_for_tiny_corpus(monkeypatch):
    """n_neighbors must clamp below n_samples (UMAP hard requirement)."""
    monkeypatch.setattr(settings, "clustering_umap_dims", 2)
    monkeypatch.setattr(settings, "clustering_umap_n_neighbors", 50)

    emb = _blob_embeddings(n_per=4)  # 12 points < 50 neighbors
    svc = ClusteringService(user_id=1)
    labels, _scores, _probs = svc._run_hdbscan(emb)
    assert len(labels) == 12  # no crash; clamp worked
