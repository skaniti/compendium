import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasCloudflareHeaders,
  longCookieOptions,
  safeNextPath,
  tailnetAssertHeaders,
  tailnetLoginEnabled,
  tailnetLoginFrom,
} from "./tailnet-login";

const SECRET = "s".repeat(32);

function enable() {
  vi.stubEnv("AUTH_REQUIRED", "1");
  vi.stubEnv("TAILNET_LOGIN", "1");
  vi.stubEnv("TAILNET_ASSERT_SECRET", SECRET);
}

describe("tailnet-login helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is enabled only with AUTH_REQUIRED, TAILNET_LOGIN and a 32+ char secret", () => {
    expect(tailnetLoginEnabled()).toBe(false);
    enable();
    expect(tailnetLoginEnabled()).toBe(true);
    vi.stubEnv("TAILNET_ASSERT_SECRET", "short");
    expect(tailnetLoginEnabled()).toBe(false);
    enable();
    vi.stubEnv("AUTH_REQUIRED", "0");
    expect(tailnetLoginEnabled()).toBe(false);
  });

  it("reads the Tailscale login only when enabled and not via Cloudflare", () => {
    const h = new Headers({ "Tailscale-User-Login": " owner@example.com " });
    expect(tailnetLoginFrom(h)).toBeNull();
    enable();
    expect(tailnetLoginFrom(h)).toBe("owner@example.com");
    expect(tailnetLoginFrom(new Headers())).toBeNull();
    for (const cf of ["cf-connecting-ip", "cf-ray", "cf-ipcountry", "cf-visitor"]) {
      const viaCf = new Headers({ "Tailscale-User-Login": "owner@example.com", [cf]: "x" });
      expect(hasCloudflareHeaders(viaCf)).toBe(true);
      expect(tailnetLoginFrom(viaCf)).toBeNull();
    }
  });

  it.each([
    [null, "/"],
    ["", "/"],
    ["/graph?x=1", "/graph?x=1"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example/", "/"],
    ["/ok\nSet-Cookie: x", "/"],
    ["relative", "/"],
    ["/caf\u00e9", "/"],
    ["/a\u202eb", "/"],
    ["/a b", "/a b"],
    ["/api", "/"],
    ["/api/auth/me", "/"],
    ["/apiary", "/apiary"],
  ])("safeNextPath(%j) -> %j", (raw, expected) => {
    expect(safeNextPath(raw as string | null)).toBe(expected);
  });

  it("builds the assert header and the long-lived cookie options", () => {
    enable();
    expect(tailnetAssertHeaders()).toEqual({ "X-Compendium-Tailnet-Assert": SECRET });
    expect(longCookieOptions()).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 400 * 24 * 3600,
    });
  });
});
