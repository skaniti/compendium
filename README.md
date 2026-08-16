# Compendium

![CI](https://github.com/skaniti/compendium/actions/workflows/ci.yml/badge.svg)

I built Compendium to turn curiosity-driven browsing into a topic-based
knowledge compendium: every page you read gets clustered into topics, laid
out as an explorable constellation graph, and made queryable through a RAG
chat agent that cites its sources back onto the graph.

![Compendium app shell -- diary panel, constellation graph, topic detail](docs/readme/app-shell.png)

## Quickstart

Requires **Node 22+** (no Python, no database, no API keys). Everything below
is copy-pasteable in order on a fresh machine:

```bash
git clone https://github.com/skaniti/compendium.git
cd compendium
npm ci
npm run demo
```

`npm run demo` boots a small, dependency-free stub backend (`demo/server.mjs`)
that serves a curated demo compendium from static fixtures, then starts the
Next.js dev server pointed at it -- no real backend, no Postgres, no LLM keys.
It prints both URLs; open the Next one (`http://localhost:3000` unless that
port is already taken, in which case Next auto-increments and prints whatever
it actually bound). Ctrl-C tears down both processes together.

You land straight in the populated app -- no login required. The stub answers
unauthenticated requests as the built-in admin account, so the graph, diary,
topic detail, and chat are all live from the first paint.

## Demo notes

**Identity.** `npm run demo` gives you one identity with full control over a
local, synthetic compendium -- nothing to log into, nothing to configure. The
source also contains a demo/admin/view-as role system that backs my hosted
deployment; it's off by default here, gated behind `DEMO_ROLE_TOOLING` (stub
side) and `NEXT_PUBLIC_DEMO_ROLE_TOOLING` (frontend side), so a stranger
running the demo never sees it. The app still has a `/login` page -- I'm not
documenting credentials for it, since the default demo flow never needs it.

**Data.** I curated the demo compendium from real, publicly licensed web
pages (Wikipedia, arXiv, GitHub, Stack Exchange, and a few others) spanning
four topics -- diffusion models, Greek/Roman mythology, electronics/Arduino,
and cephalopods -- respread across a plausible browsing timeline that stays
"recent" no matter when you clone the repo. Full source list and licensing
notes: `demo/fixtures/ATTRIBUTION.md`.

**Chat.** I recorded 12 real question/answer runs from the live agent
(`demo/fixtures/chat/index.json` lists the exact questions); the search bar
at the bottom of the graph replays them token-by-token over SSE, complete
with source pills that frame the cited nodes back on the graph. Anything else
typed in falls back to a response that explains demo mode and suggests a
question from the list.

**Mutations.** Topic edits, exclusions, and preference writes persist for the
life of the stub process and reset on restart; `Recluster` waits a couple of
seconds and bumps the run number, same shape as the real thing.

![Topic detail and diary panels open against the graph](docs/readme/topic-detail.png)

![Streaming chat answer with source pills](docs/readme/chat.png)

## Tests

```bash
npm test
```

Runs the Vitest suite (component tests + the stub server's own smoke tests)
headlessly via jsdom.

## Architecture

- **Frontend:** Next.js (App Router) -- the whole UI you see above: graph
  canvas, diary/history panel, topic detail, header widgets, and the chat
  search bar.
- **API proxy:** `app/api/[...path]/route.ts` forwards every `/api/*` call
  verbatim to whatever `BACKEND_URL` points at (injecting the auth cookie,
  streaming SSE through unbuffered), so the frontend never talks to a backend
  host directly. `next.config.ts` carries one additional narrow rewrite for
  `/captured-assets/*` (page preview images/stylesheets), which the backend
  serves outside the `/api` prefix.
- **Demo backend:** `demo/server.mjs`, a dependency-free Node HTTP server that
  answers the same endpoint contract from static fixtures under
  `demo/fixtures/`. `npm run demo` (`demo/launcher.mjs`) boots it and points
  `BACKEND_URL` at it automatically.
- **Real backend:** a FastAPI service that isn't in this repo yet -- it
  arrives with a one-time monorepo extraction (`apps/api`, alongside this
  frontend as `apps/web`). Until then, `BACKEND_URL` is the entire contract
  between this frontend and whatever serves it.

## Status

This repo is mid-migration from an earlier Dash + FastAPI prototype into the
Next.js frontend you're looking at. What's ported and working: the graph's
surrounding chrome (diary/history, topic detail, header widgets), and the
first slice of the streaming chat experience. The constellation graph itself
(rendering, clustering, camera framing) is mid-port -- functional, as the
screenshots above show, but not yet feature-complete against the original.

Not yet migrated into this repo: the real FastAPI backend, the browser
extension, and the Android collector. All three exist in the predecessor
project and will land here as the migration continues.

## Known limitations

Graph rendering currently depends on noise proportion; eliminating that
dependency is tracked as follow-up work. The noise toggle and the admin-only
graph controls aren't gated in this build -- the source is right there if you
want to see them. The demo-account and view-as machinery is different: it
exists for my hosted deployment, and I gate it off by default here
(`DEMO_ROLE_TOOLING` / `NEXT_PUBLIC_DEMO_ROLE_TOOLING`) so a stranger's first
run stays a single, uncomplicated identity. `scripts/dev.sh` sets both flags
if you want that machinery running locally.

## Conventions

- **Commit format:** `docs/references/COMMIT-FORMAT.md` -- parens-free
  `type: subject`, lowercase, no AI attribution, enforced by a husky
  `commit-msg` hook.
- **Pushes are gated:** the `pre-push` hook refuses to push unless
  `ALLOW_PUSH=1` is set. I want pushing to be a conscious act in this repo.
- **Line endings:** LF repo-wide, enforced via `.gitattributes`.

## License

MIT -- see `LICENSE`.
