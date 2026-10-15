"""Clustering eval harness CLI -- run the production clustering code offline and score it.

Usage (from ``apps/api``; the labelled set and the export live OUTSIDE the repo):

    # Run the current code on an export with the production knobs and score it
    python -m evaluation.clustering.cluster_eval run \\
        --export /path/to/export --user-id <id> \\
        --labels /path/to/page_annotations.jsonl --topic-map /path/to/topic_map.json \\
        --model text-embedding-3-small --umap-dims 10 --min-samples 3 --label prod-parity

    # Identity check: same, plus score the stored production run 227 on the same page set
    ... run ... --baseline-run 227

    # Score a stored run on its own page universe
    python -m evaluation.clustering.cluster_eval score-run --export ... --run-id 227 \\
        --labels ... --topic-map ...

    # Gate a candidate against a baseline record: exit 1 if any scored metric regresses
    python -m evaluation.clustering.cluster_eval compare baseline.json candidate.json --gate

    # Against the configured database instead of an export (may fill the embedding cache)
    python -m evaluation.clustering.cluster_eval run --source db --labels ... --topic-map ...

Run records are JSON files under ``--out-dir`` (default ``apps/api/data/eval_runs/clustering``,
git-ignored). They hold page ids and metrics only; ``--with-titles`` adds member titles
for human reading and must stay out of version control.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import UTC, datetime
from pathlib import Path

_API_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_API_ROOT) not in sys.path:
    sys.path.insert(0, str(_API_ROOT))

from evaluation.clustering import harness, scoring
from evaluation.clustering.export_loader import ExportSnapshot

DEFAULT_OUT_DIR = _API_ROOT / "data" / "eval_runs" / "clustering"
IDENTITY_TOLERANCE = 0.02
"""A re-run of the production config must reproduce a stored run within this on every
scored metric (proposal #2's identity check)."""


# ── helpers ──────────────────────────────────────────────────────────────


def _load_labels(args) -> dict[int, dict] | None:
    if not args.labels:
        return None
    return scoring.load_annotations(args.labels, topic_map=args.topic_map)


def _knobs(args) -> dict[str, object]:
    return {knob: getattr(args, knob, None) for knob in harness.KNOB_SETTINGS}


def _write_record(record: dict, out_dir: Path, label: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(tz=UTC).strftime("%Y%m%dT%H%M%S")
    path = out_dir / f"{ts}-{label}.json"
    path.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def _fmt(v) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.3f}"
    return str(v)


def print_summary(record: dict, key: str = "topic_key") -> None:
    m = record.get("metrics") or {}
    print(
        f"[cluster_eval] {record.get('label')}: pages={m.get('n_pages')} "
        f"clusters={m.get('n_clusters')} noise={m.get('noise_count')} "
        f"({m.get('noise_pct')}%) size_max={m.get('size_max')} "
        f"silhouette={_fmt(m.get('silhouette_cosine'))}"
    )
    scores = (record.get("scores") or {}).get(key)
    if scores:
        shown = (
            "purity",
            "inverse_purity",
            "ARI",
            "ARI_all",
            "NMI",
            "keep_coverage",
            "share_clusters_purity_lt_0.6",
            "noise_share",
            "n_pages",
        )
        print(
            f"[cluster_eval] scores[{key}]: "
            + " ".join(f"{k}={_fmt(scores.get(k))}" for k in shown)
        )
    for gs in record.get("guard_sets") or []:
        print(
            f"[cluster_eval] guard {gs['name']}: modal_share={gs['modal_cluster_share']}% "
            f"absent_or_noise={gs['n_absent_or_noise']}/{gs['n_pages']}"
        )


def print_comparison(rows: list[dict], ok: bool, title: str) -> None:
    print(f"[cluster_eval] {title}")
    print(f"  {'metric':<30} {'baseline':>9} {'candidate':>9} {'delta':>8}  ok")
    for r in rows:
        print(
            f"  {r['metric']:<30} {_fmt(r['baseline']):>9} {_fmt(r['candidate']):>9} "
            f"{_fmt(r['delta']):>8}  {'yes' if r['ok'] else 'NO'}"
        )
    print(f"  => {'PASS' if ok else 'FAIL'}")


# ── subcommands ──────────────────────────────────────────────────────────


def cmd_run(args) -> int:
    snapshot = ExportSnapshot(args.export) if args.source == "export" else None
    if args.user_id is None:
        if snapshot is None:
            from backend.api.main import get_default_user_id

            args.user_id = get_default_user_id()
        else:
            ids = snapshot.user_ids()
            if not ids:
                print("[cluster_eval] no captures in export", file=sys.stderr)
                return 2
            args.user_id = ids[0]
    ann = _load_labels(args)
    guard_sets = harness.load_guard_sets(args.guard_sets)

    as_of = args.as_of
    if as_of is None and args.baseline_run is not None and snapshot is not None:
        # Approximate the stored run's page set: an export taken after the run holds
        # pages the run never saw. Pass --as-of "" to disable.
        as_of = snapshot.run_started_at(args.baseline_run)
    as_of = as_of or None
    result = harness.run_clustering(
        source=args.source,
        user_id=args.user_id,
        snapshot=snapshot,
        knobs=_knobs(args),
        as_of=as_of,
    )
    source = {
        "kind": args.source,
        "path": str(args.export) if args.export else None,
        "user_id": args.user_id,
    }
    record = harness.build_record(
        label=args.label,
        source=source,
        result=result,
        ann=ann,
        guard_sets=guard_sets,
        with_titles=args.with_titles,
    )
    print(
        f"[cluster_eval] loaded {result['n_loaded']} pages -> "
        f"{result['filter_stats'].get('total_output')} clusterable -> "
        f"{len(result['pages'])} with embeddings "
        f"(missing_embeddings={result['missing_embeddings']}); "
        f"config={json.dumps(result['config'])}"
    )
    print_summary(record, key=args.key)
    if args.stability_trials:
        record["stability"] = harness.stability_trials(
            result["embeddings"],
            result["labels"],
            _knobs(args),
            args.user_id,
            args.stability_trials,
        )
        print(f"[cluster_eval] leave-one-out stability: {json.dumps(record['stability'])}")
    out_path = _write_record(record, Path(args.out_dir), args.label)
    print(f"[cluster_eval] wrote {out_path}")

    if args.baseline_run is not None:
        if snapshot is None:
            print("[cluster_eval] --baseline-run needs --source export", file=sys.stderr)
            return 2
        universe = [int(p["db_id"]) for p in result["pages"]]
        stored = harness.score_stored_run(snapshot, args.baseline_run, universe, ann, guard_sets)
        print_summary(stored, key=args.key)
        stored_path = _write_record(
            stored, Path(args.out_dir), f"{args.label}-stored-run-{args.baseline_run}"
        )
        print(f"[cluster_eval] wrote {stored_path}")
        if ann is not None:
            rows, ok = scoring.compare_scores(
                stored["scores"][args.key],
                record["scores"][args.key],
                tolerance=args.identity_tolerance,
            )
            # Identity is two-sided: a "better" number also means the code did not
            # reproduce the stored partition.
            rows = [
                {**r, "ok": r["delta"] is None or abs(r["delta"]) <= args.identity_tolerance}
                for r in rows
            ]
            ok = all(r["ok"] for r in rows)
            print_comparison(
                rows,
                ok,
                f"identity check vs stored run {args.baseline_run} "
                f"(|delta| <= {args.identity_tolerance} on scores[{args.key}])",
            )
            record["identity_check"] = {
                "baseline_run": args.baseline_run,
                "tolerance": args.identity_tolerance,
                "rows": rows,
                "ok": ok,
            }
            out_path.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
            return 0 if ok else 1
    return 0


def cmd_score_run(args) -> int:
    snapshot = ExportSnapshot(args.export)
    ann = _load_labels(args)
    guard_sets = harness.load_guard_sets(args.guard_sets)
    if args.universe_from:
        base = json.loads(Path(args.universe_from).read_text(encoding="utf-8"))
        universe = [int(k) for k in base["assignments"]]
    else:
        universe = sorted(snapshot.run_assignments(args.run_id))
    record = harness.score_stored_run(snapshot, args.run_id, universe, ann, guard_sets)
    print_summary(record, key=args.key)
    out_path = _write_record(record, Path(args.out_dir), record["label"])
    print(f"[cluster_eval] wrote {out_path}")
    return 0


def cmd_compare(args) -> int:
    base = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
    cand = json.loads(Path(args.candidate).read_text(encoding="utf-8"))
    b = (base.get("scores") or {}).get(args.key)
    c = (cand.get("scores") or {}).get(args.key)
    if not b or not c:
        print(f"[cluster_eval] both records need scores[{args.key}]", file=sys.stderr)
        return 2
    rows, ok = scoring.compare_scores(b, c, tolerance=args.tolerance)
    print_comparison(
        rows,
        ok,
        f"{Path(args.candidate).name} vs {Path(args.baseline).name} "
        f"(scores[{args.key}], tolerance {args.tolerance})",
    )
    if args.gate and not ok:
        return 1
    return 0


# ── parser ───────────────────────────────────────────────────────────────


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--labels", help="page_annotations.jsonl (private; path outside the repo)")
    p.add_argument("--topic-map", help="topic_map.json (private; path outside the repo)")
    p.add_argument("--guard-sets", help="guard_sets.json with named page-id sets (private)")
    p.add_argument(
        "--key",
        default="topic_key",
        choices=scoring.SCORE_KEYS,
        help="label grain for the console summary / gates (default topic_key)",
    )
    p.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cluster_eval",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="cluster an export (or the DB) and score the partition")
    run.add_argument("--source", choices=("export", "db"), default="export")
    run.add_argument("--export", help="directory of <table>.jsonl.gz files")
    run.add_argument("--user-id", type=int)
    run.add_argument("--label", default="run")
    run.add_argument(
        "--with-titles",
        action="store_true",
        help="add member titles to the record (never commit such a record)",
    )
    run.add_argument(
        "--baseline-run",
        type=int,
        help="also score this stored run on the same page set (identity check)",
    )
    run.add_argument("--identity-tolerance", type=float, default=IDENTITY_TOLERANCE)
    run.add_argument(
        "--as-of",
        help="ISO timestamp: ignore pages created after it "
        "(defaults to the baseline run's start when --baseline-run is given)",
    )
    run.add_argument(
        "--stability-trials",
        type=int,
        default=0,
        help="recluster N times with one random page removed and report membership ARI",
    )
    run.add_argument("--model", dest="model")
    run.add_argument("--text-contract", dest="text_contract")
    run.add_argument("--umap-dims", dest="umap_dims", type=int)
    run.add_argument("--umap-neighbors", dest="umap_neighbors", type=int)
    run.add_argument("--min-cluster-size", dest="min_cluster_size", type=int)
    run.add_argument("--min-samples", dest="min_samples", type=int)
    run.add_argument("--selection-method", dest="selection_method", choices=("eom", "leaf"))
    run.add_argument("--selection-epsilon", dest="selection_epsilon", type=float)
    _add_common(run)
    run.set_defaults(func=cmd_run)

    sr = sub.add_parser("score-run", help="score a stored recluster run from the export")
    sr.add_argument("--export", required=True)
    sr.add_argument("--run-id", type=int, required=True)
    sr.add_argument("--universe-from", help="run record whose page set defines the universe")
    _add_common(sr)
    sr.set_defaults(func=cmd_score_run)

    cp = sub.add_parser("compare", help="metric deltas between two run records")
    cp.add_argument("baseline")
    cp.add_argument("candidate")
    cp.add_argument("--key", default="topic_key", choices=scoring.SCORE_KEYS)
    cp.add_argument("--tolerance", type=float, default=0.0)
    cp.add_argument("--gate", action="store_true", help="exit 1 when any gated metric regresses")
    cp.set_defaults(func=cmd_compare)
    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = build_parser().parse_args(argv)
    if args.cmd == "run" and args.source == "export" and not args.export:
        build_parser().error("--export is required with --source export")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
