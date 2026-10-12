import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { POST as loginOptions } from "./login/options/route";
import { POST as loginVerify } from "./login/verify/route";
import { POST as enrollOptions } from "./enroll/options/route";
import { POST as enrollVerify } from "./enroll/verify/route";
import {
  BACKEND_UNREACHABLE_MESSAGE,
  ENROLL_LINK_UNUSABLE_MESSAGE,
  NO_PASSKEY_MESSAGE,
  PASSKEY_FAILED_MESSAGE,
  PASSKEY_NEEDS_TAILNET_MESSAGE,
  PASSKEY_SETUP_FAILED_MESSAGE,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from "@/lib/login-messages";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const SECRET = "s".repeat(40);
const JWT = `x.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")}.y`;

function jar() {
  const store = new Map<string, { value: string; options?: Record<string, unknown> }>();
  return {
    set(name: string, value: string, options?: Record<string, unknown>) {
      store.set(name, { value, options });
    },
    get(name: string) {
      const e = store.get(name);
      return e ? { name, value: e.value } : undefined;
    },
    delete(name: string) {
      store.delete(name);
    },
    _store: store,
  };
}

function req(path: string, body: unknown, headers: Record<string, string> = {}, host = "owner.example.com") {
  // The host goes in both the URL and the Host header, so the relying-party
  // check holds whichever one the route ends up reading.
  return new Request(`https://${host}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      host,
      "tailscale-user-login": "me@tailnet",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function backend(status: number, body: unknown = {}) {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

let cookieJar: ReturnType<typeof jar>;

beforeEach(() => {
  vi.stubEnv("AUTH_REQUIRED", "1");
  vi.stubEnv("TAILNET_LOGIN", "1");
  vi.stubEnv("TAILNET_ASSERT_SECRET", SECRET);
  vi.stubEnv("WEBAUTHN_RP_ID", "owner.example.com");
  vi.stubGlobal("fetch", vi.fn());
  cookieJar = jar();
  vi.mocked(cookies).mockResolvedValue(cookieJar as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("passkey routes", () => {
  it("forward login options with the tailnet login and the assert secret", async () => {
    backend(200, { options: { challenge: "abc" } });
    const res = await loginOptions(req("/api/auth/passkey/login/options", {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ options: { challenge: "abc" } });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toMatch(/\/api\/auth\/passkey\/login\/options$/);
    expect(JSON.parse(String(init?.body))).toEqual({ tailnet_login: "me@tailnet" });
    expect((init?.headers as Record<string, string>)["X-Compendium-Tailnet-Assert"]).toBe(SECRET);
  });

  it("refuse without a tailnet login, on another host, or with passkeys off", async () => {
    for (const r of [
      req("/api/auth/passkey/login/options", {}, { "tailscale-user-login": "" }),
      req("/api/auth/passkey/login/options", {}, {}, "fallback.ts.example"),
    ]) {
      const res = await loginOptions(r);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(PASSKEY_NEEDS_TAILNET_MESSAGE);
    }
    vi.stubEnv("WEBAUTHN_RP_ID", "");
    expect((await loginOptions(req("/api/auth/passkey/login/options", {}))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuse a same-site POST", async () => {
    const res = await loginVerify(req("/api/auth/passkey/login/verify", { response: {} }, { "sec-fetch-site": "same-site" }));
    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [409, 409, NO_PASSKEY_MESSAGE],
    [401, 401, PASSKEY_FAILED_MESSAGE],
    [404, 401, PASSKEY_FAILED_MESSAGE],
    [429, 429, TOO_MANY_ATTEMPTS_MESSAGE],
    [500, 503, BACKEND_UNREACHABLE_MESSAGE],
  ])("map a backend %i on login to %i", async (upstream, status, message) => {
    backend(upstream);
    const res = await loginOptions(req("/api/auth/passkey/login/options", {}));
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(message);
  });

  it("map a thrown fetch to 503", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("down"));
    const res = await loginOptions(req("/api/auth/passkey/login/options", {}));
    expect(res.status).toBe(503);
  });

  it("set the session and trusted cookies after a verified sign-in", async () => {
    cookieJar.set("tailnet_login_paused", "1");
    backend(200, {
      access_token: JWT,
      refresh_token: "r",
      user: { id: 1, email: "o@test", name: "O" },
      session_policy: { idle_minutes: 0, resume: true, remembered: true },
      browser_token: "b",
    });
    const res = await loginVerify(req("/api/auth/passkey/login/verify", { response: { id: "x" }, trustBrowser: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: 1, email: "o@test", name: "O" } });
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(sent).toEqual({ tailnet_login: "me@tailnet", response: { id: "x" }, trust_browser: true });
    expect(cookieJar.get("access_token")?.value).toBe(JWT);
    expect(cookieJar.get("refresh_token")?.value).toBe("r");
    expect(cookieJar.get("trusted_browser")?.value).toBe("b");
    expect(cookieJar.get("tailnet_login_paused")).toBeUndefined();
  });

  it("reject a verify body without a response object", async () => {
    const res = await loginVerify(req("/api/auth/passkey/login/verify", { response: "x" }));
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forward the enrollment token and map an unusable link to 410", async () => {
    backend(410);
    const res = await enrollOptions(req("/api/auth/passkey/enroll/options", { token: "tok" }));
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe(ENROLL_LINK_UNUSABLE_MESSAGE);
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(sent).toEqual({ tailnet_login: "me@tailnet", enrollment_token: "tok" });
  });

  it("reject an enrollment without a token", async () => {
    const res = await enrollOptions(req("/api/auth/passkey/enroll/options", {}));
    expect(res.status).toBe(410);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("map a refused registration to the setup-failed message", async () => {
    backend(401);
    const res = await enrollVerify(req("/api/auth/passkey/enroll/verify", { token: "tok", response: { id: "x" } }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe(PASSKEY_SETUP_FAILED_MESSAGE);
  });

  it("sign in after a verified enrollment", async () => {
    backend(200, { access_token: JWT, refresh_token: "r", user: { id: 1 }, session_policy: { idle_minutes: 0, resume: true, remembered: true } });
    const res = await enrollVerify(req("/api/auth/passkey/enroll/verify", { token: "tok", response: { id: "x" }, trustBrowser: false }));
    expect(res.status).toBe(200);
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(sent).toEqual({ tailnet_login: "me@tailnet", enrollment_token: "tok", response: { id: "x" }, trust_browser: false });
    expect(cookieJar.get("trusted_browser")).toBeUndefined();
  });
});
