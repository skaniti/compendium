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

## Preview assets (known limitation: 70 still 404)

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
demo account: 2,971 of the 3,041 seeded rows return 200 with the seeded
byte size, and a different login gets 404 on the same paths. All 157 pages
with linked assets render a preview; 130 of them resolve every asset they
reference.

The other 70 rows have no file anywhere in this repo.
`apps/web/demo/tools/capture-fixtures.mjs` only downloads assets that the
preview HTML referenced when the fixtures were captured, and for these pages
that HTML referenced fewer assets than the seed links (the lilianweng post's
fixture preview referenced none of its 19 images; the YouTube page has no
fixture preview). All 70 belong to 32 pages:

| Pages | Missing files | Effect on the rendered preview |
| --- | --- | --- |
| 23 arXiv abstracts | 7 (shared arxiv.org assets) | 2-3 of 7-8 references broken per page |
| lilianweng.github.io diffusion post | 19 | all 19 images broken |
| SparkFun PWM tutorial | 8 | 6 of 8 references broken |
| Adafruit RGB LED lesson | 23 | 1 of 2 references broken |
| YouTube watch page | 4 (CSS) | all 4 stylesheets missing |
| 3 Gutenberg ebooks, 2 GitHub repos | 5 + 4 | none referenced, no visible effect |

That leaves 27 previews with a broken image or stylesheet. The rest of the
app (graph, diary, topic detail, clustering) is unaffected. Closing the gap
means shipping those 70 files next to the others. The fixture directory also
holds 77 files with no seed row. The compose stack never requests them.

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
