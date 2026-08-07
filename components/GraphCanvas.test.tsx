import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor, screen, act } from "@testing-library/react";
import GraphCanvas from "./GraphCanvas";
import SessionProvider from "./SessionProvider";
import NavProvider, { useNav } from "./NavProvider";
import * as api from "@/lib/api";
import type { GraphPayload } from "@/lib/types";

// Task A1-1: unit-tests the GraphCanvas CONTRACT -- fetch -> mount, the
// empty-state's real node-count gating (GraphPlaceholder's TODO(mig-03)
// obligation 1), outbound onSelect -> selectFromCanvas wiring (2a),
// bubble-phase Esc -> CLEAR_SELECTION (2b, independent of onSelect),
// inbound NavProvider -> vendor.setSelection wiring (Step 5), the Step 6
// dispose-on-unmount handle, and the ported debug-overlay role gating --
// against a MOCKED lib/graph/d3-graph-vendor.js, same convention
// GraphA1.test.tsx established (real D3 force layout + SVG measurement
// jsdom doesn't implement; lib/graph/d3-graph-vendor.remount.test.ts
// covers the real, unmocked module separately).
const renderMock = vi.fn();
const setSelectionMock = vi.fn();
const disposeMock = vi.fn();
vi.mock("@/lib/graph/d3-graph-vendor.js", () => ({
  render: (...args: unknown[]) => {
    renderMock(...args);
    return disposeMock;
  },
  setSelection: (...args: unknown[]) => setSelectionMock(...args),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Same routing convention as SessionProvider.test.tsx/GraphPlaceholder.test.tsx:
// /api/auth/me gets `meBody`, anything else gets a generic 200 (covers
// SessionKeeper's /api/auth/refresh and the view-demo/return-to-admin POSTs).
function mockApiFetch(meBody: unknown, meStatus = 200) {
  return vi.spyOn(api, "apiFetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/auth/me")) return jsonResponse(meBody, meStatus);
    return jsonResponse({ ok: true });
  });
}

const SIGNED_OUT = { error: "unauthorized" };

function node(id: string): GraphPayload["nodes"][number] {
  return {
    id,
    label: `Test ${id}`,
    level: 0,
    kind: "singleton",
    visit_count: 1,
    parent_id: null,
    children_ids: [],
    capture_ids: [],
    page_urls: ["https://example.com"],
    first_visited_at: null,
  };
}

const ONE_NODE_PAYLOAD: GraphPayload = {
  nodes: [node("page-1")],
  links: [],
  clusters: [],
  super_clusters: [],
  groups: [],
};

const EMPTY_PAYLOAD: GraphPayload = {
  nodes: [],
  links: [],
  clusters: [],
  super_clusters: [],
  groups: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  renderMock.mockClear();
  setSelectionMock.mockClear();
  disposeMock.mockClear();
});

// Test-only probe: exposes NavProvider's state as text + lets a test drive
// dispatch() directly to set up filter/selection state before exercising
// GraphCanvas's own wiring.
function NavProbe() {
  const { state, dispatch } = useNav();
  return (
    <div>
      <span data-testid="selected">{state.selectedNodeId ?? "null"}</span>
      <span data-testid="filter-key">{state.filterWindowKey ?? "null"}</span>
      <button onClick={() => dispatch({ type: "SELECT_NODE", id: "seed-node" })}>seed-select</button>
      <button onClick={() => dispatch({ type: "SET_WINDOW_FILTER", key: "win-1", nodeIds: ["a"] })}>
        seed-filter
      </button>
    </div>
  );
}

function renderCanvas(meBody: unknown = SIGNED_OUT, meStatus = 401) {
  mockApiFetch(meBody, meStatus);
  return render(
    <SessionProvider>
      <NavProvider>
        <GraphCanvas />
        <NavProbe />
      </NavProvider>
    </SessionProvider>
  );
}

describe("GraphCanvas mount + fetch", () => {
  it("mounts a #d3-graph-container div and calls the vendor's render() once graph data with nodes arrives", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    const { container } = renderCanvas();

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    const mountEl = container.querySelector("#d3-graph-container");
    expect(mountEl).not.toBeNull();

    const [calledContainer, calledData, calledOpts] = renderMock.mock.calls[0] as [
      HTMLElement,
      GraphPayload,
      { icons?: unknown; onSelect?: (kind: string | null, id: string | null) => void },
    ];
    expect(calledContainer).toBe(mountEl);
    expect(calledData).toBe(ONE_NODE_PAYLOAD);
    expect(calledOpts.icons).toBeTruthy();
    expect(typeof calledOpts.onSelect).toBe("function");
  });

  it("disposes the vendor mount on unmount (Step 6)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    const { unmount } = renderCanvas();

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    expect(disposeMock).not.toHaveBeenCalled();

    unmount();
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("renders an error message when fetchGraph rejects, without mounting the vendor or the empty state", async () => {
    vi.spyOn(api, "fetchGraph").mockRejectedValue(new Error("boom"));
    renderCanvas();

    await waitFor(() => expect(screen.getByText(/couldn't load graph: boom/i)).toBeInTheDocument());
    expect(renderMock).not.toHaveBeenCalled();
    expect(document.querySelector("#compendium-empty-state")).toBeNull();
  });
});

describe("GraphCanvas empty-state (GraphPlaceholder TODO(mig-03) obligation 1)", () => {
  it("does not show the empty state while the fetch is still pending", async () => {
    vi.spyOn(api, "fetchGraph").mockImplementation(() => new Promise(() => {})); // never resolves
    renderCanvas();

    // Let SessionProvider's own (resolved) /api/auth/me hydration settle
    // inside act() -- only fetchGraph is deliberately left hanging.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector("#compendium-empty-state")).toBeNull();
  });

  it("shows the empty state once a completed fetch reports zero nodes, and never mounts the vendor", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas();

    await waitFor(() => expect(document.querySelector("#compendium-empty-state")).not.toBeNull());
    expect(screen.getByText(/install the extension and start browsing/i)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /get the extension/i });
    expect(cta).toHaveAttribute("href", "#");
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("hides the empty state and mounts the vendor once nodes exist", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    expect(document.querySelector("#compendium-empty-state")).toBeNull();
  });
});

describe("GraphCanvas outbound wiring: onSelect -> useNav().selectFromCanvas (Step 2a/4)", () => {
  async function mountAndGetOnSelect(): Promise<(kind: string | null, id: string | null) => void> {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    const [, , opts] = renderMock.mock.calls[0] as [
      unknown,
      unknown,
      { onSelect: (kind: string | null, id: string | null) => void },
    ];
    return opts.onSelect;
  }

  it("node select dispatches SELECT_NODE via selectFromCanvas", async () => {
    const onSelect = await mountAndGetOnSelect();
    act(() => onSelect("node", "page-1"));
    expect(screen.getByTestId("selected")).toHaveTextContent("page-1");
  });

  it("cluster select dispatches SELECT_CLUSTER via selectFromCanvas", async () => {
    const onSelect = await mountAndGetOnSelect();
    act(() => onSelect("cluster", "cluster-1"));
    expect(screen.getByTestId("selected")).toHaveTextContent("cluster-1");
  });

  it("kind-with-missing-id is a NO-OP -- the caller skips dispatch entirely", async () => {
    const onSelect = await mountAndGetOnSelect();
    act(() => screen.getByText("seed-select").click());
    expect(screen.getByTestId("selected")).toHaveTextContent("seed-node");

    act(() => onSelect("node", null));
    // Unchanged -- resolveCanvasTapAction returns null for a present kind
    // with a falsy id, and selectFromCanvas must not dispatch at all.
    expect(screen.getByTestId("selected")).toHaveTextContent("seed-node");
  });

  it("background tap (kind === null) resolves to HOME -- clears selection AND filter", async () => {
    const onSelect = await mountAndGetOnSelect();
    act(() => screen.getByText("seed-select").click());
    act(() => screen.getByText("seed-filter").click());
    expect(screen.getByTestId("selected")).toHaveTextContent("seed-node");
    expect(screen.getByTestId("filter-key")).toHaveTextContent("win-1");

    act(() => onSelect(null, null));
    expect(screen.getByTestId("selected")).toHaveTextContent("null");
    expect(screen.getByTestId("filter-key")).toHaveTextContent("null");
  });
});

describe("GraphCanvas canvas Esc -> CLEAR_SELECTION (Step 2b/6, bubble phase only)", () => {
  it("Escape (bubble) clears selection but leaves the filter untouched -- distinct from background-tap HOME", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    act(() => screen.getByText("seed-select").click());
    act(() => screen.getByText("seed-filter").click());
    expect(screen.getByTestId("selected")).toHaveTextContent("seed-node");
    expect(screen.getByTestId("filter-key")).toHaveTextContent("win-1");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(screen.getByTestId("selected")).toHaveTextContent("null");
    // Unlike a background tap (HOME), the filter survives Esc.
    expect(screen.getByTestId("filter-key")).toHaveTextContent("win-1");
  });

  it("is registered bubble-phase, not capture -- a capture-phase stopPropagation (mirroring ScPopover) wins the race", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    // Capture-phase listener always runs before ANY bubble-phase listener
    // on the same node, regardless of add order -- mirrors
    // components/ScPopover.tsx's real Esc-dismissal listener.
    const captureStop = (e: KeyboardEvent) => e.stopPropagation();
    document.addEventListener("keydown", captureStop, true);

    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    act(() => screen.getByText("seed-select").click());
    expect(screen.getByTestId("selected")).toHaveTextContent("seed-node");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    // GraphCanvas's own listener never ran -- selection is unchanged.
    expect(screen.getByTestId("selected")).toHaveTextContent("seed-node");
    document.removeEventListener("keydown", captureStop, true);
  });
});

describe("GraphCanvas inbound wiring: NavProvider -> vendor.setSelection (Step 5)", () => {
  it("applies a SELECT_NODE dispatch to the vendor via setSelection('node', id)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    setSelectionMock.mockClear(); // drop the initial mount-time apply (selectedNodeId was null)

    act(() => screen.getByText("seed-select").click());

    await waitFor(() => expect(setSelectionMock).toHaveBeenCalledWith("node", "seed-node"));
  });

  it("applies CLEAR_SELECTION to the vendor as setSelection('node', null)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    act(() => screen.getByText("seed-select").click());
    await waitFor(() => expect(setSelectionMock).toHaveBeenCalledWith("node", "seed-node"));
    setSelectionMock.mockClear();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    await waitFor(() => expect(setSelectionMock).toHaveBeenCalledWith("node", null));
  });
});

describe("GraphCanvas graph-debug-overlay role-gated triggers (ported from GraphPlaceholder.test.tsx)", () => {
  it("admin: sees the view-demo trigger, not return-to-admin", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas({ id: 1, email: "admin@example.com", name: "Admin", role: "admin", acting_as_demo: false }, 200);

    await waitFor(() => expect(screen.getByText("view demo")).toBeInTheDocument());
    expect(screen.queryByText("return to admin")).not.toBeInTheDocument();
  });

  it("acting-as-demo: sees the return-to-admin trigger, not view-demo", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas(
      { id: 2, email: "demo@example.com", role: "demo", acting_as_demo: true, admin_origin_email: "admin@example.com" },
      200
    );

    await waitFor(() => expect(screen.getByText("return to admin")).toBeInTheDocument());
    expect(screen.queryByText("view demo")).not.toBeInTheDocument();
  });

  it("plain user: sees neither trigger, and the wrapper still renders unconditionally", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas({ id: 3, email: "user@example.com", role: "user", acting_as_demo: false }, 200);

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalled());
    expect(screen.queryByText("view demo")).not.toBeInTheDocument();
    expect(screen.queryByText("return to admin")).not.toBeInTheDocument();
    expect(document.querySelector("#graph-debug-overlay")).not.toBeNull();
  });

  it("the dev-note placeholder text is gone now that the graph has landed (TODO(mig-03) obligation 2)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas({ id: 3, email: "user@example.com", role: "user", acting_as_demo: false }, 200);

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalled());
    expect(screen.queryByText(/graph arrives in a later slice/i)).not.toBeInTheDocument();
  });
});
