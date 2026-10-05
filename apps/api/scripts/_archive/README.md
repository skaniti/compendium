# scripts/_archive

One-time scripts whose job is done: backfills, audits, re-fetches and cleanups
that ran once against an existing database. They are kept for the record and
for a re-run if the same situation comes back, but they are not part of
routine operation. Recurring tools stay in `scripts/`.

Run them from `apps/api` with the archive path, e.g.
`python scripts/_archive/backfill_skip_categories.py --help`. Most are dry
runs unless given `--apply` or `--execute`; read the script's docstring first.

| Script | What it did |
|---|---|
| `apply_audit_drops.py` | Applied the approved drops from a skip gate v2.2 audit run (pairs with `audit_v2_2_reprocess.py`). |
| `audit_v2_2_reprocess.py` | Audited active pages against skip gate v2.2. |
| `backfill_content.py` | Propagated extracted text and re-fetched Reddit content. |
| `backfill_multimodal.py` | Re-fetched Wikipedia pages with the multimodal vision augment. |
| `backfill_skip_categories.py` | Gave historical skip-gate archives a standardized `skip_category` (2026-10). New skips get one when stored. |
| `backup_db_scheduled.sh` | Nightly backup wrapper for Windows Task Scheduler, from before the dedicated server. Superseded by the server's backup setup (`scripts/server-setup/section-20-backups.sh`). |
| `fetch_historical_content.py` | Fetched content for historical browsing data. |
| `fix_legacy_depth_values.py` | Rewrote legacy `processing_depth` values. |
| `refetch_github.py` | Re-fetched GitHub repo pages missing content. |
| `refetch_missing_content.py` | Re-fetched `page_content` rows missing fetched content. |
| `regate_dwell_archives.py` | Re-ran the content-and-URL skip gate (`skip_gate_v2_3`) on pages the March 2026 gate archived for missing dwell time; run locally 2026-09-29 and on hosted 2026-10-04, all restored. It rewrites the reason but not `skip_category`. |
| `smoke_test_featured_singletons.py` | End-to-end check of the featured-singletons refactor. |
| `diagnostics/dedup_audit.py` | Read-only audit of duplicate visits and content. |
| `diagnostics/dedup_burst_dryrun.py` | Dry-run report of same-host visit bursts (`--execute` merges them). |
| `diagnostics/dedup_cleanup_pages.py` | Retroactive cleanup of URL-mutation duplicates. New captures are collapsed live by `page_repo._collapse_consecutive_duplicates`. |

One-time scripts inside the backend package live in `backend/scripts/_archive/`.
