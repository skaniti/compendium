"""Metrics for the portability benchmark: partition scores, superclusters, run stability.

Pure functions over ``{page_id: cluster}`` dicts (``-1`` = noise). Label scoring delegates to
``evaluation.clustering.scoring.score`` so definitions stay frozen. Page data is passed in by
path / argument; nothing corpus-specific lives here.
"""

from __future__ import annotations

import collections
from pathlib import Path

import numpy as np
import pandas as pd

from evaluation.clustering import scoring
from evaluation.clustering.label_first_eval import membership_ari

KEYS = ("fine", "coarse", "coarse_src")
BUCKETS = (("1-2", 1, 2), ("3-4", 3, 4), ("5-9", 5, 9), ("10-39", 10, 39),
           ("40-99", 40, 99), ("100-399", 100, 399), ("400+", 400, 10**12))
MIN_COVERED = 3


def key_frame(users_parquet: str | Path, user: str, size: int) -> pd.DataFrame:
    """The user's pages with ``order < size``, sorted by ``order``."""
    df = pd.read_parquet(users_parquet)
    df = df[(df["user"] == user) & (df["order"] < size)]
    return df.sort_values("order").reset_index(drop=True)


def keys_from_frame(frame: pd.DataFrame) -> dict[int, dict]:
    return {
        int(i): {"fine": f, "coarse": c, "coarse_src": s}
        for i, f, c, s in zip(frame["id"], frame["fine"], frame["coarse"], frame["coarse_src"])
    }


def _ann(keys: dict[int, dict]) -> dict[int, dict]:
    return {int(p): {**k, "knowledge_value": "keep"} for p, k in keys.items()}


def size_stats(assign: dict) -> dict:
    """Group-size distribution and coverage (groups of < 3 pages count as uncovered)."""
    n = len(assign)
    counts = collections.Counter(c for c in assign.values() if c != -1)
    sizes = np.array(sorted(counts.values()), dtype=int)
    out: dict = {"n_pages": n, "n_groups": len(sizes),
                 "n_groups_ge3": int((sizes >= MIN_COVERED).sum())}
    covered = int(sizes[sizes >= MIN_COVERED].sum()) if len(sizes) else 0
    out["coverage"] = round(covered / n, 4) if n else 0.0
    out["noise_share"] = round(1 - int(sizes.sum()) / n, 4) if n else 0.0
    if len(sizes):
        out.update({
            "size_min": int(sizes[0]), "size_p25": float(np.percentile(sizes, 25)),
            "size_median": float(np.median(sizes)), "size_p75": float(np.percentile(sizes, 75)),
            "size_p90": float(np.percentile(sizes, 90)), "size_max": int(sizes[-1]),
            "largest_group_share": round(int(sizes[-1]) / n, 4),
        })
    out["size_hist"] = {name: int(((sizes >= lo) & (sizes <= hi)).sum()) for name, lo, hi in BUCKETS}
    out["pages_hist"] = {name: int(sizes[(sizes >= lo) & (sizes <= hi)].sum()) for name, lo, hi in BUCKETS}
    return out


def score_partition(assign: dict[int, int], keys: dict[int, dict]) -> dict:
    ann = _ann(keys)
    out = {k: scoring.score(assign, ann, key=k) for k in ("fine", "coarse", "coarse_src")}
    s = size_stats(assign)
    out.update({"coverage": s["coverage"], "n_groups": s["n_groups"],
                "n_groups_ge3": s["n_groups_ge3"], "sizes": s})
    return out


def score_super(super_assign: dict, keys: dict[int, dict]) -> dict:
    """Score superclusters (page -> id, -1 noise) against coarse / coarse_src."""
    ann = _ann(keys)
    # scoring.score wants int labels; map arbitrary ids to ints, keep -1 as noise
    ids: dict = {}
    a = {}
    for p, g in super_assign.items():
        if g == -1:
            a[p] = -1
        else:
            a[p] = ids.setdefault(g, len(ids))
    out = {k: scoring.score(a, ann, key=k) for k in ("coarse", "coarse_src")}
    out["n_super"] = len(ids)
    out["sizes"] = size_stats(a)
    return out


def _pairs(x: np.ndarray) -> float:
    x = x.astype(np.float64)
    return float((x * (x - 1) / 2).sum())


def stability(assign_small: dict, assign_large: dict) -> dict:
    """Small-run vs large-run agreement on the pages present in both."""
    common = sorted(set(assign_small) & set(assign_large))
    out: dict = {"common_pages": len(common)}
    if len(common) < 2:
        return out
    a = np.array([assign_small[p] for p in common])
    b = np.array([assign_large[p] for p in common])
    ari = membership_ari(assign_small, assign_large)
    out["ari_all"] = ari.get("ari_all")
    if "ari_clustered_both" in ari:
        out["ari_clustered_both"] = ari["ari_clustered_both"]
    sc = a != -1
    n_sc = int(sc.sum())
    out["small_clustered"] = n_sc
    if n_sc == 0:
        return out
    df = pd.DataFrame({"a": a[sc], "b": b[sc]})
    out["small_to_noise_share"] = round(float((df["b"] == -1).sum()) / n_sc, 4)
    small_pairs = _pairs(df.groupby("a").size().to_numpy())
    both = df[df["b"] != -1]
    cell = both.groupby(["a", "b"]).size()
    out["comembership_recall"] = (
        round(_pairs(cell.to_numpy()) / small_pairs, 4) if small_pairs else None
    )
    # survival: each small group -> large group holding most of its pages
    out["survival_share"] = round(float(cell.groupby(level=0).max().sum()) / n_sc, 4)
    return out


def stability_row(assign_small: dict, assign_large: dict) -> dict:
    return stability(assign_small, assign_large)
