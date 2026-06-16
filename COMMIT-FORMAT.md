# Commit format (compendium)

Subjects: `type: subject`

- **type** is one of: `feat fix refactor docs chore test perf style`
- **No scope parens.** `docs: add x` -- yes. `docs(plans): add x` -- no.
  (Description parens later are fine: `docs: defer views (follow-up)`.)
- Lowercase first word of the subject; no trailing period; <= 72 chars.
- Body (optional): blank line after subject; no hard wraps (one logical line
  per paragraph).
- **No Claude attribution.** No `Co-Authored-By: Claude`, no "Generated with
  Claude", no robot emoji.

Pushes are user-run only. The assistant never pushes.

This file is the single source of truth. The `.husky/commit-msg` regex and the
`.claude/hooks/guard-git.mjs` deny rule both derive from it; keep them in sync.
