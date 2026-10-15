"""Tests for the offline clustering eval harness (``evaluation/clustering``).

Everything here is synthetic: a tiny table export written to ``tmp_path``, invented
labels and topic map. The private labelled dataset is never a fixture.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np
import pytest

from backend.config.settings import settings
from backend.services.clustering_service import ClusteringService
from evaluation.clustering import cluster_eval, harness, scoring
from evaluation.clustering.export_loader import ExportSnapshot

USER = 7
OTHER_USER = 8
MODEL = "text-embedding-3-small"
CONTRACT = "ctv2"
DIM = 8


# ── synthetic export ─────────────────────────────────────────────────────


def _write_table(export_dir: Path, name: str, rows: list[dict]) -> None:
    with gzip.open(export_dir / f"{name}.jsonl.gz", "wt", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")


def _vec(axis: int, jitter: float, rng) -> list[float]:
    v = rng.normal(0, jitter, DIM)
    v[axis] += 10.0
    return [float(x) for x in v]


def make_export(export_dir: Path, *, n_per_topic: int = 6, with_run: bool = True) -> dict:
    """Three separable topics (A, B, C), one page per content row, plus noise cases.

    Returns the page ids per topic so tests can build labels from them.
    """
    export_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(0)
    captures = [
        {"id": 1, "user_id": USER, "capture_id": "cap_synthetic_1"},
        {"id": 2, "user_id": OTHER_USER, "capture_id": "cap_synthetic_other"},
    ]
    pages, content, embeddings = [], [], []
    topics: dict[str, list[int]] = {"A": [], "B": [], "C": []}
    pid = 100
    cid = 500
    for axis, topic in enumerate("ABC"):
        for i in range(n_per_topic):
            pid += 1
            cid += 1
            topics[topic].append(pid)
            content.append(
                {
                    "id": cid,
                    "url": f"https://{topic.lower()}.example.test/page-{i}",
                    "normalized_url": f"https://{topic.lower()}.example.test/page-{i}",
                    "extracted_text": f"synthetic text about topic {topic} number {i} " * 20,
                    "fetched_content": {"text": f"synthetic topic {topic} {i}"},
                    "content_summary": f"Synthetic summary {topic} {i}",
                    "tool_selected": None,
                    "is_learning": True,
                }
            )
            pages.append(
                {
                    "id": pid,
                    "capture_id": 1,
                    "user_id": USER,
                    "page_content_id": cid,
                    "url": f"https://{topic.lower()}.example.test/page-{i}",
                    "normalized_url": f"https://{topic.lower()}.example.test/page-{i}",
                    "title": f"Synthetic page {topic} {i}",
                    "domain": f"{topic.lower()}.example.test",
                    "visited_at": f"2026-01-0{axis + 1}T10:{i:02d}:00+00:00",
                    "status": "active",
                    "human_status": None,
                    "content_summary": f"Synthetic summary {topic} {i}",
                }
            )
            embeddings.append(
                {
                    "page_content_id": cid,
                    "model_key": f"{MODEL}@{CONTRACT}",
                    "dim": DIM,
                    "embedding": "[" + ",".join(f"{x:.6f}" for x in _vec(axis, 0.05, rng)) + "]",
                }
            )
    # An archived page (must be ignored), a human-reactivated one (must be included),
    # and a page of another user (must be ignored).
    pages.append({**pages[0], "id": 900, "status": "archived", "human_status": None})
    pages.append({**pages[1], "id": 901, "status": "archived", "human_status": "active"})
    pages.append({**pages[2], "id": 902, "capture_id": 2, "user_id": OTHER_USER})
    # A clusterable page without a cached vector: dropped and counted.
    pages.append(
        {
            **pages[3],
            "id": 903,
            "page_content_id": 999,
            "url": "https://a.example.test/uncached",
            "normalized_url": "https://a.example.test/uncached",
            "title": "Synthetic page without a cached vector",
            "content_summary": "Synthetic summary for the uncached page",
        }
    )
    content.append(
        {
            **content[3],
            "id": 999,
            "url": "https://a.example.test/uncached",
            "normalized_url": "https://a.example.test/uncached",
            "extracted_text": "synthetic text that no other page shares " * 20,
            "content_summary": "Synthetic summary for the uncached page",
        }
    )

    _write_table(export_dir, "captures", captures)
    _write_table(export_dir, "pages", pages)
    _write_table(export_dir, "page_content", content)
    _write_table(export_dir, "clustering_embeddings", embeddings)
    _write_table(export_dir, "page_embeddings", [])
    if with_run:
        # A stored run that puts topics A and B into one cluster and C into another.
        _write_table(
            export_dir, "recluster_runs", [{"id": 42, "user_id": USER, "status": "completed"}]
        )
        _write_table(
            export_dir,
            "clusters",
            [{"id": 1000, "recluster_run": 42}, {"id": 1001, "recluster_run": 42}],
        )
        _write_table(
            export_dir,
            "page_clusters",
            [{"page_id": p, "cluster_id": 1000} for p in topics["A"] + topics["B"]]
            + [{"page_id": p, "cluster_id": 1001} for p in topics["C"][:-1]],
        )
        _write_table(
            export_dir, "featured_singletons", [{"page_id": topics["C"][-1], "recluster_run": 42}]
        )
    # One truncated line, as a redacted export can contain.
    with gzip.open(export_dir / "pages.jsonl.gz", "at", encoding="utf-8") as fh:
        fh.write('{"id": 904, "url": "https://trunc')
    return topics


def make_labels(labels_dir: Path, topics: dict[str, list[int]]) -> tuple[Path, Path]:
    """Annotations: topic A/B are two shelves of one category, C another; C's last is 'keep'."""
    labels_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for topic, ids in topics.items():
        category = "science_nature" if topic in "AB" else "games_gaming"
        for i, pid in enumerate(ids):
            rows.append(
                {
                    "page_id": pid,
                    "category": category,
                    "subtopic": f"shelf {topic}",
                    "knowledge_value": "keep" if i % 2 == 0 else "marginal",
                }
            )
    # Labels for pages the harness never sees must be harmless.
    rows.append(
        {
            "page_id": 900,
            "category": "games_gaming",
            "subtopic": "shelf C",
            "knowledge_value": "keep",
        }
    )
    labels = labels_dir / "labels.jsonl"
    labels.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    topic_map = labels_dir / "topic_map.json"
    topic_map.write_text(
        json.dumps(
            {
                "science_nature||shelf A": "shelf_a",
                "science_nature||shelf B": "shelf_b",
                "games_gaming||shelf C": "shelf_c",
            }
        ),
        encoding="utf-8",
    )
    return labels, topic_map


@pytest.fixture
def export(tmp_path):
    topics = make_export(tmp_path / "export")
    labels, topic_map = make_labels(tmp_path / "labels", topics)
    return {
        "dir": tmp_path / "export",
        "topics": topics,
        "labels": labels,
        "topic_map": topic_map,
        "out": tmp_path / "runs",
    }


@pytest.fixture
def prod_like_knobs(monkeypatch):
    """Full-dimensional HDBSCAN on the synthetic vectors (no UMAP: 18 points)."""
    monkeypatch.setattr(settings, "clustering_embedding_model", MODEL)
    monkeypatch.setattr(settings, "clustering_text_contract", CONTRACT)
    monkeypatch.setattr(settings, "clustering_umap_dims", 0)
    monkeypatch.setattr(settings, "hdbscan_min_cluster_size", 3)
    monkeypatch.setattr(settings, "hdbscan_min_samples", 2)
    monkeypatch.setattr(settings, "hdbscan_selection_method", "eom")
    monkeypatch.setattr(settings, "hdbscan_selection_epsilon", 0.0)


# ── scoring ──────────────────────────────────────────────────────────────


def test_score_hand_computed_values():
    ann = {
        1: {
            "category": "science_nature",
            "subtopic": "x",
            "topic_key": "t1",
            "knowledge_value": "keep",
        },
        2: {
            "category": "science_nature",
            "subtopic": "x",
            "topic_key": "t1",
            "knowledge_value": "keep",
        },
        3: {
            "category": "science_nature",
            "subtopic": "y",
            "topic_key": "t2",
            "knowledge_value": "marginal",
        },
        4: {
            "category": "science_nature",
            "subtopic": "y",
            "topic_key": "t2",
            "knowledge_value": "keep",
        },
        5: {
            "category": "science_nature",
            "subtopic": "y",
            "topic_key": "t2",
            "knowledge_value": "keep",
        },
        6: {
            "category": "science_nature",
            "subtopic": "z",
            "topic_key": None,
            "knowledge_value": "keep",
        },
    }
    # cluster 0 = {1,2,3} (majority t1: 2 of 3), cluster 1 = {4}, page 5 noise, page 6 unlabelled
    assign = {1: 0, 2: 0, 3: 0, 4: 1, 5: -1, 6: 0}
    s = scoring.score(assign, ann, key="topic_key")
    assert s["n_pages"] == 5 and s["n_clustered"] == 4
    assert s["purity"] == round(3 / 4, 3)  # (2 + 1) / 4
    assert s["inverse_purity"] == round(3 / 4, 3)  # t1: 2 in c0; t2: max(1 in c0, 1 in c1) = 1
    assert s["share_clusters_purity_lt_0.6"] == 0.0
    assert s["keep_coverage"] == round(3 / 4, 3)  # keep pages 1,2,4,5; 5 is noise
    assert s["noise_share"] == round(1 / 5, 3)
    assert s["n_clusters"] == 2 and s["size_max"] == 3
    assert -1.0 <= s["ARI"] <= 1.0 and 0.0 <= s["NMI"] <= 1.0
    assert s["ARI_all"] <= 1.0


def test_score_perfect_partition_is_one():
    ann = {
        i: {"category": "c", "subtopic": "s", "topic_key": f"t{i % 2}", "knowledge_value": "keep"}
        for i in range(10)
    }
    assign = {i: i % 2 for i in range(10)}
    s = scoring.score(assign, ann)
    assert s["purity"] == 1.0 and s["ARI"] == 1.0 and s["NMI"] == 1.0
    assert s["ARI_all"] == 1.0 and s["keep_coverage"] == 1.0


def test_score_all_noise_short_circuits():
    ann = {1: {"category": "c", "subtopic": "s", "topic_key": "t", "knowledge_value": "keep"}}
    assert scoring.score({1: -1}, ann) == {"key": "topic_key", "n_pages": 1, "n_clustered": 0}


def test_load_annotations_resolves_topic_key_and_group(tmp_path):
    topics = {"A": [1], "C": [2]}
    labels, topic_map = make_labels(tmp_path, topics)
    ann = scoring.load_annotations(labels, topic_map=topic_map)
    assert ann[1]["topic_key"] == "shelf_a" and ann[1]["category_group"] == "science"
    assert ann[2]["topic_key"] == "shelf_c" and ann[2]["category_group"] == "games"
    assert ann[900]["topic_key"] == "shelf_c"


def test_compare_scores_gate():
    base = {"purity": 0.6, "ARI": 0.4, "noise_share": 0.2, "keep_coverage": 0.7}
    better = {"purity": 0.7, "ARI": 0.4, "noise_share": 0.1, "keep_coverage": 0.7}
    worse = {"purity": 0.55, "ARI": 0.4, "noise_share": 0.2, "keep_coverage": 0.7}
    _, ok = scoring.compare_scores(base, better)
    assert ok
    rows, ok = scoring.compare_scores(base, worse)
    assert not ok
    assert next(r for r in rows if r["metric"] == "purity")["ok"] is False
    _, ok = scoring.compare_scores(base, worse, tolerance=0.05)
    assert ok
    rows, ok = scoring.compare_scores(base, {"purity": 0.6, "noise_share": 0.5})
    assert not ok and next(r for r in rows if r["metric"] == "ARI")["delta"] is None


# ── export loader ────────────────────────────────────────────────────────


def test_export_rows_match_get_active_pages_contract(export):
    snap = ExportSnapshot(export["dir"])
    rows = snap.active_page_rows(USER)
    ids = {r["id"] for r in rows}
    assert 900 not in ids, "archived page must be excluded"
    assert 901 in ids, "human_status='active' overrides status"
    assert 902 not in ids, "other user's page must be excluded"
    assert 903 in ids
    assert snap.skipped_lines["pages"] == 1
    expected_keys = {
        "id",
        "url",
        "title",
        "domain",
        "dwell_time_seconds",
        "visited_at",
        "status",
        "processing_depth",
        "content_summary",
        "page_content_id",
        "capture_id",
        "content_extracted_text",
        "fetched_content",
        "content_level_summary",
        "tool_selected",
        "capture_text_id",
        "is_learning",
    }
    assert expected_keys <= set(rows[0])
    assert rows[0]["capture_text_id"] == "cap_synthetic_1"
    # The production converter accepts these rows unchanged.
    pages = ClusteringService._pages_from_rows(rows)
    assert {p["db_id"] for p in pages} == ids
    assert pages[0]["full_content"] == {"text": "synthetic topic A 0"}
    assert snap.user_ids()[0] == USER


def test_export_embeddings_and_run_assignments(export):
    snap = ExportSnapshot(export["dir"])
    vecs = snap.embeddings(f"{MODEL}@{CONTRACT}")
    assert len(vecs) == 18 and len(next(iter(vecs.values()))) == DIM
    assert snap.embeddings("all-MiniLM-L6-v2") == {}
    assign = snap.run_assignments(42)
    topics = export["topics"]
    assert assign[topics["A"][0]] == 1000 and assign[topics["C"][0]] == 1001
    assert assign[topics["C"][-1]] == -1, "featured singleton = noise"
    assert snap.latest_completed_run(USER) == 42


# ── harness ──────────────────────────────────────────────────────────────


def test_run_clustering_on_export_recovers_topics(export, prod_like_knobs):
    snap = ExportSnapshot(export["dir"])
    result = harness.run_clustering(source="export", user_id=USER, snapshot=snap)
    assert result["missing_embeddings"] == 1, "page 903 has no cached vector"
    # 18 topic pages; 901 shares a content row with a topic page (Filter C dedup).
    assert len(result["pages"]) == 18
    assert result["config"]["model_key"] == f"{MODEL}@{CONTRACT}"
    assert result["config"]["effective_min_cluster_size"] == 3
    ann = scoring.load_annotations(export["labels"], topic_map=export["topic_map"])
    record = harness.build_record(
        label="t", source={"kind": "export"}, result=result, ann=ann, guard_sets=[]
    )
    assert record["metrics"]["n_clusters"] == 3
    s = record["scores"]["topic_key"]
    assert s["purity"] == 1.0 and s["ARI"] == 1.0
    assert record["scores"]["category"]["purity"] == 1.0
    assert set(record["scores"]) == set(scoring.SCORE_KEYS)
    assert "titles" not in record["clusters"][0]
    assert len(record["assignments"]) == 18


def test_settings_overrides_restore(monkeypatch):
    monkeypatch.setattr(settings, "hdbscan_min_samples", 2)
    with harness.settings_overrides({"min_samples": 5, "umap_dims": None}):
        assert settings.hdbscan_min_samples == 5
    assert settings.hdbscan_min_samples == 2


def test_stability_trials_are_perfect_for_a_stable_partition(prod_like_knobs, monkeypatch):
    """Well-separated blobs: removing one page must not move anyone else."""
    rng = np.random.default_rng(1)
    emb = np.vstack([np.array([_vec(a, 0.05, rng) for _ in range(6)]) for a in range(3)])
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    labels = np.repeat([0, 1, 2], 6)
    res = harness.stability_trials(emb, labels, {}, user_id=USER, trials=3)
    assert res["trials"] == 3
    assert res["mean_ari_all"] == 1.0 and res["min_ari_all"] == 1.0
    assert res["mean_ari_clustered_both"] == 1.0
    assert harness.stability_trials(emb, labels, {}, user_id=USER, trials=0) is None


def test_guard_set_metrics():
    assign = {1: 0, 2: 0, 3: 1, 4: -1}
    res = harness.guard_set_metrics(assign, [{"name": "g", "page_ids": [1, 2, 3, 4, 5]}])
    assert res == [{"name": "g", "n_pages": 5, "modal_cluster_share": 40.0, "n_absent_or_noise": 2}]


def test_score_stored_run_uses_given_universe(export):
    snap = ExportSnapshot(export["dir"])
    topics = export["topics"]
    ann = scoring.load_annotations(export["labels"], topic_map=export["topic_map"])
    universe = topics["A"] + topics["B"] + topics["C"] + [903]
    rec = harness.score_stored_run(snap, 42, universe, ann, [])
    assert rec["assignments"]["903"] == -1
    s = rec["scores"]["topic_key"]
    assert s["n_pages"] == 18
    assert s["purity"] == round((6 + 5) / 17, 3)  # A+B merged (majority 6 of 12), C minus singleton
    assert s["n_clusters"] == 2


# ── CLI ──────────────────────────────────────────────────────────────────


def test_cli_run_with_identity_check(export, prod_like_knobs, capsys):
    rc = cluster_eval.main(
        [
            "run",
            "--export",
            str(export["dir"]),
            "--user-id",
            str(USER),
            "--labels",
            str(export["labels"]),
            "--topic-map",
            str(export["topic_map"]),
            "--label",
            "synthetic",
            "--baseline-run",
            "42",
            "--out-dir",
            str(export["out"]),
        ]
    )
    out = capsys.readouterr().out
    # The fresh partition is purer than the stored A+B merge -> identity FAILS (two-sided).
    assert rc == 1
    assert "identity check vs stored run 42" in out and "FAIL" in out
    records = sorted(export["out"].glob("*.json"))
    assert len(records) == 2
    main = json.loads(next(p for p in records if "stored-run" not in p.name).read_text())
    assert main["identity_check"]["ok"] is False
    assert main["scores"]["topic_key"]["purity"] == 1.0
    assert main["config"]["umap_dims"] == 0


def test_cli_knobs_reach_settings(export, prod_like_knobs, monkeypatch):
    seen = {}
    real = ClusteringService._run_hdbscan

    def spy(self, embeddings):
        seen["min_samples"] = settings.hdbscan_min_samples
        seen["method"] = settings.hdbscan_selection_method
        return real(self, embeddings)

    monkeypatch.setattr(ClusteringService, "_run_hdbscan", spy)
    rc = cluster_eval.main(
        [
            "run",
            "--export",
            str(export["dir"]),
            "--user-id",
            str(USER),
            "--min-samples",
            "3",
            "--selection-method",
            "leaf",
            "--stability-trials",
            "2",
            "--label",
            "knobs",
            "--out-dir",
            str(export["out"]),
        ]
    )
    assert rc == 0
    assert seen == {"min_samples": 3, "method": "leaf"}
    assert settings.hdbscan_min_samples == 2, "override restored after the run"
    rec = json.loads(next(export["out"].glob("*-knobs.json")).read_text())
    assert rec["scores"] is None, "no labels -> no scores, still a usable record"
    assert rec["config"]["min_samples"] == 3
    assert rec["stability"]["trials"] == 2


def test_cli_score_run_and_compare_gate(export, capsys):
    rc = cluster_eval.main(
        [
            "score-run",
            "--export",
            str(export["dir"]),
            "--run-id",
            "42",
            "--labels",
            str(export["labels"]),
            "--topic-map",
            str(export["topic_map"]),
            "--out-dir",
            str(export["out"]),
        ]
    )
    assert rc == 0
    stored = next(export["out"].glob("*-stored-run-42.json"))
    rec = json.loads(stored.read_text())
    assert rec["scores"]["topic_key"]["n_pages"] == 18
    # compare a record against itself: nothing regresses
    assert cluster_eval.main(["compare", str(stored), str(stored), "--gate"]) == 0
    # a degraded candidate fails the gate
    worse = json.loads(stored.read_text())
    worse["scores"]["topic_key"]["purity"] -= 0.1
    worse_path = export["out"] / "worse.json"
    worse_path.write_text(json.dumps(worse))
    assert cluster_eval.main(["compare", str(stored), str(worse_path), "--gate"]) == 1
    assert cluster_eval.main(["compare", str(stored), str(worse_path)]) == 0
    assert "NO" in capsys.readouterr().out


def test_cli_requires_export_for_export_source():
    with pytest.raises(SystemExit):
        cluster_eval.main(["run", "--label", "x"])
