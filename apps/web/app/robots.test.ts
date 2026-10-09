import { afterEach, describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots.txt", () => {
  const original = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = original;
  });

  it("disallows everything on the hosted demo", () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });

  it("allows everything elsewhere", () => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    expect(robots()).toEqual({ rules: { userAgent: "*", allow: "/" } });
  });
});
