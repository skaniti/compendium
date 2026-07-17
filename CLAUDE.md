# Compendium (Next.js) — project instructions

This repo is the born-clean, future-public home of the Compendium app. Its ENTIRE
git history goes public at the migration's publish flip — never commit anything
private (real data, secrets, hostnames, private operational detail). The
predecessor app (Dash + FastAPI) lives in `~/dev/private/compendium-explorer`
("explorer", private forever); we are migrating surface-by-surface, batch by batch.

`docs/project-plans/` is a gitignored symlink into the explorer repo (plans stay
out of public history). Edits to plan docs land in the explorer's working tree —
remind the user to commit them from an explorer session at milestones. Never
`git add -f` anything under it.

- Never push. Pushes are user-run only (`ALLOW_PUSH=1`); the guard stack enforces this.
- Commit format per `COMMIT-FORMAT.md`: parens-free `type: subject`, lowercase,
  <= 72 chars, no AI attribution of any kind (enforced by hooks).
- No real user data in fixtures — synthetic or scrubbed only.

## Dual-repo routing guard (check before implementing ANY request)

During the migration every surface has exactly one live home: explorer until
ported, this repo after. Requests will arrive in whichever repo happens to be
open — the guard makes acting on a wrong-repo request impossible to do silently.

On EVERY request that would change code, styles, or behavior (feature, bugfix,
tweak, refactor — anything beyond reading/answering):

1. **Classify** which surface(s) the request touches.
2. **Check the ledger:** `docs/project-plans/surface-ledger.md` — the single
   source of truth for surface -> live home -> batch -> status.
3. **Live home is THIS repo (`compendium`)** -> proceed normally. Say nothing
   about routing; the guard is silent when the repo is correct.
4. **Live home is `explorer`** -> DO NOT implement, not even "just a small
   change". Print the wrong-repo warning (template below) with a ready-to-paste
   kickoff prompt for an explorer session, then stop.
5. **Status `porting-frozen`** -> loudest warning: the surface is mid-port;
   changes on either side create parity debt and stale goldens. If the change
   truly cannot wait, it goes to the LIVE HOME and a dated parity-debt note MUST
   be added to that ledger row so the port re-captures goldens. (Exception: the
   executing batch session doing the port work here IS the port — proceed.)
6. **Surface unclear** -> ask which surface is meant before touching anything.

Exempt from the guard: pure questions/reads/analysis; edits under
`docs/project-plans/` (shared plan docs); repo infrastructure that is not an app
surface (guards, CI, tooling, tests for code this repo already owns).

### Wrong-repo warning template

```
🛑 WRONG REPO — this surface does not live here ------------------------------
Surface:    <ledger row>
Live home:  <explorer|compendium>   (this session: <current repo>)
Status:     <status> — <not-ported: still Dash-owned, port lands in batch NN |
             porting-frozen: MID-PORT, changes here create parity debt + stale
             goldens | flipped: the Next.js repo owns this now>
Implementing here would fork the surface across repos and break migration parity.
------------------------------------------------------------------------------
Paste this into a Claude Code session rooted at <owning repo path>:

  <kickoff: one line of repo context; the request restated verbatim;
  "check docs/project-plans/surface-ledger.md before starting">
```

### Guard layers (how this stays ADHD-proof)

- This section (loaded every session in this repo).
- Hookify `UserPromptSubmit` rule `.claude/hookify.surface-routing.local.md` —
  re-injects the check on every single prompt; zero reliance on anyone
  remembering. Gitignored; canonical copy + reinstall instructions live in
  `docs/project-plans/2026-07-07-220615-nextjs-mig-00-roadmap-and-status/routing-guard-handoff.md`.
- The explorer repo carries the mirror-image section + twin hookify rule
  (installed from the same handoff doc), so the guard fires in BOTH directions.
