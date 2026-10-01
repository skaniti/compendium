import type { NextConfig } from "next";

const devOrigins = (process.env.DEV_LAN_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // Docker production image (apps/web/Dockerfile): trims the runtime image
  // to a minimal server.js + traced node_modules instead of shipping the
  // whole workspace + devDependencies. No effect on `next dev`/`npm run
  // demo`/Vercel (Vercel ignores this and uses its own output format).
  output: "standalone",

  // Dev-only: allow browsing the dev server from another machine (e.g. a
  // laptop over LAN or the tailnet) without Next refusing the HMR websocket
  // upgrade. The origins stay out of this tracked file -- set DEV_LAN_ORIGIN
  // in .env.local to a comma-separated list of hostnames/IPs, no scheme.
  ...(devOrigins.length > 0 ? { allowedDevOrigins: devOrigins } : {}),

  // /captured-assets/* used to be a rewrite here; it's now served by
  // app/captured-assets/[...path]/route.ts, which can inject the bearer.

  // Next 16.3+ `next dev` otherwise writes AGENTS.md + CLAUDE.md into this
  // directory on every start. The pointer they carry (read the bundled
  // node_modules/next/dist/docs/) lives in .claude/CLAUDE.md instead.
  agentRules: false,
};

export default nextConfig;
