# Compendium

![CI](https://github.com/skaniti/compendium/actions/workflows/ci.yml/badge.svg)

Turn curiosity-driven browsing into a topic-based knowledge compendium: every
page you read gets clustered into topics, laid out as an explorable
constellation graph, and made queryable through a RAG chat agent that cites
its sources back onto the graph.

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

**Accounts.** The stub implements a full login/logout/refresh flow against
two fixed accounts:

| Email               | Password | Role  |
| ------------------- | -------- | ----- |
| `admin@demo.local`  | `admin`  | admin |
| `demo@demo.local`   | `demo`   | demo  |

You can log in as either. Logging in directly as the demo account is
write-gated: mutations (topic edits, exclusions, preference writes, etc.) get
rejected. Logging in as admin unlocks a "view as demo" control (in the
graph's debug overlay, top-left of the canvas) that lets an admin browse the
demo account's view while retaining full write access, plus a "return to
admin" control to switch back -- the same admin/demo/view-as loop the hosted
deployment uses.

**Data.** The demo compendium is a curated snapshot of real, publicly
licensed web pages (Wikipedia, arXiv, GitHub, Stack Exchange, and a few
others) spanning four topics -- diffusion models, Greek/Roman mythology,
electronics/Arduino, and cephalopods -- respread across a plausible browsing
timeline that stays "recent" no matter when you clone the repo. Full source
list and licensing notes: `demo/fixtures/ATTRIBUTION.md`.

**Chat.** The search bar at the bottom of the graph replays 12 recorded
question/answer runs from the real agent (`demo/fixtures/chat/index.json`
lists the exact questions) token-by-token over SSE, complete with source
pills that frame the cited nodes back on the graph. Anything else typed in
falls back to a response that explains demo mode and suggests a question
from the list.

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

- **Frontend:** Next.js (App Router), the whole UI you see above -- graph
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

Graph rendering currently depends on noise proportion, and eliminating the
dependency is tracked as follow-up work. Relatedly: this OSS build has no
dev/admin split on the noise toggle or the admin-only graph controls --
gating hides nothing in source you can read yourself. The role mechanics
(admin/demo/view-as) stay in place because they serve the hosted deployment,
not because anything here is locked down from you.

## Conventions

- **Commit format:** `docs/references/COMMIT-FORMAT.md` -- parens-free
  `type: subject`, lowercase, no AI attribution, enforced by a husky
  `commit-msg` hook.
- **Pushes are gated:** the `pre-push` hook refuses to push unless
  `ALLOW_PUSH=1` is set. Deliberate friction -- pushing is a conscious act in
  this repo.
- **Line endings:** LF repo-wide, enforced via `.gitattributes`.

## License

MIT -- see `LICENSE`.
