# Clustering eval harness

Runs the production clustering code (`ClusteringService`: load -> filter -> embed ->
HDBSCAN) offline and scores the partition against a labelled page set, so a config or
code change can be gated on "no metric below baseline" instead of hand-reading dumps.

```
cd apps/api
python -m evaluation.clustering.cluster_eval run \
    --export /private/export --user-id <id> \
    --labels /private/page_annotations.jsonl --topic-map /private/topic_map.json \
    --model text-embedding-3-small --umap-dims 10 --min-samples 3 --selection-method eom \
    --label prod-parity --baseline-run <latest completed run id>
python -m evaluation.clustering.cluster_eval compare baseline.json candidate.json --gate
```

- `run` reads a `<table>.jsonl.gz` export (`--source export`, no DB, no API keys; pages
  without a cached vector are dropped and counted) or the configured database
  (`--source db`; may fill the embedding cache like a nightly run). Knob flags override
  `backend.config.settings` for the run only.
- `--baseline-run N` scores stored run N on the same page set and prints the identity
  check (every scored metric within `--identity-tolerance`, default 0.02; two-sided).
  The page set is restricted to pages created before run N started (`--as-of`).
- `score-run` scores a stored run on its own page universe; `compare --gate` exits 1
  when any gated metric (purity, inverse purity, ARI, ARI_all, NMI, NMI_all,
  keep coverage; noise share and low-purity share inverted) regresses.
- `--guard-sets guard_sets.json` reports modal-cluster share for named page-id sets.

Metric definitions live in `scoring.py` and are frozen on purpose. The labelled set,
the topic map, guard sets and exports are private inputs passed by path; run records
go to `apps/api/data/eval_runs/clustering/` (git-ignored) and hold page ids only
unless `--with-titles` is given.
