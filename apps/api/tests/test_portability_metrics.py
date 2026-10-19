"""Tests for the portability benchmark metrics and runner (synthetic data only)."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from evaluation.clustering.portability import metrics, runner


def _keys(n, nlab=3):
    return {i: {"fine": f"f{i % nlab}", "coarse": f"c{i % 2}", "coarse_src": f"s{i % 2}"}
            for i in range(n)}


def test_score_partition_coverage_and_sizes():
    # group 0: 5 pages, group 1: 2 pages (uncovered), group 2: 3 pages, 2 noise
    assign = {**{i: 0 for i in range(5)}, 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: -1, 11: -1}
    r = metrics.score_partition(assign, _keys(12))
    assert r["coverage"] == pytest.approx(8 / 12, abs=1e-3)
    assert r["n_groups"] == 3 and r["n_groups_ge3"] == 2
    s = r["sizes"]
    assert s["size_hist"]["1-2"] == 1 and s["size_hist"]["3-4"] == 1 and s["size_hist"]["5-9"] == 1
    assert s["size_max"] == 5 and s["largest_group_share"] == pytest.approx(5 / 12, abs=1e-3)
    assert {"fine", "coarse", "coarse_src"} <= set(r)
    assert r["fine"]["n_clusters"] == 3


def test_score_super():
    r = metrics.score_super({0: "a", 1: "a", 2: "b", 3: -1}, _keys(4))
    assert r["n_super"] == 2 and "coarse" in r and "coarse_src" in r


def test_stability_identical_and_split():
    a = {i: i // 5 for i in range(20)}
    s = metrics.stability(a, dict(a))
    assert s["ari_all"] == 1.0 and s["comembership_recall"] == 1.0
    assert s["survival_share"] == 1.0 and s["small_to_noise_share"] == 0.0
    split = {i: (i // 5 if i % 5 < 3 or i // 5 != 0 else 99) for i in range(20)}  # group 0 -> 3+2
    s2 = metrics.stability(a, split)
    # pairs in group0: 10 -> 3 + 1 kept = 4/10 ; others intact (3 groups x 10)
    assert s2["comembership_recall"] == pytest.approx((4 + 30) / 40)
    assert s2["survival_share"] == pytest.approx(18 / 20)
    noisy = dict(a)
    noisy[0] = -1
    assert metrics.stability(a, noisy)["small_to_noise_share"] == pytest.approx(1 / 20)


def test_load_ids_formats(tmp_path):
    for name, text in [("a.json", "[3,4,5]"), ("b.jsonl", "3\n4\n5\n"), ("c.txt", "3\n4\n5"),
                       ("d.jsonl", '{"id":3}\n{"id":4}\n{"id":5}')]:
        p = tmp_path / name
        p.write_text(text)
        assert runner.load_ids(p) == [3, 4, 5]


def test_runner_smoke_random_vectors(tmp_path):
    rng = np.random.default_rng(0)
    n = 200
    df = pd.DataFrame({
        "id": np.arange(1000, 1000 + n), "user": "u_x", "order": np.arange(n),
        "fine": [f"f{i % 6}" for i in range(n)], "coarse": [f"c{i % 3}" for i in range(n)],
        "coarse_src": [f"s{i % 3}" for i in range(n)],
    })
    pages = tmp_path / "pages.parquet"
    df.to_parquet(pages)
    emb = rng.normal(size=(n, 32)).astype(np.float32)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    np.save(tmp_path / "e.npy", emb)
    (tmp_path / "ids.json").write_text(json.dumps(list(df["id"])))
    out = tmp_path / "out"
    for size in (100, 200):
        runner.main(["run", "--candidate", "hdbscan_prod", "--pages", str(pages), "--user", "u_x",
                     "--size", str(size), "--emb-npy", str(tmp_path / "e.npy"),
                     "--emb-ids", str(tmp_path / "ids.json"), "--out", str(out)])
    rec = json.loads((out / "hdbscan_prod__u_x__100.json").read_text())
    assert rec["n_pages"] == 100 and rec["timing"]["wall_s"] > 0
    assert (out / "hdbscan_prod__u_x__100.assign.json.gz").exists()
    runner.main(["stability", "--out", str(out), "--candidate", "hdbscan_prod", "--user", "u_x",
                 "--small", "100", "--large", "200"])
    runner.main(["table", "--out", str(out)])
    assert len(pd.read_csv(out / "results.csv")) == 2
