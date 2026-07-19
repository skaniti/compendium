import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: allow browsing the dev server from another machine (e.g. a
  // laptop over LAN) without Next refusing the HMR websocket upgrade.
  // The origin stays out of this tracked file -- set DEV_LAN_ORIGIN in
  // .env.local (hostname or IP, no scheme).
  ...(process.env.DEV_LAN_ORIGIN
    ? { allowedDevOrigins: [process.env.DEV_LAN_ORIGIN] }
    : {}),
};

export default nextConfig;
