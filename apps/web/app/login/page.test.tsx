import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// /login used to be a dead end on the dev stack: an idle-session lapse (or
// any 401) bounces the app to /login (lib/api.ts's redirectToLogin), but in
// dev/stub auth modes no real credentials exist to type into that form --
// the backend resolves EVERY request, even one with no Authorization header
// at all, to a default anonymous identity (the same dev-mode bypass
// lib/preferences.server.ts's cookie-less readers rely on). /login is now a
// server component that probes that identity anonymously (no cookie sent,
// deliberately) before deciding whether to show the form at all.
//
// Mocked as a throwing function (not a bare vi.fn()) so this test suite
// exercises the SAME control-flow real Next.js redirect() enforces --
// execution never reaches the form JSX below the call -- rather than merely
// asserting the mock was invoked while code after it kept running unchecked.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ has: () => false, get: () => undefined })),
}));

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import LoginPage from "./page";

function mockFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("LoginPage (server component: dev-login recovery)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(redirect).mockClear();
  });

  it("redirects to / when an anonymous GET /api/auth/me resolves a usable identity (dev/stub default-identity bypass -- also covers the dev-only case of a deliberate prior sign-out, which has no real signed-out state to return to and is expected to bounce straight back in)", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, json: async () => ({ id: 1, role: "user" }) });

    await expect(LoginPage()).rejects.toThrow("NEXT_REDIRECT:/");

    expect(redirect).toHaveBeenCalledWith("/");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/auth/me"), expect.anything());
    // Anonymous means no Authorization header was sent -- a signed-in
    // visitor's own access_token cookie must never be what this probe rides
    // on (that would defeat the point: this page must resolve identity even
    // for a browser holding no cookies at all).
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
  });

  it("renders the credential form when the anonymous probe 401s (hosted/prod backend, no dev bypass)", async () => {
    mockFetch({ ok: false, status: 401, json: async () => ({ detail: "Unauthorized" }) });

    const element = await LoginPage();
    render(element);

    expect(redirect).not.toHaveBeenCalled();
    const identity = screen.getByLabelText(/email or username/i) as HTMLInputElement;
    expect(identity).toBeInTheDocument();
    expect(identity.name).toBe("email");
  });

  it("fails open to the credential form when the backend is unreachable, instead of crashing or hanging", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    const element = await LoginPage();
    render(element);

    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/email or username/i)).toBeInTheDocument();
  });
});

describe("LoginPage: tailnet props", () => {
  beforeEach(() => {
    vi.mocked(redirect).mockClear();
    vi.stubEnv("AUTH_REQUIRED", "1");
    vi.stubEnv("TAILNET_LOGIN", "1");
    vi.stubEnv("TAILNET_ASSERT_SECRET", "s".repeat(32));
    mockFetch({ ok: false, status: 401, json: async () => ({}) }); // anonymous probe fails -> form
    vi.mocked(headers).mockResolvedValue(new Headers({ "tailscale-user-login": "owner@example.com" }) as never);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(headers).mockResolvedValue(new Headers() as never);
    vi.mocked(cookies).mockResolvedValue({ has: () => false, get: () => undefined } as never);
  });

  it("passes the Tailscale login and the failed notice to an untrusted browser's form", async () => {
    render(await LoginPage({ searchParams: Promise.resolve({ tailnet: "failed" }) }));
    expect(screen.getByTestId("tailnet-identity").textContent).toContain("owner@example.com");
    expect(screen.getByRole("status").textContent).toMatch(/didn't work/i);
    expect(screen.getByLabelText(/trust this browser/i)).toBeTruthy();
  });

  const trustedCookies = (extra: string[] = [], trustedValue = "t") =>
    vi.mocked(cookies).mockResolvedValue({
      has: (n: string) => n === "trusted_browser" || extra.includes(n),
      get: (n: string) =>
        n === "trusted_browser" ? { name: n, value: trustedValue } : extra.includes(n) ? { name: n, value: "1" } : undefined,
    } as never);

  it("treats an empty trusted_browser cookie as untrusted: password form, no redirect", async () => {
    trustedCookies([], "");
    render(await LoginPage());
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tailnet-continue")).toBeNull();
    expect(screen.getByLabelText(/trust this browser/i)).toBeTruthy();
  });

  it("re-signs a trusted, unpaused browser in automatically", async () => {
    trustedCookies();
    await expect(LoginPage()).rejects.toThrow("NEXT_REDIRECT:/api/auth/tailnet/login?next=/");
  });

  it("offers Continue as to a paused trusted browser", async () => {
    trustedCookies(["tailnet_login_paused"]);
    render(await LoginPage());
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("tailnet-continue").getAttribute("href")).toBe("/api/auth/tailnet/login?resume=1");
  });

  it("offers Continue as to a trusted browser shown a notice, without redirecting", async () => {
    trustedCookies();
    render(await LoginPage({ searchParams: Promise.resolve({ tailnet: "error" }) }));
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("tailnet-continue")).toBeTruthy();
  });

  it("shows no notice for a crafted ?tailnet= when tailnet login is off", async () => {
    vi.stubEnv("TAILNET_LOGIN", "");
    render(await LoginPage({ searchParams: Promise.resolve({ tailnet: "failed" }) }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores the header when TAILNET_LOGIN is off", async () => {
    vi.stubEnv("TAILNET_LOGIN", "");
    render(await LoginPage());
    expect(screen.queryByTestId("tailnet-identity")).toBeNull();
  });
});
