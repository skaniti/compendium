import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";

// D1 (batch 04 auth/session parity): this proxy (Next 16's rename of
// "middleware") is UX only -- the backend's verify_api_key remains the sole
// enforcement point. AUTH_REQUIRED ("1") is the single prod-gate knob;
// default (unset/anything else) keeps local dev's no-auth loop. Tests below
// cover the 4-case cookie x knob matrix plus the two no-redirect-loop
// guarantees the task calls out explicitly: /login itself, and /api/*.

function makeRequest(path: string, opts?: { withCookie?: boolean }): NextRequest {
  const headers = opts?.withCookie ? { cookie: "access_token=test-token" } : undefined;
  return new NextRequest(`http://localhost${path}`, headers ? { headers } : undefined);
}

describe("proxy", () => {
  const originalAuthRequired = process.env.AUTH_REQUIRED;

  beforeEach(() => {
    delete process.env.AUTH_REQUIRED;
  });

  afterEach(() => {
    if (originalAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = originalAuthRequired;
  });

  describe("4-case matrix: cookie present/absent x AUTH_REQUIRED on/off", () => {
    it("AUTH_REQUIRED off, no cookie -> passes through (no redirect)", () => {
      process.env.AUTH_REQUIRED = "0";
      const res = proxy(makeRequest("/"));
      expect(res.headers.get("location")).toBeNull();
    });

    it("AUTH_REQUIRED off, cookie present -> passes through (no redirect)", () => {
      process.env.AUTH_REQUIRED = "0";
      const res = proxy(makeRequest("/", { withCookie: true }));
      expect(res.headers.get("location")).toBeNull();
    });

    it("AUTH_REQUIRED on, no cookie -> redirects to /login", () => {
      process.env.AUTH_REQUIRED = "1";
      const res = proxy(makeRequest("/"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost/login");
    });

    it("AUTH_REQUIRED on, cookie present -> passes through (no redirect)", () => {
      process.env.AUTH_REQUIRED = "1";
      const res = proxy(makeRequest("/", { withCookie: true }));
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("AUTH_REQUIRED unset (default off)", () => {
    it("no cookie -> passes through (local dev no-auth loop preserved)", () => {
      const res = proxy(makeRequest("/"));
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("no-redirect-loop guarantees", () => {
    it("/login never redirects, even with AUTH_REQUIRED on and no cookie", () => {
      process.env.AUTH_REQUIRED = "1";
      const res = proxy(makeRequest("/login"));
      expect(res.headers.get("location")).toBeNull();
    });

    it("/api/* never redirects, even with AUTH_REQUIRED on and no cookie", () => {
      process.env.AUTH_REQUIRED = "1";
      const res = proxy(makeRequest("/api/auth/preferences"));
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("captured-assets exemption", () => {
    it("AUTH_REQUIRED on, no cookie -> /captured-assets/ passes through", () => {
      process.env.AUTH_REQUIRED = "1";
      const res = proxy(makeRequest("/captured-assets/user_1/aa/extensionless"));
      expect(res.headers.get("location")).toBeNull();
    });

    it("matcher excludes /captured-assets/ but still covers ordinary pages", () => {
      const re = new RegExp(`^${config.matcher[0]}$`);
      expect(re.test("/captured-assets/user_1/aa/extensionless")).toBe(false);
      expect(re.test("/topics")).toBe(true);
    });
  });
});
