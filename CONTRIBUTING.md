# Contributing

## Status

Compendium is primarily a solo personal project. Pull requests are welcome;
response cadence is best-effort, not contractual.

## Local development

- Frontend only, zero setup: `npm ci && npm run demo` (see the README
  Quickstart). Everything runs against a static demo compendium.
- Full stack: `docker compose up --build` (README, "Full-stack quickstart
  (Docker)").
- Frontend against a backend you already run: `bash scripts/dev.sh`, which
  takes `BACKEND_URL` from the environment (default `http://localhost:8001`)
  and reads `BACKEND_DIR` from `apps/web/.env.local` (an exported
  `BACKEND_DIR` wins over the `.env.local` value).

## Running tests

- Frontend and demo stub: `npm test` (Vitest, jsdom); `npm run test:watch`
  keeps it running.
- Backend: `cd apps/api && python -m pytest` against the test database from
  `apps/api/docker/docker-compose.dev.yml`; see `apps/api/.env.example` for
  the connection settings.
- Browser extension: `npm run test:extension` (`node --test` over
  `apps/extension/tests/`).
- Lint: `npm run lint`.

## Code style

- TypeScript and JavaScript: eslint via `npm run lint`.
- Python: ruff.
- Line endings are LF repo-wide, enforced by `.gitattributes`.

## Commits and pull requests

- Commit subjects follow `docs/references/COMMIT-FORMAT.md`: `type: subject`,
  lowercase, no scope parentheses, 72 characters or fewer. A husky
  `commit-msg` hook enforces it once you run `npm ci`.
- The `pre-push` hook refuses every push unless `ALLOW_PUSH=1` is set
  (`ALLOW_PUSH=1 git push`). Once `npm ci` has installed the hooks that
  applies to pushes to your own fork too; the friction is deliberate.
- Branch from `main`. Keep pull requests reasonably scoped and put the
  reasoning in the description.
- No CLA and no DCO: the MIT license already grants the rights.

## Reporting issues

File a GitHub issue; no template required. A reproducible case ships faster.

## Code of conduct

This project follows the Contributor Covenant; see `CODE_OF_CONDUCT.md`.

## Security

See `SECURITY.md`.
