# Visual scripts

Playwright harnesses used to verify the Almagest font behaviour on the graph
view. These are ad hoc debugging tools, not part of the app build.

## What's here

- `fontcheck.mjs` -- drives the app through five graph states (fit, zoomed
  in, display-tier font forced, text-tier font forced, deep zoom), taking a
  screenshot at each and reading back computed font state (family, size,
  painted size, font-loading status) for supercluster labels and edge chips.
  Also records every `/fonts/` response it observes. Writes `*.png` per state
  plus one `readback.json` with the full readback.
- `racecheck.mjs` -- measures how graph render time relates to font-file
  arrival time, then checks whether supercluster-name labels overlap group
  caption text once the view settles (including after a small zoom nudge).
  Writes `*.png` per checkpoint and logs font response timings and overlaps.

## Prerequisites

- Node 22+.
- Playwright, with a cached Chromium build. Playwright is intentionally not a
  dependency of this repo -- either:
  - install it somewhere else and point `PLAYWRIGHT_NODE_MODULES` at that
    `node_modules` directory, or
  - add it locally for this session (`npm install playwright` in a scratch
    location, or into this repo temporarily -- do not commit it to
    `package.json` as part of routine use) and run
    `npx playwright install chromium` once, so a Chromium build is cached.

## Target: the demo-stub harness, never :3000

Both scripts take a `<baseURL>` argument and are meant to run against a
disposable demo stub, not the developer's live `:3000` Next.js dev server:

1. Start the demo stub backend on `:8011`:
   ```
   cd apps/web && PORT=8011 node demo/server.mjs
   ```
2. Next.js refuses to run a second dev server out of the same app directory,
   and Turbopack rejects a `node_modules` symlink that resolves outside the
   app root -- so run a full copy of `apps/web` on `:3001` against the stub,
   with the copy living inside the repo (`logs/` is gitignored and works well
   for this):
   ```
   cp -r apps/web logs/web-visual-copy
   cd logs/web-visual-copy && BACKEND_URL=http://localhost:8011 PORT=3001 npm run dev
   ```
3. Point the scripts at `http://localhost:3001`.

When done, stop only the `:3001` and `:8011` processes you started for this --
never touch anything already running on `:3000`.

## Usage

```
node scripts/visual/fontcheck.mjs http://localhost:3001 logs/fontcheck-out <login-email>
node scripts/visual/racecheck.mjs http://localhost:3001 logs/racecheck-out
```

`fontcheck.mjs` only needs `FC_PASSWORD` set if the target shows a login form
(the demo stub is signed in by default, so normally it isn't needed).

## Output layout

Each script writes into `<outDir>` (created if missing):

- `<outDir>/*.png` -- one screenshot per state/checkpoint.
- `<outDir>/readback.json` -- `fontcheck.mjs` only: the full computed-font
  readback for every state plus observed font responses.
