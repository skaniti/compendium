import type { NextConfig } from "next";

// Same default-resolution convention as app/api/[...path]/route.ts's own
// BACKEND const -- keep the two in sync.
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

const nextConfig: NextConfig = {
  // Dev-only: allow browsing the dev server from another machine (e.g. a
  // laptop over LAN) without Next refusing the HMR websocket upgrade.
  // The origin stays out of this tracked file -- set DEV_LAN_ORIGIN in
  // .env.local (hostname or IP, no scheme).
  ...(process.env.DEV_LAN_ORIGIN
    ? { allowedDevOrigins: [process.env.DEV_LAN_ORIGIN] }
    : {}),

  // /captured-assets/* is a TOP-LEVEL path the stub/real backend serves
  // (not under /api -- see demo/server.mjs's module-header comment), so the
  // app/api/[...path]/route.ts catch-all proxy never sees it. Preview
  // iframes loaded through the Next dev server reference it directly
  // (e.g. src="/captured-assets/b1/...css"), so without this rewrite
  // previews render text but miss every image/stylesheet. Kept exactly this
  // narrow: one path prefix, nothing broader (Ruling R9).
  async rewrites() {
    return [{ source: "/captured-assets/:path*", destination: `${BACKEND}/captured-assets/:path*` }];
  },
};

export default nextConfig;
