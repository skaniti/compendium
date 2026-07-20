import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import GraphPlaceholder from "./GraphPlaceholder";
import SessionProvider from "./SessionProvider";
import * as api from "@/lib/api";

// Fix 2 (gate-2 walkthrough): the admin-only "view demo" / "return to
// admin" triggers moved here from Header.tsx into the graph-canvas debug
// overlay (#graph-debug-overlay), mirroring the 2026-07-13 Dash relocation
// (frontend/dash/layouts/graph_canvas.py's #view-as-demo-form /
// #return-to-admin-form, gated by app.py's #3 clientside callbacks). The
// role-gating coverage that used to live in SessionProvider.test.tsx
// against <Header /> now lives here instead, against the real trigger DOM.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Same routing convention as SessionProvider.test.tsx's own mockApiFetch:
// /api/auth/me gets `meBody`, anything else (SessionKeeper's own
// /api/auth/refresh, mounted internally by SessionProvider) gets a generic
// 200.
function mockApiFetch(meBody: unknown, meStatus = 200) {
  return vi.spyOn(api, "apiFetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/auth/me")) return jsonResponse(meBody, meStatus);
    return jsonResponse({ ok: true });
  });
}

// GraphPlaceholder now calls useSession() (fix 2: the view-as/return-to-
// admin triggers it hosts), so every render needs a real SessionProvider
// ancestor -- a bare <GraphPlaceholder /> throws (useSession's own
// outside-a-provider guard). Default to a signed-out /me response for
// tests that don't care about the role-gated triggers.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GraphPlaceholder", () => {
  it("renders the d3-graph-container hosting the compendium-empty-state", () => {
    mockApiFetch({ error: "unauthorized" }, 401);
    const { container } = render(
      <SessionProvider>
        <GraphPlaceholder />
      </SessionProvider>
    );

    const graphContainer = container.querySelector("#d3-graph-container");
    expect(graphContainer).toBeInTheDocument();

    const emptyState = graphContainer?.querySelector("#compendium-empty-state");
    expect(emptyState).toBeInTheDocument();
  });

  it("renders the ported empty-state copy and CTA", () => {
    mockApiFetch({ error: "unauthorized" }, 401);
    render(
      <SessionProvider>
        <GraphPlaceholder />
      </SessionProvider>
    );

    expect(screen.getByText(/install the extension and start browsing/i)).toBeInTheDocument();
    expect(screen.getByText(/always your call/i)).toBeInTheDocument();

    const cta = screen.getByRole("link", { name: /get the extension/i });
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveAttribute("href", "#");
  });
});

describe("GraphPlaceholder graph-debug-overlay role-gated triggers (via SessionProvider)", () => {
  it("admin: sees the view-demo trigger, not return-to-admin", async () => {
    mockApiFetch({ id: 1, email: "admin@example.com", name: "Admin", role: "admin", acting_as_demo: false });

    render(
      <SessionProvider>
        <GraphPlaceholder />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByText("view demo")).toBeInTheDocument());
    expect(screen.queryByText("return to admin")).not.toBeInTheDocument();
  });

  it("acting-as-demo: sees the return-to-admin trigger, not view-demo", async () => {
    mockApiFetch({
      id: 2,
      email: "demo@example.com",
      role: "demo",
      acting_as_demo: true,
      admin_origin_email: "admin@example.com",
    });

    render(
      <SessionProvider>
        <GraphPlaceholder />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByText("return to admin")).toBeInTheDocument());
    expect(screen.queryByText("view demo")).not.toBeInTheDocument();
  });

  it("plain user: sees neither trigger", async () => {
    mockApiFetch({ id: 3, email: "user@example.com", role: "user", acting_as_demo: false });

    render(
      <SessionProvider>
        <GraphPlaceholder />
      </SessionProvider>
    );

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalled());
    expect(screen.queryByText("view demo")).not.toBeInTheDocument();
    expect(screen.queryByText("return to admin")).not.toBeInTheDocument();
  });

  it("plain (direct) demo login: sees neither trigger -- role demo but acting_as_demo false", async () => {
    mockApiFetch({ id: 2, email: "demo@example.com", role: "demo", acting_as_demo: false });

    render(
      <SessionProvider>
        <GraphPlaceholder />
      </SessionProvider>
    );

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalled());
    expect(screen.queryByText("view demo")).not.toBeInTheDocument();
    expect(screen.queryByText("return to admin")).not.toBeInTheDocument();
  });

  it("signed-out default: renders safely with neither trigger", async () => {
    mockApiFetch({ error: "unauthorized" }, 401);

    render(
      <SessionProvider>
        <GraphPlaceholder />
      </SessionProvider>
    );

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalled());
    expect(screen.queryByText("view demo")).not.toBeInTheDocument();
    expect(screen.queryByText("return to admin")).not.toBeInTheDocument();
  });

  it("the wrapper's placeholder text stays visible to every role -- only the trigger links are gated", async () => {
    // Dash gates the WHOLE #graph-debug-overlay wrapper to admin-context
    // views; this port deliberately does NOT, since the placeholder text
    // is this component's only content until the real graph lands (see
    // GRAPH_DEBUG_OVERLAY_STYLE's comment in GraphPlaceholder.tsx).
    mockApiFetch({ id: 3, email: "user@example.com", role: "user", acting_as_demo: false });

    render(
      <SessionProvider>
        <GraphPlaceholder />
      </SessionProvider>
    );

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalled());
    expect(screen.getByText(/graph arrives in a later slice/i)).toBeInTheDocument();
  });
});
