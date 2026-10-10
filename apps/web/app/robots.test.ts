import { afterEach, describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots.txt", () => {
  const original = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = original;
  });

  it("still allows crawling on the hosted demo so the noindex signals are seen", () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
    expect(robots()).toEqual({ rules: { userAgent: "*", allow: "/" } });
  });

  it("allows everything elsewhere", () => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    expect(robots()).toEqual({ rules: { userAgent: "*", allow: "/" } });
  });
});
