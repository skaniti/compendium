import { afterEach, describe, expect, it } from "vitest";
import { DEMO_ENTRY_ROUTE, TURNSTILE_SCRIPT_URL, demoEntryEnabled, turnstileSiteKey } from "./demo-entry";

describe("demo-entry", () => {
  const original = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = original;
  });

  it("is off without a site key", () => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    expect(demoEntryEnabled()).toBe(false);
    expect(turnstileSiteKey()).toBe("");
  });

  it("is off with a blank site key", () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "   ";
    expect(demoEntryEnabled()).toBe(false);
  });

  it("is on with a site key", () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
    expect(demoEntryEnabled()).toBe(true);
    expect(turnstileSiteKey()).toBe("1x00000000000000000000AA");
  });

  it("names the route and the script", () => {
    expect(DEMO_ENTRY_ROUTE).toBe("/api/auth/demo");
    expect(TURNSTILE_SCRIPT_URL).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js");
  });
});
