"""Offline evaluation of label-first grouping (proposal #3/#4/#6) on a table export.

The sandbox cannot call the labelling model, so the labelled dataset stands in for the
labeller's output: each page's ``category``, ``subtopic``, ``knowledge_value`` and
``content_kind`` come from ``page_annotations.jsonl``. Two canonicalisation modes:

- ``topic_map``: the dataset's own ``topic_map.json`` (``category||subtopic`` -> topic_key)
  IS the shelf vocabulary. This is the upper bound of the design: purity/ARI against
  ``topic_key`` are 1.0 by construction before the size band, so only coverage, size
  distribution, supercluster purity and stability are real measurements here.
- ``canonicaliser``: the production ``ShelfCanonicaliser`` with an in-memory store, a
  local TF-IDF character-n-gram embedder over subtopic strings (no API) and an oracle
  "same shelf?" answer taken from the topic map. Shows what the attach/ask/create
  mechanics do to the upper bound with a weak embedder.

Both modes then apply the size band (min cluster size, soft cap split by 2-means on the
export's cached page vectors), build the partition with the production
``label_first_clustering.build_partition`` and score it with the phase-A harness scorer.

    python -m evaluation.clustering.label_first_eval --export DIR --user-id N \\
        --labels page_annotations.jsonl --topic-map topic_map.json \\
        --baseline-run 227 --stability-run 226 --mode topic_map
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import uuid
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

_API_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_API_ROOT) not in sys.path:
    sys.path.insert(0, str(_API_ROOT))

from evaluation.clustering import cluster_eval, harness, scoring
from evaluation.clustering.export_loader import ExportSnapshot

logger = logging.getLogger(__name__)


# ── labels from the dataset ──────────────────────────────────────────────


def labels_from_annotations(pages: list[dict], ann: dict[int, dict]) -> dict[int, dict]:
    """page_content_id -> label dict, from the annotation of the first page on that row."""
    out: dict[int, dict] = {}
    for p in pages:
        cid = p.get("page_content_id")
        row = ann.get(int(p["db_id"]))
        if cid is None or row is None or cid in out:
            continue
        out[cid] = {
            "category": row["category"],
            "subtopic": row.get("subtopic") or "",
            "knowledge_value": row.get("knowledge_value"),
            "content_kind": row.get("content_kind"),
            "topic_key": row.get("topic_key"),
        }
    return out


def stamp_content_kind(pages: list[dict], labels_by_cid: dict[int, dict]) -> None:
    """What the ingest labeller does in production: write the label's content_kind."""
    for p in pages:
        label = labels_by_cid.get(p.get("page_content_id"))
        if label is not None and not p.get("content_kind"):
            p["content_kind"] = label.get("content_kind")


# ── shelves ──────────────────────────────────────────────────────────────


def _shelf_row(shelf_id: int, name: str, category: str) -> dict:
    return {
        "id": shelf_id,
        "stable_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"shelf:{name}:{category}")),
        "name": name,
        "category": category,
    }


def shelves_from_topic_map(
    labels_by_cid: dict[int, dict], excluded_kinds
) -> tuple[dict[int, int], dict[int, dict]]:
    """Shelf = topic_key (or the raw category||subtopic string when unmapped)."""
    shelf_of: dict[int, int] = {}
    shelves: dict[int, dict] = {}
    key_to_id: dict[str, int] = {}
    for cid, label in labels_by_cid.items():
        if label.get("knowledge_value") == "exclude" or label.get("content_kind") in excluded_kinds:
            continue
        key = label.get("topic_key") or f"{label['category']}||{label['subtopic']}".lower()
        if key not in key_to_id:
            sid = len(key_to_id) + 1
            key_to_id[key] = sid
            name = key.split("||")[-1].replace("_", " ").strip().capitalize()
            shelves[sid] = _shelf_row(sid, name or key, label["category"])
        shelf_of[cid] = key_to_id[key]
    return shelf_of, shelves


def tfidf_embedder(fit_texts: list[str]):
    """Local character-n-gram TF-IDF embedder (rows L2-normalised); no model, no API."""
    from sklearn.feature_extraction.text import TfidfVectorizer

    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=1, sublinear_tf=True)
    vec.fit(fit_texts or [""])

    def embed(texts: list[str]) -> np.ndarray:
        m = vec.transform(texts).toarray().astype(np.float64)
        norms = np.linalg.norm(m, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return m / norms

    return embed


def shelves_from_canonicaliser(
    labels_by_cid: dict[int, dict],
    excluded_kinds,
    attach: float,
    ask: float,
    oracle: bool = True,
) -> tuple[dict[int, int], dict[int, dict], dict]:
    """Run the production canonicaliser in memory; the topic map answers "same shelf?".

    The oracle compares the topic_key of the string being placed with the topic_key of
    the string that created the candidate shelf (shelf names are derived from that string
    by ``shelf_service._shelf_name``, so the name identifies the creator).
    """
    from backend.services import shelf_service as ss

    items = [
        (cid, label)
        for cid, label in labels_by_cid.items()
        if label.get("knowledge_value") != "exclude"
        and label.get("content_kind") not in excluded_kinds
    ]
    embed = tfidf_embedder([label["subtopic"] for _, label in items])

    def key_of(label: dict) -> str:
        return label.get("topic_key") or f"{label['category']}||{label['subtopic']}"

    key_by_subtopic: dict[str, str] = {}
    key_by_name: dict[str, str] = {}
    for _, label in items:
        key_by_subtopic.setdefault(label["subtopic"], key_of(label))
        key_by_name.setdefault(ss._shelf_name(label["subtopic"]), key_of(label))

    def ask_fn(subtopic: str, shelf: dict) -> bool:
        if not oracle:
            return False
        return key_by_subtopic.get(subtopic) == key_by_name.get(shelf["name"])

    config = ss.ShelfConfig(
        attach=attach, ask=ask, merge_distance=0.15, soft_cap=10**9, min_cluster_size=1
    )
    store = ss.MemoryShelfStore()
    canon = ss.ShelfCanonicaliser(ss.ShelfIndex(), embed, ask_fn, config, store)
    results = canon.assign_many(items)
    shelf_of = {cid: r.shelf_id for cid, r in results.items()}
    methods = Counter(r.method for r in results.values())
    methods["asked"] = canon.asked
    shelves = {s["id"]: s for s in store.list_shelves()}
    return shelf_of, shelves, dict(methods)


def split_large_shelves(
    shelf_of: dict[int, int],
    shelves: dict[int, dict],
    vectors: dict[int, np.ndarray],
    soft_cap: int,
    seed: int = 0,
) -> int:
    """Size band: 2-means on page vectors for shelves above ``soft_cap``, until none is."""
    from sklearn.cluster import KMeans

    n_split = 0
    changed = True
    while changed:
        changed = False
        members: dict[int, list[int]] = defaultdict(list)
        for cid, sid in shelf_of.items():
            members[sid].append(cid)
        for sid, cids in list(members.items()):
            if len(cids) <= soft_cap:
                continue
            with_vec = [c for c in cids if c in vectors]
            if len(with_vec) < 4:
                continue
            X = np.vstack([vectors[c] for c in with_vec])
            km = KMeans(n_clusters=2, n_init=10, random_state=seed).fit(X)
            halves = [[c for c, l in zip(with_vec, km.labels_) if l == k] for k in (0, 1)]
            if min(len(h) for h in halves) == 0:
                continue
            small = min(halves, key=len)
            new_id = max(shelves) + 1
            parent = shelves[sid]
            shelves[new_id] = _shelf_row(
                new_id, f"{parent['name']} (part {new_id})", parent["category"]
            )
            for c in small:
                shelf_of[c] = new_id
            n_split += 1
            changed = True
    return n_split


# ── metrics ──────────────────────────────────────────────────────────────


def size_distribution(labels: np.ndarray, lo: int, hi: int) -> dict:
    sizes = sorted(Counter(int(c) for c in labels if c != -1).values(), reverse=True)
    if not sizes:
        return {"n_clusters": 0}
    return {
        "n_clusters": len(sizes),
        "min": sizes[-1],
        "median": float(np.median(sizes)),
        "max": sizes[0],
        "within_band": sum(1 for s in sizes if lo <= s <= hi),
        "band": [lo, hi],
    }


def supercluster_category_purity(
    pages: list[dict], labels: np.ndarray, cluster_category: dict[int, str], ann: dict[int, dict]
) -> dict:
    """Groups = categories; purity = share of member pages whose annotated category matches."""
    by_group: dict[str, list[int]] = defaultdict(list)
    clusters_by_group: dict[str, set[int]] = defaultdict(set)
    for i, c in enumerate(labels):
        if c == -1:
            continue
        g = cluster_category.get(int(c), "other_unclear")
        by_group[g].append(int(pages[i]["db_id"]))
        clusters_by_group[g].add(int(c))
    purities = {}
    for g, pids in by_group.items():
        known = [p for p in pids if p in ann]
        if not known:
            continue
        purities[g] = round(sum(1 for p in known if ann[p]["category"] == g) / len(known), 3)
    multi = {g: p for g, p in purities.items() if len(clusters_by_group[g]) >= 2}
    return {
        "n_groups": len(by_group),
        "single_cluster_groups": sum(1 for g in by_group if len(clusters_by_group[g]) == 1),
        "groups_ge_0.9_of_multi": sum(1 for p in multi.values() if p >= 0.9),
        "multi_cluster_groups": len(multi),
        "min_purity": min(purities.values()) if purities else None,
        "mean_purity": round(float(np.mean(list(purities.values()))), 3) if purities else None,
        "per_group": purities,
    }


def membership_ari(a: dict[int, int], b: dict[int, int]) -> dict:
    """Run-to-run stability on the pages present in both runs (noise = own singleton)."""
    from sklearn.metrics import adjusted_rand_score

    common = sorted(set(a) & set(b))
    if len(common) < 2:
        return {"common_pages": len(common)}
    la = [a[p] if a[p] != -1 else -1_000_000 - i for i, p in enumerate(common)]
    lb = [b[p] if b[p] != -1 else -1_000_000 - i for i, p in enumerate(common)]
    both = [p for p in common if a[p] != -1 and b[p] != -1]
    out = {
        "common_pages": len(common),
        "ari_all": round(float(adjusted_rand_score(la, lb)), 3),
        "moved_pages": sum(1 for p in common if (a[p] == -1) != (b[p] == -1)),
    }
    if len(both) >= 2:
        out["ari_clustered_both"] = round(
            float(adjusted_rand_score([a[p] for p in both], [b[p] for p in both])), 3
        )
    return out


# ── one run ──────────────────────────────────────────────────────────────


def run_label_first(
    snapshot: ExportSnapshot,
    user_id: int,
    ann: dict[int, dict],
    *,
    mode: str = "topic_map",
    min_cluster_size: int = 3,
    soft_cap: int = 40,
    attach: float = 0.50,
    ask: float = 0.35,
    as_of: str | None = None,
    model_key: str | None = None,
) -> dict:
    from backend.services import label_first_clustering as lf
    from backend.services.clustering_service import EXCLUDED_CONTENT_KINDS, ClusteringService

    svc = ClusteringService(user_id=user_id)
    rows = snapshot.active_page_rows(user_id, as_of=as_of)
    all_pages = svc._pages_from_rows(rows)
    pre_labels = labels_from_annotations(all_pages, ann)
    stamp_content_kind(all_pages, pre_labels)  # Filter F becomes live, as in production
    pages, filter_stats = svc._filter_clusterable_pages(all_pages)
    labels_by_cid = labels_from_annotations(pages, ann)

    methods: dict = {}
    if mode == "topic_map":
        shelf_of, shelves = shelves_from_topic_map(labels_by_cid, EXCLUDED_CONTENT_KINDS)
    elif mode == "canonicaliser":
        shelf_of, shelves, methods = shelves_from_canonicaliser(
            labels_by_cid, EXCLUDED_CONTENT_KINDS, attach, ask
        )
    else:
        raise ValueError(mode)
    n_shelves_raw = len({s for s in shelf_of.values()})

    from backend.config.settings import settings

    key = model_key or harness.model_key_for(settings)
    cache = snapshot.embeddings(key)
    vectors = {cid: np.asarray(v) for cid, v in cache.items() if cid in shelf_of}
    n_split = split_large_shelves(shelf_of, shelves, vectors, soft_cap)

    part = lf.build_partition(
        pages, labels_by_cid, shelf_of, shelves, min_cluster_size, EXCLUDED_CONTENT_KINDS
    )
    assign = {int(pages[i]["db_id"]): int(part.labels[i]) for i in range(len(pages))}
    record = {
        "mode": mode,
        "as_of": as_of,
        "config": {
            "min_cluster_size": min_cluster_size,
            "soft_cap": soft_cap,
            "attach": attach,
            "ask": ask,
            "model_key": key,
        },
        "n_loaded": len(all_pages),
        "filter_stats": filter_stats,
        "n_labelled": len(labels_by_cid),
        "n_shelves_before_split": n_shelves_raw,
        "n_splits": n_split,
        "canonicaliser_methods": methods,
        "partition_stats": part.stats,
        "metrics": harness.structure_metrics(part.labels),
        "size_distribution": size_distribution(part.labels, min_cluster_size, soft_cap),
        "scores": scoring.score_all(assign, ann),
        "supercluster_purity": supercluster_category_purity(
            pages, part.labels, part.cluster_category, ann
        ),
        "assignments": {str(k): v for k, v in assign.items()},
        "cluster_names": {str(k): v for k, v in part.cluster_names.items()},
        "cluster_category": {str(k): v for k, v in part.cluster_category.items()},
    }
    # Leave-one-out stability: dropping a page only changes the partition when it tips a
    # shelf across the size band, so this is cheap to compute exactly.
    record["leave_one_out"] = leave_one_out(
        pages, labels_by_cid, shelf_of, shelves, part, min_cluster_size
    )
    return record


def leave_one_out(
    pages, labels_by_cid, shelf_of, shelves, part, min_cluster_size, trials: int = 50
) -> dict:
    from sklearn.metrics import adjusted_rand_score

    from backend.services import label_first_clustering as lf
    from backend.services.clustering_service import EXCLUDED_CONTENT_KINDS

    rng = np.random.default_rng(0)
    n = len(pages)
    if n < 3:
        return {"trials": 0}
    drop = rng.choice(n, size=min(trials, n), replace=False)
    aris = []
    for idx in drop:
        keep = [i for i in range(n) if i != idx]
        sub = [pages[i] for i in keep]
        p2 = lf.build_partition(
            sub, labels_by_cid, shelf_of, shelves, min_cluster_size, EXCLUDED_CONTENT_KINDS
        )
        base = part.labels[keep]
        la = [int(v) if v != -1 else -1_000_000 - i for i, v in enumerate(base)]
        lb = [int(v) if v != -1 else -1_000_000 - i for i, v in enumerate(p2.labels)]
        aris.append(float(adjusted_rand_score(la, lb)))
    return {
        "trials": len(drop),
        "mean_ari_all": round(float(np.mean(aris)), 3),
        "min_ari_all": round(float(np.min(aris)), 3),
    }


# ── CLI ──────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.WARNING)
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--export", required=True)
    ap.add_argument("--user-id", type=int, required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--topic-map", required=True)
    ap.add_argument("--mode", choices=("topic_map", "canonicaliser"), default="topic_map")
    ap.add_argument("--min-cluster-size", type=int, default=3)
    ap.add_argument("--soft-cap", type=int, default=40)
    ap.add_argument("--attach", type=float, default=0.50)
    ap.add_argument("--ask", type=float, default=0.35)
    ap.add_argument("--model-key", default=None, help="embedding cache key (default from settings)")
    ap.add_argument("--baseline-run", type=int, help="stored run to score on the same page set")
    ap.add_argument(
        "--stability-run", type=int, help="earlier stored run: rerun as of its start and compare"
    )
    ap.add_argument("--compare-record", help="phase-A harness record to put side by side")
    ap.add_argument("--label", default="label-first")
    ap.add_argument("--out-dir", default=str(cluster_eval.DEFAULT_OUT_DIR))
    args = ap.parse_args(argv)

    snap = ExportSnapshot(args.export)
    ann = scoring.load_annotations(args.labels, topic_map=args.topic_map)
    as_of = snap.run_started_at(args.baseline_run) if args.baseline_run else None
    kw = {
        "mode": args.mode,
        "min_cluster_size": args.min_cluster_size,
        "soft_cap": args.soft_cap,
        "attach": args.attach,
        "ask": args.ask,
        "model_key": args.model_key,
    }
    rec = run_label_first(snap, args.user_id, ann, as_of=as_of, **kw)
    rec["label"] = args.label

    if args.baseline_run:
        universe = [int(k) for k in rec["assignments"]]
        stored = harness.score_stored_run(snap, args.baseline_run, universe, ann, [])
        rec["baseline_run"] = {
            "run_id": args.baseline_run,
            "scores": stored["scores"],
            "metrics": stored["metrics"],
        }
    if args.compare_record:
        other = json.loads(Path(args.compare_record).read_text(encoding="utf-8"))
        rec["compare_record"] = {
            "label": other.get("label"),
            "scores": other.get("scores"),
            "metrics": other.get("metrics"),
        }
    if args.stability_run:
        earlier = run_label_first(
            snap, args.user_id, ann, as_of=snap.run_started_at(args.stability_run), **kw
        )
        a = {int(k): v for k, v in earlier["assignments"].items()}
        b = {int(k): v for k, v in rec["assignments"].items()}
        rec["stability_vs_run"] = {"run_id": args.stability_run, **membership_ari(a, b)}
        stored_prev = snap.run_assignments(args.stability_run)
        stored_cur = snap.run_assignments(args.baseline_run) if args.baseline_run else {}
        if stored_prev and stored_cur:
            rec["stored_runs_stability"] = membership_ari(stored_prev, stored_cur)

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = cluster_eval._write_record(rec, out, args.label)
    s = rec["scores"]["topic_key"]
    print(
        f"[label_first_eval] {args.mode}: pages={rec['metrics']['n_pages']} clusters={rec['metrics']['n_clusters']} "
        f"noise={rec['metrics']['noise_count']} purity={s.get('purity')} ARI_all={s.get('ARI_all')} "
        f"keep_coverage={s.get('keep_coverage')} sizes={rec['size_distribution']} "
        f"superclusters={ {k: v for k, v in rec['supercluster_purity'].items() if k != 'per_group'} } "
        f"loo={rec['leave_one_out']} stability={rec.get('stability_vs_run')}"
    )
    print(f"[label_first_eval] wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
