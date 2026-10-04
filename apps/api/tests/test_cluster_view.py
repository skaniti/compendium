"""Pure shaping for the Clusters dev view."""

from datetime import UTC, datetime

from backend.config.settings import settings
from backend.services import cluster_view as cv
from backend.services import clustering_service as cs


def test_edge_summary_empty():
    s = cv.edge_summary([])
    assert (s["count"], s["min"], s["max"], s["mean"]) == (0, None, None, None)
    assert len(s["bins"]) == 10 and all(b["count"] == 0 for b in s["bins"])
    assert s["bins"][0] == {"lo": 0.0, "hi": 0.1, "count": 0}
    assert s["bins"][9] == {"lo": 0.9, "hi": 1.0, "count": 0}


def test_edge_summary_bins_and_rounding():
    s = cv.edge_summary([0.15, 0.25, 0.2549, 1.0, 0.9])
    assert s["count"] == 5
    assert (s["min"], s["max"]) == (0.15, 1.0)
    assert s["mean"] == round((0.15 + 0.25 + 0.2549 + 1.0 + 0.9) / 5, 3)
    counts = [b["count"] for b in s["bins"]]
    assert counts == [0, 1, 2, 0, 0, 0, 0, 0, 0, 2]  # 1.0 lands in the last bin


def test_edge_summary_float4_boundaries():
    # REAL columns read back slightly under the stored value.
    s = cv.edge_summary([0.699999988079071, 0.30000001192092896, 0.19999998807907104])
    counts = [b["count"] for b in s["bins"]]
    assert counts[7] == 1 and counts[3] == 1 and counts[2] == 1
    assert s["min"] == 0.2 and s["max"] == 0.7


def test_run_row_rounds_real_columns():
    run = {
        "id": 7,
        "status": "completed",
        "started_at": datetime(2026, 1, 2, 3, 4, tzinfo=UTC),
        "completed_at": None,
        "cluster_count": 12,
        "noise_count": None,
        "naming_cost": 0.0008359499811194837,
        "elapsed_seconds": 8.420000076293945,
        "extra": "dropped",
    }
    row = cv.run_row(run, with_status=True)
    assert row == {
        "id": 7,
        "status": "completed",
        "started_at": run["started_at"],
        "completed_at": None,
        "cluster_count": 12,
        "noise_count": None,
        "naming_cost": 0.000836,
        "elapsed_seconds": 8.42,
    }
    assert "status" not in cv.run_row(run, with_status=False)


def test_effective_min_cluster_size(monkeypatch):
    monkeypatch.setattr(settings, "hdbscan_min_cluster_size", 2)
    assert cv.effective_min_cluster_size(None) is None
    assert cv.effective_min_cluster_size(100) == 2
    assert cv.effective_min_cluster_size(900) == 6


def test_build_config_keys_are_exact():
    c = cv.build_config(300)
    assert set(c) == {"clustering", "naming"}
    assert set(c["clustering"]) == {
        "embedding_model",
        "text_contract",
        "min_cluster_size",
        "min_cluster_size_divisor",
        "effective_min_cluster_size",
        "min_samples",
        "selection_method",
        "selection_epsilon",
        "metric",
        "umap_dims",
        "umap_n_neighbors",
        "edge_threshold",
        "max_edges_per_cluster",
    }
    assert set(c["naming"]) == {
        "model",
        "temperature",
        "max_tokens",
        "sample_size",
        "prompt_name",
        "prompt",
        "prompt_override",
    }


def test_build_config_naming_override_text_is_admin_only(monkeypatch):
    from backend.prompts import templates

    name = f"cluster_naming_{settings.cluster_naming_prompt_version}"
    monkeypatch.setattr(templates, "_load_overrides", lambda: {name: "OVERRIDE {n_pages}"})
    admin = cv.build_config(None, admin=True)["naming"]
    assert (admin["prompt"], admin["prompt_override"]) == ("OVERRIDE {n_pages}", "shown")
    other = cv.build_config(None)["naming"]
    assert other["prompt"] == templates.PROMPTS[name]["template"]
    assert other["prompt_override"] == "withheld"


def test_build_config_reads_the_pipeline_values():
    c = cv.build_config(None)
    assert c["clustering"]["effective_min_cluster_size"] is None
    assert c["clustering"]["edge_threshold"] == cs.SIMILARITY_THRESHOLD
    assert c["clustering"]["max_edges_per_cluster"] == cs.MAX_EDGES_PER_CLUSTER
    assert c["clustering"]["min_cluster_size_divisor"] == cs.MIN_CLUSTER_SIZE_DIVISOR
    assert c["naming"]["model"] == cs.NAMING_MODEL
    assert (c["naming"]["temperature"], c["naming"]["max_tokens"], c["naming"]["sample_size"]) == (
        cs.NAMING_TEMPERATURE,
        cs.NAMING_MAX_TOKENS,
        cs.NAMING_SAMPLE_SIZE,
    )
    assert c["naming"]["prompt_name"] == f"cluster_naming_{settings.cluster_naming_prompt_version}"
    assert isinstance(c["naming"]["prompt"], str) and "{n_pages}" in c["naming"]["prompt"]


def test_metric_follows_umap_dims(monkeypatch):
    monkeypatch.setattr(settings, "clustering_umap_dims", 0)
    assert cv.build_config(None)["clustering"]["metric"] == "cosine"
    monkeypatch.setattr(settings, "clustering_umap_dims", 5)
    assert cv.build_config(None)["clustering"]["metric"] == "euclidean"


def test_unknown_prompt_version_gives_none(monkeypatch):
    monkeypatch.setattr(settings, "cluster_naming_prompt_version", "zz-not-a-version")
    c = cv.build_config(None)
    assert c["naming"]["prompt_name"] == "cluster_naming_zz-not-a-version"
    assert c["naming"]["prompt"] is None
