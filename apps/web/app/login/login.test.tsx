import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LoginPage from "./LoginPageClient";
import { BACKEND_UNREACHABLE_MESSAGE } from "@/lib/login-messages";

// Targets the extracted client half (dev-login recovery fix moved the
// credential form out of app/login/page.tsx, now a server component that
// probes identity before deciding whether this form is even reachable --
// see app/login/page.test.tsx for that behavior). LoginPage here composes
// its own StarfieldProvider (it sits outside AppShell, pre-auth), which
// mounts the vendored <starry-sky> web component via a dynamic import --
// same async-mount shape Starfield.test.tsx already exercises. No
// preferences.patchPreferences mock is needed here because the login page
// never calls setVariant (no starfield switcher on this page, only the
// passive background render).

function mockFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

// D4 mount-time resume check (session-expiry-tuning) reads document.cookie
// via lib/session-policy-client.ts -- every test needs these cleared, not
// just the ones that deliberately set them, or a resumable policy written
// by one test would leak into the next and change its mount-effect outcome.
function clearSessionCookies() {
  document.cookie = "session_policy=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  document.cookie = "session_last_active=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

describe("LoginPage", () => {
  beforeEach(() => {
    clearSessionCookies();
    // `assign` is stubbed alongside `href` from the start (not just in the
    // mount-resume describe block below) -- the D4 mount effect calls
    // sessionMayResume() unconditionally on every render, and while it's
    // false with no policy cookie (the common case in this describe), a
    // real, un-stubbed window.location.assign would still be reachable if
    // that ever changed; every test gets a safe mock either way.
    vi.stubGlobal("location", { ...window.location, href: "", assign: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearSessionCookies();
  });

  it("renders a single identity field named 'email' accepting username or email", () => {
    mockFetch({ ok: true, json: async () => ({}) });
    render(<LoginPage />);

    const identity = screen.getByLabelText(/email or username/i) as HTMLInputElement;
    expect(identity).toBeInTheDocument();
    expect(identity.name).toBe("email");
    expect(identity.type).toBe("text");
    expect(identity.required).toBe(true);

    const password = screen.getByLabelText(/password/i) as HTMLInputElement;
    expect(password.name).toBe("password");
    expect(password.type).toBe("password");
    expect(password.required).toBe(true);
  });

  it("renders the starfield mount and the compendium heading", () => {
    mockFetch({ ok: true, json: async () => ({}) });
    render(<LoginPage />);

    expect(document.getElementById("starry-sky-mount")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "compendium" })).toBeInTheDocument();
  });

  // D4 (session-expiry-tuning, 2026-09-10 amendment): the "keep me signed
  // in" checkbox and its `remember` body field are gone -- the backend now
  // derives `remembered` itself from the tailnet ingress header (spec
  // D1/D4), which apps/web only relays (lib/ingress.ts), never sets from a
  // client-supplied value. The POST body is exactly {email, password}.
  it("submits {email, password} JSON to /api/auth/login on submit, with no remember field", async () => {
    const fetchMock = mockFetch({ ok: true, json: async () => ({ user: { id: 1 } }) });
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText(/email or username/i), "alice");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ email: "alice", password: "hunter2" }),
      })
    );
  });

  it("renders no keep-me-signed-in checkbox", () => {
    mockFetch({ ok: true, json: async () => ({}) });
    render(<LoginPage />);

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("redirects to / on a successful login", async () => {
    mockFetch({ ok: true, json: async () => ({ user: { id: 1 } }) });
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText(/email or username/i), "alice@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("surfaces the route's error message on a failed login, without redirecting", async () => {
    mockFetch({ ok: false, status: 401, json: async () => ({ error: "Invalid credentials" }) });
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText(/email or username/i), "alice");
    await userEvent.type(screen.getByLabelText(/password/i), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("Invalid credentials")).toBeInTheDocument();
    expect(screen.getByText("Invalid credentials")).toHaveAttribute("role", "alert");
    expect(window.location.href).toBe("");
  });

  it("renders no error text before any submit attempt", () => {
    mockFetch({ ok: true, json: async () => ({}) });
    render(<LoginPage />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // Task 7a (post-flip-closeout): the route now reports a backend outage
  // (upstream 503, or a thrown fetch) with a distinct message instead of
  // "Invalid credentials." -- confirm that exact text flows through to the
  // alert and does not redirect, same shape as the existing failed-login
  // test above.
  it("surfaces a backend-unreachable error (503) in the alert, without redirecting", async () => {
    mockFetch({ ok: false, status: 503, json: async () => ({ error: BACKEND_UNREACHABLE_MESSAGE }) });
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText(/email or username/i), "alice");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText(BACKEND_UNREACHABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(BACKEND_UNREACHABLE_MESSAGE)).toHaveAttribute("role", "alert");
    expect(window.location.href).toBe("");
  });
});

// D4 (session-expiry-tuning): on mount, a visitor whose session_policy
// cookie says they may still resume gets a silent recoverSession() attempt
// and, on success, a full-reload redirect to / instead of ever seeing the
// form -- separated into its own describe so the cookie-setup noise doesn't
// clutter the plain-form tests above.
describe("LoginPage mount: session resume (D4)", () => {
  function setResumablePolicyCookie() {
    document.cookie = `session_policy=${encodeURIComponent(
      JSON.stringify({ idleMinutes: 60, resume: true, remembered: false })
    )}; path=/`;
  }

  beforeEach(() => {
    clearSessionCookies();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearSessionCookies();
  });

  it("navigates to / when sessionMayResume is true and recoverSession succeeds", async () => {
    setResumablePolicyCookie();
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, href: "", assign: assignMock });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

    render(<LoginPage />);

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/"));
  });

  it("does not navigate when recoverSession fails, even with a resumable-looking policy", async () => {
    setResumablePolicyCookie();
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, href: "", assign: assignMock });
    const fetchMock = vi.fn().mockResolvedValue(new Response("refresh failed", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);
    // Wait for the mount-time recoverSession() attempt to actually fire
    // (a bare Promise.resolve() flush doesn't reliably drain the effect's
    // own async chain) before asserting the negative -- otherwise this
    // could pass vacuously before the effect has even run.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(assignMock).not.toHaveBeenCalled();
  });

  it("does not attempt recovery (and does not navigate) with no policy cookie", async () => {
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, href: "", assign: assignMock });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);
    await Promise.resolve();
    await Promise.resolve();

    expect(assignMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("login form: tailnet states", () => {
  beforeEach(() => {
    clearSessionCookies();
    vi.stubGlobal("location", { ...window.location, href: "", assign: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearSessionCookies();
  });

  it("shows nothing tailnet-related without a Tailscale login", () => {
    render(<LoginPage />);
    expect(screen.queryByTestId("tailnet-identity")).toBeNull();
    expect(screen.queryByLabelText(/trust this browser/i)).toBeNull();
  });

  it("offers 'Trust this browser' (ticked) to an untrusted browser and sends it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "x" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage tailnetLogin="owner@example.com" trustedBrowser={false} />);
    expect(screen.getByTestId("tailnet-identity").textContent).toContain("owner@example.com");
    const box = screen.getByLabelText(/trust this browser/i) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.change(screen.getByLabelText(/email or username/i), { target: { value: "o@x" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const loginCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/auth/login");
    expect(JSON.parse(loginCall![1].body as string).trustBrowser).toBe(true);
  });

  it("offers 'Continue as' to a trusted browser, linking to the tailnet route with resume=1", () => {
    render(<LoginPage tailnetLogin="owner@example.com" trustedBrowser />);
    const link = screen.getByTestId("tailnet-continue") as HTMLAnchorElement;
    expect(link.textContent).toContain("Continue as owner@example.com");
    expect(link.getAttribute("href")).toBe("/api/auth/tailnet/login?resume=1");
    expect(screen.queryByLabelText(/trust this browser/i)).toBeNull();
  });

  it.each([
    ["failed", /didn't work/i],
    ["error", /unavailable/i],
  ])("shows the %s notice", (notice, text) => {
    render(<LoginPage tailnetLogin="owner@example.com" tailnetNotice={notice as "failed" | "error"} />);
    expect(screen.getByRole("status").textContent).toMatch(text);
  });
});
