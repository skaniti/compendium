"""CLI runner for the portability benchmark.

    python -m evaluation.clustering.portability.runner run --candidate hdbscan_prod \
        --pages PAGES.parquet --user U --size N --emb-npy E.npy --emb-ids ids.json --out DIR
    python -m evaluation.clustering.portability.runner stability --out DIR --candidate C \
        --user U --small 10000 --large 50000
    python -m evaluation.clustering.portability.runner table --out DIR

Candidate contract: ``CANDIDATES[name](page_frame, ctx) -> {"assign": {id: cluster},
"super": {id: super|-1}, "meta": {...}, optional "cost": {...}}``. ``page_frame`` holds the
user's pages with ``order < N`` sorted by ``order``; ``ctx`` is the parsed CLI args as a dict,
plus ``ctx["emb"]`` (float32 matrix, row i = ``page_frame`` row i; None if no --emb-npy).
"""

from __future__ import annotations

import argparse
import gzip
import json
import resource
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

from evaluation.clustering.portability import metrics


def _hdbscan_prod(frame: pd.DataFrame, ctx: dict) -> dict:
    from evaluation.clustering.portability.hdbscan_candidate import run_hdbscan_prod

    return run_hdbscan_prod([int(i) for i in frame["id"]], ctx["emb"])


CANDIDATES = {"hdbscan_prod": _hdbscan_prod}


def _rss_mb() -> float:
    try:
        import psutil

        return psutil.Process().memory_info().rss / 2**20
    except Exception:
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def _peak_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024  # Linux: KiB


def load_ids(path: str | Path) -> list[int]:
    """Ids from a JSON list, a JSONL file (ints or objects with an id key) or one id per line."""
    text = Path(path).read_text(encoding="utf-8").strip()
    if not text:
        return []

    def conv(x):
        if isinstance(x, dict):
            for k in ("id", "page_id"):
                if k in x:
                    return int(x[k])
            raise ValueError(f"no id key in {x!r}")
        return int(x)

    if text[0] == "[":
        return [conv(x) for x in json.loads(text)]
    if text[0] == "{":
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                for k in ("ids", "page_ids"):
                    if k in obj:
                        return [conv(x) for x in obj[k]]
        except json.JSONDecodeError:
            pass
    out = []
    for line in text.splitlines():
        line = line.strip().strip(",")
        if line:
            out.append(conv(json.loads(line)) if line[0] in "{[\"" else int(line))
    return out


def load_embeddings(npy: str, ids_path: str, wanted: list[int]) -> np.ndarray:
    """Rows of the .npy for ``wanted`` ids, in that order (float32)."""
    arr = np.load(npy, mmap_mode="r")
    ids = load_ids(ids_path)
    if len(ids) != arr.shape[0]:
        raise ValueError(f"{len(ids)} ids vs {arr.shape[0]} embedding rows")
    row = {i: r for r, i in enumerate(ids)}
    missing = [i for i in wanted if i not in row]
    if missing:
        raise KeyError(f"{len(missing)} pages without embedding, e.g. {missing[:5]}")
    return np.asarray(arr[[row[i] for i in wanted]], dtype=np.float32)


def _stem(out: Path, cand: str, user: str, size: int) -> Path:
    return out / f"{cand}__{user}__{size}"


def run(args) -> dict:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    frame = metrics.key_frame(args.pages, args.user, args.size)
    ctx = dict(vars(args))
    ids = [int(i) for i in frame["id"]]
    ctx["emb"] = load_embeddings(args.emb_npy, args.emb_ids, ids) if args.emb_npy else None
    rss0 = _rss_mb()
    t0, c0 = time.perf_counter(), time.process_time()
    res = CANDIDATES[args.candidate](frame, ctx)
    wall, cpu = time.perf_counter() - t0, time.process_time() - c0
    peak = _peak_mb()
    keys = metrics.keys_from_frame(frame)
    assign = {int(k): int(v) for k, v in res["assign"].items()}
    sup = {int(k): v for k, v in res.get("super", {}).items()}
    rec = {
        "candidate": args.candidate, "user": args.user, "size": args.size,
        "n_pages": len(frame),
        "scores": metrics.score_partition(assign, keys),
        "timing": {"wall_s": round(wall, 2), "cpu_s": round(cpu, 2)},
        "memory": {"rss_after_inputs_mb": round(rss0, 1), "peak_rss_mb": round(peak, 1),
                   "candidate_increment_mb": round(max(0.0, peak - rss0), 1)},
        "meta": res.get("meta", {}),
    }
    if sup:
        rec["super_scores"] = metrics.score_super(sup, keys)
    if res.get("cost"):
        rec["cost"] = res["cost"]
    stem = _stem(out, args.candidate, args.user, args.size)
    stem.with_suffix(".json").write_text(json.dumps(rec, indent=1, default=str))
    with gzip.open(str(stem) + ".assign.json.gz", "wt") as fh:
        json.dump({"assign": {str(k): v for k, v in assign.items()},
                   "super": {str(k): v for k, v in sup.items()}}, fh)
    return rec


def _load_assign(out: Path, cand: str, user: str, size: int) -> dict[int, int]:
    with gzip.open(str(_stem(out, cand, user, size)) + ".assign.json.gz", "rt") as fh:
        return {int(k): v for k, v in json.load(fh)["assign"].items()}


def run_stability(args) -> dict:
    out = Path(args.out)
    s = metrics.stability(_load_assign(out, args.candidate, args.user, args.small),
                          _load_assign(out, args.candidate, args.user, args.large))
    s.update({"candidate": args.candidate, "user": args.user, "small": args.small,
              "large": args.large})
    (out / f"{args.candidate}__{args.user}__stability_{args.small}_{args.large}.json").write_text(
        json.dumps(s, indent=1))
    return s


_SCORE_COLS = ("n_clusters", "n_clustered", "noise_share", "purity", "inverse_purity", "ARI",
               "ARI_all", "NMI", "NMI_all", "homogeneity", "completeness", "n_truth_classes")


def _flatten(rec: dict) -> dict:
    row = {k: rec.get(k) for k in ("candidate", "user", "size", "n_pages")}
    sc = rec["scores"]
    for g in ("fine", "coarse", "coarse_src"):
        for c in _SCORE_COLS:
            row[f"{g}_{c}"] = sc.get(g, {}).get(c)
    for k in ("coverage", "n_groups", "n_groups_ge3"):
        row[k] = sc.get(k)
    for k, v in sc.get("sizes", {}).items():
        if k in ("size_hist", "pages_hist"):
            for b, n in v.items():
                row[f"{k}_{b}"] = n
        elif k != "n_pages":
            row[f"sizes_{k}"] = v
    for g in ("coarse", "coarse_src"):
        for c in ("purity", "inverse_purity", "ARI", "ARI_all", "NMI", "NMI_all"):
            row[f"super_{g}_{c}"] = rec.get("super_scores", {}).get(g, {}).get(c)
    row["n_super"] = rec.get("super_scores", {}).get("n_super")
    for k, v in rec.get("timing", {}).items():
        row[f"timing_{k}"] = v
    for k, v in rec.get("memory", {}).items():
        row[f"mem_{k}"] = v
    for k, v in rec.get("cost", {}).items():
        row[f"cost_{k}"] = v
    return row


def table(args) -> pd.DataFrame:
    out = Path(args.out)
    rows = []
    for p in sorted(out.glob("*__*__*.json")):
        if "stability" in p.name or p.name.endswith(".assign.json.gz"):
            continue
        rec = json.loads(p.read_text())
        if "scores" in rec:
            rows.append(_flatten(rec))
    df = pd.DataFrame(rows)
    df.to_csv(out / "results.csv", index=False)
    return df


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="portability.runner")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--candidate", required=True)
    r.add_argument("--pages", required=True)
    r.add_argument("--user", required=True)
    r.add_argument("--size", type=int, required=True)
    r.add_argument("--emb-npy")
    r.add_argument("--emb-ids")
    r.add_argument("--out", required=True)
    s = sub.add_parser("stability")
    s.add_argument("--out", required=True)
    s.add_argument("--candidate", required=True)
    s.add_argument("--user", required=True)
    s.add_argument("--small", type=int, required=True)
    s.add_argument("--large", type=int, required=True)
    t = sub.add_parser("table")
    t.add_argument("--out", required=True)
    args, extra = ap.parse_known_args(argv)  # candidates may add their own flags via ctx
    if args.cmd == "run":
        rec = run(args)
        print(json.dumps({k: rec[k] for k in ("candidate", "user", "size", "timing", "memory", "meta")},
                         default=str))
    elif args.cmd == "stability":
        print(json.dumps(run_stability(args)))
    else:
        print(f"{len(table(args))} rows -> {Path(args.out) / 'results.csv'}")


if __name__ == "__main__":
    sys.exit(main())
