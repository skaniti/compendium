import { afterEach, describe, expect, it } from "vitest";
import nextConfig from "./next.config";

// owner web responses must not be frameable by another origin; 'self' (not
// 'none') because archived page previews are framed same-origin.
const FRAME_RULE = {
  source: "/(.*)",
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
