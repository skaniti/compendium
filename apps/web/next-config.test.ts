import { afterEach, describe, expect, it } from "vitest";
import nextConfig from "./next.config";

describe("noindex header on the hosted demo", () => {
  const original = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = original;
  });

  it("sends X-Robots-Tag on every path when the site key is set", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
    expect(await nextConfig.headers!()).toEqual([
      { source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
    ]);
  });

  it("sends nothing when the site key is unset", async () => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    expect(await nextConfig.headers!()).toEqual([]);
  });

  it("sends nothing when the site key is blank", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "   ";
    expect(await nextConfig.headers!()).toEqual([]);
  });
});
