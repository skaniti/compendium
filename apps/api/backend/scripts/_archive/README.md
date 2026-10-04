# backend/scripts/_archive

One-time jobs from the backend package whose work is done. Run them as
modules from `apps/api`, e.g. `python -m backend.scripts._archive.dq_rec_sweep --help`.
The dqBot manifest scripts read a manifest JSON next to the script; the
manifests were never committed, so those scripts do nothing useful without one.

| Script | What it did |
|---|---|
| `backfill_embedding_gists.py` | Populated `embedding_gists` (resumable). |
| `dq_payload_backfill.py` | Backfilled split-recommendation action payloads in the dqBot queue. |
| `dq_queue_triage.py` | Applied a triage disposition manifest to the dqBot queue. |
| `dq_rec_sweep.py` | Applied a recommendation-sweep disposition manifest to the dqBot queue. |
| `dq_vocab_canonicalize.py` | Applied a vocabulary canonicalization manifest to the dqBot issue-type registry. |

Recurring backend scripts stay in `backend/scripts/` (the catch-up job imports
`backfill_chunks` and `backfill_learning_classification` from there). Top-level
one-time scripts live in `scripts/_archive/`.
