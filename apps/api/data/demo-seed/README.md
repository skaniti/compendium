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

## Known limitation: preview images 404

`captured_assets` rows (image/stylesheet metadata referenced by archived
page HTML) ship in the seed, but their underlying binary files do not —
those live on disk under `data/captures/assets/` in the source deployment
and were never part of this export. The serving route exists as of the
post-flip closeout (API route `GET /captured-assets/{rel:path}` here in
apps/api, plus the bearer-carrying Next proxy in front of it in apps/web)
— the gap left is just the binaries. Net effect: the seeded demo's
page-preview images will 404 in the compose stack. This is a known,
harmless gap (the rest of the app — graph, diary, topic detail,
clustering — is unaffected); closing it
means re-exporting the binaries, tracked as follow-up work rather than
blocking this task.

## Synthetic augment (temporary, D10 c-1)

`demo_seed_augment.json` holds 94 SYNTHETIC page rows (archived, skipped and
pending) attached to the seed's existing captures. The real seed has no such
pages, so without it the Pipeline dev view's skip sections would render empty
against the demo. Rows carry no page content, embeddings or clusters, use only
the seed's own domains, and never appear in the graph or diary (both count
active pages only). Each `skip_gate` row also carries a `skip_category` matching its reason (others are null). `scripts/demo/load_demo_seed.py` inserts them right after
the `pages` table, in the same transaction and under the same user_id remap.

Regenerate (deterministic; rewrites an identical file for the same seed):

    cd apps/api && python scripts/demo/build_demo_seed_augment.py

Retirement: the demo-seed-maturity re-export deletes the augment file, the
generator, its test, and the loader step.
