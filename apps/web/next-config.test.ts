import { afterEach, describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "./next.config";

// owner web responses must not be frameable by another origin; 'self' (not
// 'none') because archived page previews are framed same-origin.
const FRAME_RULE = {
  source: "/((?!api/|captured-assets/).*)",
  headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self'" }],
};

describe("noindex header on the hosted demo", () => {
  const original = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = original;
  });

  it("sends X-Robots-Tag on every path when the site key is set", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
    expect(await nextConfig.headers!()).toEqual([
      FRAME_RULE,
      { source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
    ]);
  });

  it("sends only the frame rule when the site key is unset", async () => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    expect(await nextConfig.headers!()).toEqual([FRAME_RULE]);
  });

  it("sends only the frame rule when the site key is blank", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "   ";
    expect(await nextConfig.headers!()).toEqual([FRAME_RULE]);
  });
});

describe("frame rule scope", () => {
  // Next skips a config header the route handler also sets, so the rule must
  // not cover /api/* or /captured-assets/* (they keep the API's own CSP and
  // X-Frame-Options). Matched with Next's own source matcher.
  it("covers pages and assets but not the api or captured assets", async () => {
    const rule = (await nextConfig.headers!()).find((r) =>
      r.headers.some((h) => h.key === "Content-Security-Policy"),
    )!;
    const matches = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true });
    for (const path of ["/", "/topics/x", "/login", "/passkey/enroll", "/_next/static/a.js"]) {
      expect(matches(path), path).not.toBe(false);
    }
    for (const path of ["/api/topics", "/api/auth/login", "/captured-assets/a/b.css"]) {
      expect(matches(path), path).toBe(false);
    }
  });
});
