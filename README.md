# Compendium

[CI](https://github.com/skaniti/compendium/actions/workflows/ci.yml)

This project aims to turn curiosity-driven browsing into a topic-based
knowledge compendium. Every page browsed gets filtered through a skip gate
and then clustered into topics, laid out as an explorable constellation
graph, and made queryable through a RAG chat agent that cites its sources
back onto the graph. On top of the automatically-clustered layer, users can
manually select "superclusters" (clusters of clusters) representing topics
they are interested in to highlight in the graph.

![Compendium app shell — diary panel, constellation graph, topic detail](docs/readme/app-shell.png)

## Quickstart

Requires **Node 22+**. To set up, copy-paste the below:

```bash
git clone https://github.com/skaniti/compendium.git
cd compendium
npm ci
npm run demo
```

`npm run demo` boots a dependency-free stub backend (`demo/server.mjs`)
serving a curated demo compendium from static fixtures, plus the Next.js
dev server pointed at it. The demo drops the user straight into the
populated app: graph, diary, topic detail, and chat are live from the first
paint, under a single local identity with full control over the synthetic
data. Demo mode exists to explore the app before committing to personal
use; building a compendium from real browsing requires the backend and
collectors, which arrive as the migration continues.

## Demo notes

**Data:** The demo compendium is curated from real, publicly licensed web
pages (Wikipedia, arXiv, GitHub, Stack Exchange, and a few others) spanning
four topics — diffusion models, Greek/Roman mythology, electronics/Arduino,
and cephalopods — respread across a plausible browsing timeline that stays
"recent" no matter when the repo is cloned. Full source list and licensing
notes: `demo/fixtures/ATTRIBUTION.md`.

**Chat:** 12 question/answer runs from the live agent are recorded in
`demo/fixtures/chat/index.json`. The search bar at the bottom of the graph
replays them token-by-token over SSE, complete with source pills that frame
the cited nodes back on the graph. Anything else typed in falls back to a
response that explains demo mode and suggests a question from the list.

**Mutations:** Topic edits, exclusions, and preference writes persist for
the life of the stub process and reset on restart. Clicking `Recluster`
waits a couple of seconds and bumps the run number but does not actually
recluster the data in demo mode.

![Topic detail and diary panels open against the graph](docs/readme/topic-detail.png)

![Streaming chat answer with source pills](docs/readme/chat.png)

## Tests

```bash
npm test
```

Runs the Vitest suite (component tests + the stub server's own smoke tests)
headlessly via jsdom.

## Architecture

- **Frontend:** Next.js (App Router) — the UI seen above: graph canvas,
  diary/history panel, topic detail, header widgets, and the chat search
  bar.
- **API proxy:** `app/api/[...path]/route.ts` forwards every `/api/*` call
  verbatim to whatever `BACKEND_URL` points at (injecting the auth cookie,
  streaming SSE through unbuffered), so the frontend never talks to a
  backend host directly. `next.config.ts` carries one additional narrow
  rewrite for `/captured-assets/*` (page preview images/stylesheets), which
  the backend serves outside the `/api` prefix.
- **Demo backend:** `demo/server.mjs`, a dependency-free Node HTTP server
  that answers the same endpoint contract from static fixtures under
  `demo/fixtures/`. `npm run demo` (`demo/launcher.mjs`) boots it and
  points `BACKEND_URL` at it automatically.
- **Real backend:** a FastAPI service that isn't in this repo yet — it
  arrives with a one-time monorepo extraction (`apps/api`, alongside this
  frontend as `apps/web`). Until then, `BACKEND_URL` is the entire contract
  between this frontend and whatever serves it.

## Status

This repo is mid-migration from an earlier Dash + FastAPI prototype into
this Next.js frontend. Currently ported and working: the graph's
surrounding chrome (diary/history, topic detail, header widgets) and the
first slice of the streaming chat experience. The constellation graph
itself (rendering, clustering, camera framing) is mid-port — functional,
as the screenshots above show, but not yet feature-complete against the
original.

Not yet migrated into this repo: the real FastAPI backend, the browser
extension, and the Android collector. All three exist in the predecessor
project and will land here as the migration continues.

## Known limitations

The settled graph layout is sensitive to noise proportion: showing or
hiding noise re-runs the full force simulation, and different node counts
can settle into visibly different arrangements. Removing that sensitivity
is tracked as follow-up work. The noise toggle and the
admin-only graph controls are not gated in this build. The demo-account and
view-as machinery is different: it exists for the hosted deployment and is
off by default, gated behind `DEMO_ROLE_TOOLING` (stub) and
`NEXT_PUBLIC_DEMO_ROLE_TOOLING` (frontend). The `/login` page belongs to
that machinery; the default demo flow never needs it. `scripts/dev.sh` sets
both flags for development with the role machinery enabled.

## Conventions

- **Commit format:** `docs/references/COMMIT-FORMAT.md` — parens-free
  `type: subject`, lowercase, no AI attribution, enforced by a husky
  `commit-msg` hook.
- **Pushes are gated:** the `pre-push` hook refuses to push unless
  `ALLOW_PUSH=1` is set.
- **Line endings:** LF repo-wide, enforced via `.gitattributes`.

## License

MIT — see `LICENSE`.
