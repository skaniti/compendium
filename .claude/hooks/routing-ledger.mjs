#!/usr/bin/env node
// SessionStart hook: injects the CURRENT surface-ownership ledger into context.
// CLAUDE.md carries the routing protocol (static); this carries the state
// (volatile -- rows flip every batch). Reading it here means the routing answer
// is already in context instead of being a file someone has to remember to open.
//
// Byte-identical in both repos by design: the repo identity is derived from the
// ledger's own live-home table, so installing is a plain copy and there is no
// wrong-repo variant to get wrong. Contains no surface names -- everything
// specific is read at runtime from the (private) ledger.
//
// Output is the structured-JSON hook envelope rather than plain stdout: the
// grouped ledger rides in additionalContext (model-only, same text as before)
// and systemMessage carries a one-line confirmation the terminal shows the
// user. Plain SessionStart stdout is injected silently, which reads as the
// hook never having fired.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const LEDGER_REL = "docs/project-plans/surface-ledger.md";
const NAME_MAX = 76;

const lines = [];
const out = (line = "") => lines.push(line);

// Hooks must never take a session down: any failure degrades to a short notice.
let summary;
try {
  summary = main();
} catch (err) {
  lines.length = 0;
  out(`ROUTING LEDGER unavailable (${err.message}). Follow CLAUDE.md`);
  out(`"Dual-repo routing guard" and read ${LEDGER_REL} manually.`);
  summary = `routing ledger UNAVAILABLE (${err.message}) -- guard degraded`;
}
console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join("\n"),
    },
    systemMessage: summary,
  }),
);
process.exit(0);

function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ledger = readFileSync(resolve(projectDir, LEDGER_REL), "utf8");

  const homes = parseLiveHomes(ledger);
  const thisRepo = identifyRepo(projectDir, homes);
  const rows = parseLedgerRows(ledger);
  if (!rows.length) throw new Error("no ledger rows parsed");

  const here = rows.filter((r) => r.home === thisRepo);
  const elsewhere = rows.filter((r) => r.home !== thisRepo);
  const frozen = rows.filter((r) => r.frozen).length;

  out(
    `ROUTING LEDGER -- dual-repo migration. This repo: ${thisRepo ?? "UNKNOWN"}.`,
  );
  out(`Source: ${LEDGER_REL} -- read it for Notes / parity-debt detail.`);

  if (!thisRepo) {
    // Identity is the one thing worth being loud about failing: without it the
    // groups below would be backwards, which is exactly the fork this prevents.
    out();
    out("!! Could not derive which repo this is from the ledger's");
    out("!! live-home table. Classify manually before implementing.");
  }

  emitGroup(`IMPLEMENT HERE (live home = ${thisRepo ?? "this repo"})`, here);
  emitGroup(
    `DO NOT IMPLEMENT HERE -- wrong-repo warning per CLAUDE.md, then stop`,
    elsewhere,
  );

  if (frozen) {
    out();
    out("! = porting-frozen: LOUDEST warning. Changes create parity debt");
    out("    + stale goldens. If it truly cannot wait it goes to the LIVE");
    out("    HOME with a dated parity-debt note on that ledger row.");
    out("    Exempt only if THIS session is the batch doing that port.");
  }

  if (!thisRepo) {
    return `routing ledger injected: repo UNKNOWN -- failed closed, all ${rows.length} rows wrong-repo`;
  }
  const frozenNote = frozen ? ` (${frozen} porting-frozen)` : "";
  return `routing ledger injected: ${thisRepo} -- ${here.length} implement-here / ${elsewhere.length} wrong-repo${frozenNote}`;
}

// Live-home table maps a home value (`explorer`) to a repo path (`~/dev/...`).
function parseLiveHomes(ledger) {
  const homes = [];
  for (const cells of tableRows(ledger)) {
    if (cells.length !== 3) continue;
    const value = unwrap(cells[0]);
    const path = unwrap(cells[2]);
    if (!value || !/^[~/]/.test(path)) continue;
    homes.push({ value, path: path.replace(/^~/, homedir()) });
  }
  return homes;
}

function identifyRepo(projectDir, homes) {
  const real = tryRealpath(projectDir);
  for (const home of homes) {
    // Both unresolvable would compare null === null -- never treat that as a hit.
    const homeReal = tryRealpath(home.path);
    if (real && homeReal === real) return home.value;
  }
  // Fallback for a clone living somewhere other than the canonical path.
  const dir = basename(projectDir);
  return homes.find((h) => basename(h.path) === dir)?.value ?? null;
}

// Ledger rows live under "## Ledger" -- the preamble tables must not leak in.
function parseLedgerRows(ledger) {
  const start = ledger.indexOf("\n## Ledger");
  if (start === -1) throw new Error("no '## Ledger' section");
  const rest = ledger.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);

  const rows = [];
  for (const cells of tableRows(section)) {
    if (cells.length < 4) continue;
    const [surface, home, batch, status] = cells.map(unwrap);
    if (!surface || surface === "Surface") continue;
    rows.push({
      surface,
      home,
      batch,
      status,
      frozen: status === "porting-frozen",
    });
  }
  return rows;
}

function emitGroup(title, rows) {
  out();
  out(`${title} -- ${rows.length}:`);
  if (!rows.length) {
    out("  (none)");
    return;
  }
  for (const r of rows) {
    const mark = r.frozen ? "!" : "-";
    const status = r.frozen ? "PORTING-FROZEN" : r.status;
    out(`  ${mark} ${truncate(r.surface)} [${r.batch}/${status}]`);
  }
}

function tableRows(text) {
  return text
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .filter((line) => !/^\s*\|[\s|:-]*\|\s*$/.test(line)) // separator rows
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|"));
}

function unwrap(cell) {
  return (cell ?? "").trim().replace(/^`|`$/g, "").trim();
}

function truncate(text) {
  return text.length > NAME_MAX ? `${text.slice(0, NAME_MAX - 1)}…` : text;
}

function tryRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
