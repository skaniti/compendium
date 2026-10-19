"""HDBSCAN min cluster size: n // 150, floored by the setting, capped by the cap setting."""
import pytest

from backend.config.settings import Settings, settings
from backend.services import clustering_service as cs


@pytest.fixture
def knobs(monkeypatch):
    def set_(floor=2, cap=25):
        monkeypatch.setattr(settings, "hdbscan_min_cluster_size", floor)
        monkeypatch.setattr(settings, "hdbscan_min_cluster_size_cap", cap)

    return set_


@pytest.mark.parametrize("n,expected", [(0, 2), (100, 2), (300, 2), (1_000, 6), (1_500, 10), (3_750, 25)])
def test_small_corpora_unchanged_by_default_cap(knobs, n, expected):
    knobs()
    assert cs.min_cluster_size_for(n) == expected == max(2, n // 150)


@pytest.mark.parametrize("n", [3_900, 10_000, 50_000, 1_000_000])
def test_large_corpora_are_capped(knobs, n):
    knobs()
    assert cs.min_cluster_size_for(n) == 25


def test_cap_zero_disables_cap(knobs):
    knobs(cap=0)
    assert cs.min_cluster_size_for(50_000) == 333


def test_floor_wins_over_a_smaller_cap(knobs):
    knobs(floor=40, cap=25)
    assert cs.min_cluster_size_for(50_000) == 40


def test_default_cap_is_25():
    assert Settings(_env_file=None).hdbscan_min_cluster_size_cap == 25


def test_env_override(monkeypatch):
    monkeypatch.setenv("HDBSCAN_MIN_CLUSTER_SIZE_CAP", "12")
    assert Settings(_env_file=None).hdbscan_min_cluster_size_cap == 12


def test_run_hdbscan_uses_the_helper(knobs, monkeypatch):
    """The fit receives the capped size (small synthetic blobs, UMAP off)."""
    import numpy as np

    knobs(cap=3)
    monkeypatch.setattr(settings, "clustering_umap_dims", 0)
    seen = {}

    class FakeHDBSCAN:
        def __init__(self, **kw):
            seen.update(kw)

        def fit(self, x):
            self.labels_ = np.zeros(len(x), dtype=int)
            self.probabilities_ = np.ones(len(x))

    monkeypatch.setattr(cs, "HDBSCAN", FakeHDBSCAN)
    rng = np.random.default_rng(0)
    emb = rng.normal(size=(1_500, 4)).astype(np.float32)
    try:
        cs.ClusteringService(user_id=0)._run_hdbscan(emb)
    except Exception:
        pass  # only the constructor arguments matter here
    assert seen["min_cluster_size"] == 3
