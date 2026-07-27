# Contributing

## Setup

`npm ci` installs dependencies and (via the `prepare` script) activates the
husky git hooks. Run it before your first commit -- the hooks are what enforce
the conventions below.

## Commit messages

Subjects are `type: subject`. The full convention lives in
[`docs/references/COMMIT-FORMAT.md`](../docs/references/COMMIT-FORMAT.md); the
`commit-msg` hook enforces it locally.

## Pushes

The `pre-push` hook exits unless `ALLOW_PUSH=1` is set (`ALLOW_PUSH=1 git
push`). Deliberate friction -- pushing is a conscious action in this repo.

## Tests

`npm test` runs the vitest suite once; `npm run test:watch` keeps it running.
