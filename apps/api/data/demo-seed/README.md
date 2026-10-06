# Demo seed

`demo_seed.json.gz` is a reviewed, portable export of the demo compendium:
158 curated public pages (Wikipedia 125, arXiv 23, Gutenberg 3, plus a
handful of GitHub/StackExchange/tutorial/YouTube singletons) processed through the
full production pipeline — fetch, skip-gate, summarization, chunking + chunk
embeddings, page embeddings, clustering-text embeddings, HDBSCAN clustering,
supercluster grouping, and featured-singleton selection. It's the same
corpus documented in `apps/web/demo/fixtures/ATTRIBUTION.md` (source list +
licensing notes), captured post-pipeline instead of pre-pipeline.

Loading it (`apps/api/scripts/demo/load_demo_seed.py`) turns the Docker
Compose clone-and-run stack (see the repo root README's "Full-stack
quickstart (Docker)") from an empty-but-logged-in demo account into a fully
populated one — graph, diary, topic detail all have real data on first
`docker compose up`, no LLM API keys or capture pipeline required.

## Provenance

Exported 2026-08-30 from the project's own demo account (`user_id 153` in
the source database) at schema version `043_dq_run_kind_and_gate`. The
export embeds a manifest (row counts per table, insert order, source user
id, schema version) that the loader validates against the target
database's `schema_migrations` before writing anything.

The tooling that *regenerates* this dataset from scratch (running the 158
source URLs back through the live capture pipeline — LLM calls, real API
spend) lives in the private predecessor repo, not here. `demo_seed.json.gz`
is a point-in-time snapshot, not something this repo can rebuild on its
own; `apps/api/scripts/demo/ingest_demo_v1.py` is the closest thing this
repo carries to that pipeline (a smaller, by-hand-keyed subset — see its
own docstring).

## Attribution

Full source list and per-domain licensing notes:
`apps/web/demo/fixtures/ATTRIBUTION.md`. Same corpus, same terms — this
file just describes the *processed* (post-pipeline) form of the data the
attribution doc already covers.

## Preview assets

`captured_assets` rows (image/stylesheet metadata referenced by archived
page HTML) ship in the seed, but their binary files are not part of this
export. The compose stack gets them from the frontend-only demo instead:
the root `docker-compose.yml` mounts
`apps/web/demo/fixtures/assets/captured-assets` read-only at the API's
assets base dir (`/app/data/captures/assets`). Those files use the same
`<aa>/<sha>.<ext>` layout as `captured_assets.file_path`, so
`GET /captured-assets/{rel:path}` serves them directly. The route's owner
check passes for the demo login because the loader remaps every row's
`user_id` to the demo account.

Verified 2026-10-05 against a freshly built compose stack, logged in as the
demo account: all 3,041 seeded rows return 200, and a different login gets
404 on the same paths. All 157 pages with linked assets render a preview
that resolves every asset it references.

70 of those files were backfilled on 2026-10-05.
`apps/web/demo/tools/capture-fixtures.mjs` only downloads assets that the
preview HTML referenced when the fixtures were captured, and for 32 pages
that HTML referenced fewer assets than the seed links (the lilianweng
diffusion post's fixture preview referenced none of its 19 images; the
YouTube page has no fixture preview). Where they came from:

- 66 re-downloaded from the row's `source_url`, sha256 identical to the row.
- 3 from Wayback Machine captures, sha256 identical to the row: two
  cdn-learn.adafruit.com lesson images and the GitHub release badge on the
  arduino/Arduino page (via its camo.githubusercontent.com URL).
- 1 with no byte-identical copy available: the Gutenberg cover for ebook
  6130, at
  `31/3172a7c489d13904dfb382f865b5603d376495d97d5f1da860ea0c4b390e687a.jpg`.
  The file is the current version of the same URL, so its size (16,452 B)
  and hash do not match the row (8,818 B). The route serves it anyway,
  since it reads the file by path.

The fixture directory also holds 77 files with no seed row. The compose stack
never requests them.

## Synthetic augment (temporary, D10 c-1)

`demo_seed_augment.json` holds 113 SYNTHETIC page rows (archived, skipped and
pending) attached to the seed's existing captures. The real seed has no such
pages, so without it the Pipeline dev view's skip sections would render empty
against the demo. Rows carry no page content, embeddings or clusters, use only
the seed's own domains, and never appear in the graph or diary (both count
active pages only). Each LLM-gate `skip_gate` row also carries a `skip_category` matching its reason; URL-pattern `skip_gate` rows (summary "URL pattern skipped: ...") and all other rows have a NULL one. `scripts/demo/load_demo_seed.py` inserts them right after
the `pages` table, in the same transaction and under the same user_id remap.

Regenerate (deterministic; rewrites an identical file for the same seed):

    cd apps/api && python scripts/demo/build_demo_seed_augment.py

Retirement: the demo-seed-maturity re-export deletes the augment file, the
generator, its test, and the loader step.
