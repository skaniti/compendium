# Portability benchmark harness

Scores grouping designs against an externally labelled page set (for example public
corpora with human-assigned categories), per synthetic user and per nested size. Corpora,
labels, embeddings and outputs are passed by path; nothing corpus-specific lives here.

Modules:

- `batch_io.py`: Message Batches lines for the production labeller (`page_labeller`
  prompt, schema and size; no `temperature`) and parsing of the results with the
  production `parse_labels`.
- `metrics.py`: purity, inverse purity and ARI with noise as singletons (via the frozen
  `scoring.score`), coverage (share of pages in a group of at least 3), size
  distribution, supercluster scores and 10k-to-50k-style stability (ARI, co-membership
  recall, survival).
- `hdbscan_candidate.py`: the production HDBSCAN path at prod parity
  (text-embedding-3-small, UMAP 10, min_samples 3, eom, `n // 150` floor) and the hybrid
  supercluster geometry without keywords.
- `thresholds.py`: the production `ShelfCanonicaliser` run offline in arrival order.
  "Same shelf?" answers come from a cache of batch answers keyed by the exact prompt.
  Unknown prompts are answered "no", which is the production fail-open, and are returned
  as pending so they can be asked in the next batch. One pass yields every nested size.
- `llm_shelves.py`: prototype of LLM grouping of subtopics into shelves. A group call is
  made per category, then new strings are placed in chunks against the existing shelf
  names. The induced-taxonomy variant uses one induce call, and its place calls list
  every shelf. Strings the model leaves out are retried in the next wave.
- `runner.py`: `run`, `stability` and `table` CLI. Candidates follow the `CANDIDATES`
  contract.

```
cd apps/api
python -m evaluation.clustering.portability.runner run --candidate hdbscan_prod \
    --pages PAGES.parquet --user U --size N --emb-npy E.npy --emb-ids IDS.json --out DIR
python -m evaluation.clustering.portability.runner stability --out DIR --candidate C \
    --user U --small 10000 --large 50000
python -m evaluation.clustering.portability.runner table --out DIR
python -m pytest tests/test_portability_metrics.py tests/test_portability_label_first.py -q --noconftest
```

`PAGES.parquet` needs `id`, `user`, `order` (arrival order; size N = `order < N`),
`fine`, `coarse` and `coarse_src`. These tests need no database, which is why they run
with `--noconftest`.
