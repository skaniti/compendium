"""Offline label-first evaluation (``evaluation/clustering/label_first_eval.py``), synthetic only."""

from __future__ import annotations

import json

import numpy as np
import pytest

from backend.config.settings import settings
from evaluation.clustering import label_first_eval as lfe
from evaluation.clustering import scoring
from evaluation.clustering.export_loader import ExportSnapshot
from tests.test_clustering_eval_harness import CONTRACT, MODEL, USER, make_export, make_labels

EXCL = frozenset({"auth_login", "app_dashboard_ui", "search_results", "error_or_empty"})


@pytest.fixture
def export(tmp_path, monkeypatch):
    topics = make_export(tmp_path / "export")
    labels, topic_map = make_labels(tmp_path / "labels", topics)
    monkeypatch.setattr(settings, "clustering_embedding_model", MODEL)
    monkeypatch.setattr(settings, "clustering_text_contract", CONTRACT)
    return {
        "dir": tmp_path / "export",
        "topics": topics,
        "labels": labels,
        "topic_map": topic_map,
        "out": tmp_path / "runs",
    }


def test_labels_from_annotations_and_content_kind_stamp():
    pages = [
        {"db_id": 1, "page_content_id": 10},
        {"db_id": 2, "page_content_id": 10},
        {"db_id": 3, "page_content_id": None},
    ]
    ann = {
        1: {
            "category": "games_gaming",
            "subtopic": "shelf",
            "knowledge_value": "keep",
            "content_kind": "auth_login",
            "topic_key": "k",
        },
        2: {
            "category": "film_tv",
            "subtopic": "other",
            "knowledge_value": "keep",
            "content_kind": "other",
            "topic_key": "k2",
        },
    }
    labels = lfe.labels_from_annotations(pages, ann)
    assert set(labels) == {10} and labels[10]["category"] == "games_gaming"
    lfe.stamp_content_kind(pages, labels)
    assert pages[0]["content_kind"] == "auth_login" and pages[1]["content_kind"] == "auth_login"
    assert "content_kind" not in pages[2]


def test_shelves_from_topic_map_groups_and_excludes():
    labels = {
        1: {
            "category": "c",
            "subtopic": "s1",
            "knowledge_value": "keep",
            "content_kind": "other",
            "topic_key": "k1",
        },
        2: {
            "category": "c",
            "subtopic": "s1 variant",
            "knowledge_value": "marginal",
            "content_kind": "other",
            "topic_key": "k1",
        },
        3: {
            "category": "c",
            "subtopic": "s2",
            "knowledge_value": "keep",
            "content_kind": "other",
            "topic_key": None,
        },
        4: {
            "category": "c",
            "subtopic": "s3",
            "knowledge_value": "exclude",
            "content_kind": "other",
            "topic_key": "k1",
        },
        5: {
            "category": "c",
            "subtopic": "s4",
            "knowledge_value": "keep",
            "content_kind": "auth_login",
            "topic_key": "k1",
        },
    }
    shelf_of, shelves = lfe.shelves_from_topic_map(labels, EXCL)
    assert shelf_of[1] == shelf_of[2] and shelf_of[3] != shelf_of[1]
    assert 4 not in shelf_of and 5 not in shelf_of
    assert len(shelves) == 2 and all(
        {"id", "stable_id", "name", "category"} <= set(s) for s in shelves.values()
    )


def test_split_large_shelves_splits_two_blobs():
    rng = np.random.default_rng(0)
    vectors = {}
    for i in range(10):
        vectors[i] = np.array([1.0, 0.0]) + rng.normal(0, 0.01, 2)
        vectors[10 + i] = np.array([0.0, 1.0]) + rng.normal(0, 0.01, 2)
    shelf_of = {cid: 1 for cid in vectors}
    shelves = {1: lfe._shelf_row(1, "Synthetic big shelf", "games_gaming")}
    n = lfe.split_large_shelves(shelf_of, shelves, vectors, soft_cap=12)
    assert n == 1 and len(shelves) == 2
    groups = {}
    for cid, sid in shelf_of.items():
        groups.setdefault(sid, set()).add(cid)
    assert sorted(len(g) for g in groups.values()) == [10, 10]
    assert lfe.split_large_shelves(shelf_of, shelves, vectors, soft_cap=12) == 0


def test_metric_helpers():
    labels = np.array([0, 0, 1, -1])
    pages = [{"db_id": i} for i in range(4)]
    ann = {0: {"category": "a"}, 1: {"category": "b"}, 2: {"category": "a"}, 3: {"category": "a"}}
    sp = lfe.supercluster_category_purity(pages, labels, {0: "a", 1: "a"}, ann)
    assert sp["n_groups"] == 1 and sp["per_group"] == {"a": round(2 / 3, 3)}
    assert sp["single_cluster_groups"] == 0 and sp["multi_cluster_groups"] == 1
    assert lfe.size_distribution(labels, 1, 5) == {
        "n_clusters": 2,
        "min": 1,
        "median": 1.5,
        "max": 2,
        "within_band": 2,
        "band": [1, 5],
    }
    st = lfe.membership_ari({1: 0, 2: 0, 3: -1, 9: 1}, {1: 5, 2: 5, 3: -1, 8: 2})
    assert st["common_pages"] == 3 and st["ari_all"] == 1.0 and st["moved_pages"] == 0
    st2 = lfe.membership_ari({1: 0, 2: 0, 3: 1}, {1: 0, 2: 1, 3: 1})
    assert st2["ari_all"] < 1.0


def test_run_label_first_topic_map_recovers_shelves(export):
    snap = ExportSnapshot(export["dir"])
    ann = scoring.load_annotations(export["labels"], topic_map=export["topic_map"])
    rec = lfe.run_label_first(snap, USER, ann, mode="topic_map", min_cluster_size=3, soft_cap=40)
    assert rec["metrics"]["n_clusters"] == 3 and rec["metrics"]["noise_count"] == 1  # 903: no label
    assert (
        rec["scores"]["topic_key"]["purity"] == 1.0 and rec["scores"]["topic_key"]["ARI_all"] == 1.0
    )
    assert rec["size_distribution"]["within_band"] == 3
    sp = rec["supercluster_purity"]
    assert sp["n_groups"] == 2 and sp["min_purity"] == 1.0 and sp["single_cluster_groups"] == 1
    assert rec["leave_one_out"]["mean_ari_all"] == 1.0
    assert set(rec["cluster_names"].values()) == {"Shelf a", "Shelf b", "Shelf c"}


def test_run_label_first_canonicaliser_with_oracle(export):
    snap = ExportSnapshot(export["dir"])
    ann = scoring.load_annotations(export["labels"], topic_map=export["topic_map"])
    rec = lfe.run_label_first(
        snap, USER, ann, mode="canonicaliser", min_cluster_size=3, attach=0.8, ask=0.3
    )
    # identical subtopic strings memoise onto one shelf each -> the three shelves come back
    assert rec["metrics"]["n_clusters"] == 3
    assert rec["scores"]["topic_key"]["purity"] == 1.0
    assert rec["canonicaliser_methods"]["create"] == 3


def test_cli_writes_record_with_baseline_and_compare(export, tmp_path):
    other = tmp_path / "other.json"
    other.write_text(
        json.dumps({"label": "x", "scores": {"topic_key": {"purity": 0.5}}, "metrics": {}})
    )
    rc = lfe.main(
        [
            "--export",
            str(export["dir"]),
            "--user-id",
            str(USER),
            "--labels",
            str(export["labels"]),
            "--topic-map",
            str(export["topic_map"]),
            "--baseline-run",
            "42",
            "--compare-record",
            str(other),
            "--label",
            "synthetic",
            "--out-dir",
            str(export["out"]),
        ]
    )
    assert rc == 0
    rec = json.loads(next(export["out"].glob("*-synthetic.json")).read_text())
    assert (
        rec["baseline_run"]["run_id"] == 42
        and rec["baseline_run"]["scores"]["topic_key"]["purity"] < 1.0
    )
    assert rec["compare_record"]["label"] == "x"
    assert rec["scores"]["topic_key"]["purity"] == 1.0
