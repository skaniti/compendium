#!/usr/bin/env node
// Harness-layer guard: blocks pushes and hook-bypass commands BEFORE they run.
// Complements the git hooks (which --no-verify can skip and which the agent
// could satisfy by setting ALLOW_PUSH itself). Deterministic; no LLM.
import { readFileSync } from "node:fs";

let cmd = "";
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  cmd = input?.tool_input?.command ?? "";
} catch {
  process.exit(0); // not a tool call we understand -- don't block
}

function deny(reason) {
  console.error(reason);
  process.exit(2); // exit 2 = block the Bash call, surface the reason to Claude
}

if (/\bgit\s+push\b/.test(cmd))
  deny("BLOCKED: git push is user-run only (never-auto-push). Ask the user to push.");
if (/\bgh\s+pr\s+create\b/.test(cmd))
  deny("BLOCKED: 'gh pr create' pushes the branch; pushing is user-run only.");
if (/--no-verify\b/.test(cmd))
  deny("BLOCKED: --no-verify would skip the commit guards.");
if (/-c\s+core\.hooksPath=/.test(cmd))
  deny("BLOCKED: overriding core.hooksPath would disable the guards.");
if (/\bgit\s+commit\b/.test(cmd) && /co-authored-by:\s*claude|generated with[^\n]*claude|\u{1F916}/iu.test(cmd))
  deny("BLOCKED: remove the Claude attribution from the commit message.");

process.exit(0);
