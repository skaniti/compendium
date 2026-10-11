import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("auth cookie names", () => {
  it("are plain outside production (the dev stack is plain http)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const n = await import("./cookie-names");
    expect(n.AUTH_COOKIE_PREFIX).toBe("");
    expect(n.ACCESS_TOKEN_COOKIE).toBe("access_token");
    expect(n.TRUSTED_BROWSER_COOKIE).toBe("trusted_browser");
  });

  it("carry the __Host- prefix in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const n = await import("./cookie-names");
    expect([
      n.ACCESS_TOKEN_COOKIE,
      n.REFRESH_TOKEN_COOKIE,
      n.SESSION_EXPIRES_AT_COOKIE,
      n.SESSION_POLICY_COOKIE,
      n.SESSION_LAST_ACTIVE_COOKIE,
      n.TRUSTED_BROWSER_COOKIE,
      n.TAILNET_PAUSED_COOKIE,
    ]).toEqual([
      "__Host-access_token",
      "__Host-refresh_token",
      "__Host-session_expires_at",
      "__Host-session_policy",
      "__Host-session_last_active",
      "__Host-trusted_browser",
      "__Host-tailnet_login_paused",
    ]);
    expect(n.LEGACY_AUTH_COOKIE_NAMES).toContain("access_token");
  });
});
