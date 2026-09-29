import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker production image (apps/web/Dockerfile): trims the runtime image
  // to a minimal server.js + traced node_modules instead of shipping the
  // whole workspace + devDependencies. No effect on `next dev`/`npm run
  // demo`/Vercel (Vercel ignores this and uses its own output format).
  output: "standalone",

  // Dev-only: allow browsing the dev server from another machine (e.g. a
  // laptop over LAN) without Next refusing the HMR websocket upgrade.
  // The origin stays out of this tracked file -- set DEV_LAN_ORIGIN in
  // .env.local (hostname or IP, no scheme).
  ...(process.env.DEV_LAN_ORIGIN
    ? { allowedDevOrigins: [process.env.DEV_LAN_ORIGIN] }
    : {}),

  // /captured-assets/* used to be a rewrite here; it's now served by
  // app/captured-assets/[...path]/route.ts, which can inject the bearer.

  // Next 16.3+ `next dev` otherwise writes AGENTS.md + CLAUDE.md into this
  // directory on every start. The pointer they carry (read the bundled
  // node_modules/next/dist/docs/) lives in .claude/CLAUDE.md instead.
  agentRules: false,
};

export default nextConfig;
