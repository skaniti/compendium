import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LoginPage from "./page";

// LoginPage composes its own StarfieldProvider (it sits outside AppShell,
// pre-auth), which mounts the vendored <starry-sky> web component via a
// dynamic import -- same async-mount shape Starfield.test.tsx already
// exercises. No preferences.patchPreferences mock is needed here because
// the login page never calls setVariant (no starfield switcher on this
// page, only the passive background render).

function mockFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { ...window.location, href: "" });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

  it("submits {email, password} JSON to /api/auth/login on submit", async () => {
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
});
