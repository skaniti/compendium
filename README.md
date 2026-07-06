# Compendium

Turn curiosity-driven browsing into a topic-based knowledge compendium.

This repo is the public-bound home of the Compendium app. Today it holds the
Next.js web frontend: a streaming chat over the compendium's RAG agent.

**Status: work in progress, pre-release.** The decided end-state is a
monorepo -- `apps/web` (this frontend), `apps/api` (FastAPI backend via a
one-time clean extraction), the browser extension, and the Android collector,
plus a synthetic demo dataset and a clone-and-run path. Code lands here born
clean; real captured data never ships.

## What's here today

- Next.js (App Router) chat frontend for the agent's SSE stream: typed event
  parser, streaming query client with abort support, faithful markdown
  rendering (DOMPurify-sanitized, typographer off), source pills, tool trace.
- An `/api/[...path]` proxy route that injects the JWT (held in an HttpOnly
  cookie by the login/logout routes) and streams SSE through unbuffered, with
  client-abort propagation to the backend.
- Tests: vitest + testing-library (`npm test`).

## Running it

Requires a running Compendium backend (FastAPI; not yet in this repo --
`apps/api` arrives with the monorepo extraction).

```
npm ci
cp .env.example .env.local   # set BACKEND_URL (+ BACKEND_DIR for dev.sh)
npm run dev                  # frontend only
bash scripts/dev.sh          # frontend + auto-started backend, logs in logs/
```

## Conventions

- Commit format: `COMMIT-FORMAT.md` (enforced by the husky `commit-msg` hook).
- Pushes are explicitly gated: the `pre-push` hook exits unless `ALLOW_PUSH=1`
  is set. Deliberate -- pushing is a conscious action in this repo.
- Line endings are LF repo-wide via `.gitattributes`.

## License

MIT -- see `LICENSE`.
