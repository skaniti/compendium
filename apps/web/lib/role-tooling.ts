// Role-tooling opt-in (frontend half; stub-side sibling is
// DEMO_ROLE_TOOLING in demo/server.mjs's startServer): OFF by default, so a
// stranger running `npm run demo` (or plain `npm run dev`) never sees the
// "View as demo" / "Return to admin" header controls (components/Header.tsx),
// regardless of what `role`/`actingAsDemo` useSession() happens to report.
// The maintainer's own dev stack (scripts/dev.sh) sets
// NEXT_PUBLIC_DEMO_ROLE_TOOLING=1; demo/launcher.mjs (`npm run demo`)
// deliberately does not. Read live (not cached at module scope) via a
// literal `process.env.NEXT_PUBLIC_...` reference -- same convention as
// SessionKeeper.tsx's readIdleMinutes -- so Next's client build can still
// statically inline it per the NEXT_PUBLIC_* convention while a test can
// still override it per-case. Accepts "1" or "true" (anything else,
// including unset, is off) -- same accepted-value contract as
// demo/server.mjs's isEnvFlagOn (kept as two independent implementations,
// one per process; see that function's doc comment).
export function isRoleToolingVisible(): boolean {
  const flag = process.env.NEXT_PUBLIC_DEMO_ROLE_TOOLING;
  return flag === "1" || flag === "true";
}
