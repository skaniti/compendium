import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor, screen, act, fireEvent } from "@testing-library/react";
import GraphCanvas from "./GraphCanvas";
import SessionProvider from "./SessionProvider";
import NavProvider, { useNav } from "./NavProvider";
import ThemeProvider, { useTheme } from "./ThemeProvider";
import TimeWindowProvider, { useTimeWindow } from "./TimeWindowProvider";
import { useGraph, __resetGraphCacheForTest } from "@/hooks/useGraph";
import * as api from "@/lib/api";
import * as preferences from "@/lib/preferences";
import { GRAPH_DEFAULTS } from "@/lib/graph/constants";
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
const disposeMock = vi.fn();
// Task group W, W3 step: mirrors the real vendor's contract -- render()
// itself is synchronous, but `onFirstPaint` (the render-complete signal
// GraphCanvas.tsx now wires window.__compendiumGraphRendered to) fires
// from a LATER worker `tick` message, never synchronously within render().
// Deferred a microtask here (not called inline) so tests can tell "not on
// start" apart from "eventually true" -- see the render-complete signal
// describe block below. This is renderMock's OWN default implementation
// (not a wrapper AROUND renderMock) specifically so a test's
// `renderMock.mockImplementationOnce(...)` genuinely overrides it -- the
// mock factory below just forwards to renderMock verbatim, no separate
// hardcoded behavior sitting outside its reach.
const renderMock = vi.fn((...args: unknown[]) => {
  const opts = args[2] as { onFirstPaint?: () => void } | undefined;
  queueMicrotask(() => opts?.onFirstPaint?.());
  return disposeMock;
});
const setSelectionMock = vi.fn();
const recolorMock = vi.fn();
const toggleNoiseMock = vi.fn();
const setFilterDimMock = vi.fn();
vi.mock("@/lib/graph/d3-graph-vendor.js", () => ({
  render: (...args: unknown[]) => renderMock(...args),
  setSelection: (...args: unknown[]) => setSelectionMock(...args),
  recolor: (...args: unknown[]) => recolorMock(...args),
  toggleNoise: (...args: unknown[]) => toggleNoiseMock(...args),
  setFilterDim: (...args: unknown[]) => setFilterDimMock(...args),
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

// A DISTINCT (fewer-nodes) payload standing in for a real windowed response
// (task-A1-3-brief.md's live-verification note: window=7 returned ~39 nodes
// vs ~802 full) -- used to assert the canvas re-renders with the NEW,
// smaller dataset rather than re-rendering the same payload.
const WINDOW_7_PAYLOAD: GraphPayload = {
  nodes: [node("page-1")],
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
  recolorMock.mockClear();
  toggleNoiseMock.mockClear();
  setFilterDimMock.mockClear();
  // ThemeProvider (wave 8) persists the picked variant to localStorage --
  // clear between tests so one test's setVariant() call can't seed the
  // next test's initial readStoredVariant() read (same convention
  // ThemeProvider.test.tsx's own beforeEach uses).
  localStorage.clear();
  // Task A1-3 (Step 2): GraphCanvas now reads through hooks/useGraph.ts's
  // module-level shared cache instead of its own local fetchGraph() call --
  // without resetting it here, one test's committed graph/graphVersion would
  // leak into the next (same convention hooks/useGraph.test.ts's own
  // beforeEach uses; done in afterEach here instead since renderCanvas() is
  // called fresh at the START of each test body, not in a shared beforeEach).
  __resetGraphCacheForTest();
  // Task A1-4: the render-complete signal for components/CompendiumLoader.tsx
  // (lib/vendor/vendor.d.ts's Window augmentation) -- window-scoped, same
  // per-test-reset reason as CompendiumLoader.test.tsx's own cleanup of the
  // sibling globals it owns.
  delete window.__compendiumGraphRendered;
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
      <span data-testid="filter-ids">{state.filterHighlightIds.join(",")}</span>
      <button onClick={() => dispatch({ type: "SELECT_NODE", id: "seed-node" })}>seed-select</button>
      <button onClick={() => dispatch({ type: "SET_WINDOW_FILTER", key: "win-1", nodeIds: ["a"] })}>
        seed-filter
      </button>
      <button onClick={() => dispatch({ type: "SET_WINDOW_FILTER", key: "win-2", nodeIds: ["a", "b"] })}>
        seed-filter-2
      </button>
      <button onClick={() => dispatch({ type: "CLEAR_FILTER" })}>clear-filter</button>
    </div>
  );
}

// Test-only probe: exposes ThemeProvider's palette context and lets a
// test switch palettes directly (mirrors ThemeProvider.test.tsx's own
// Consumer) -- production wires GraphCanvas UNDER ThemeProvider
// (SessionProvider > ThemeProvider > ... > GraphCanvas, app/layout.tsx +
// app/page.tsx), so renderCanvas() below mirrors that same nesting order.
function ThemeProbe() {
  const { variant, setVariant } = useTheme();
  return (
    <div>
      <span data-testid="theme-variant">{variant}</span>
      <button onClick={() => setVariant("Pink")}>switch-pink</button>
      <button onClick={() => setVariant("Teal")}>switch-teal</button>
    </div>
  );
}

// Test-only probe: exposes hooks/useGraph.ts's refresh() so a test can
// trigger a graphVersion bump directly (the same call DiaryPanel/the
// SUPERCLUSTERS card make after a recluster) without needing a real
// POST /api/recluster round-trip.
function GraphProbe() {
  const { refresh, graphVersion } = useGraph();
  return (
    <div>
      <span data-testid="graph-version">{graphVersion}</span>
      <button onClick={() => void refresh()}>trigger-refresh</button>
    </div>
  );
}

// Test-only probe: exposes TimeWindowProvider's setTimeWindow() so a test
// can drive a DATE RANGE pill click without rendering the real HeaderCards
// widget -- production nests GraphCanvas under TimeWindowProvider
// (components/AppShell.tsx: TimeWindowProvider > Header/NavProvider >
// PanelGrid > center), so renderCanvas() below mirrors that same nesting.
function TimeWindowProbe() {
  const { timeWindow, setTimeWindow } = useTimeWindow();
  return (
    <div>
      <span data-testid="time-window">{timeWindow}</span>
      <button onClick={() => setTimeWindow("7")}>window-7</button>
      <button onClick={() => setTimeWindow("30")}>window-30</button>
      <button onClick={() => setTimeWindow("all")}>window-all</button>
    </div>
  );
}

function renderCanvas(meBody: unknown = SIGNED_OUT, meStatus = 401) {
  mockApiFetch(meBody, meStatus);
  return render(
    <SessionProvider>
      <ThemeProvider>
        <TimeWindowProvider>
          <NavProvider>
            <GraphCanvas />
            <NavProbe />
            <ThemeProbe />
            <GraphProbe />
            <TimeWindowProbe />
          </NavProvider>
        </TimeWindowProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}

describe("GraphCanvas #node-tooltip mount point (wave 6: tooltip gate DOM-provenance fix)", () => {
  it("renders #node-tooltip as a sibling of #d3-graph-container, initially hidden, mirroring Dash's layout div", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas(SIGNED_OUT, 401);

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalled());

    // The vendor (lib/graph/d3-graph-vendor.js showTooltip/hideTooltip/
    // showLinesTooltip) looks this up via document.getElementById and never
    // creates it -- it must exist in the document regardless of whether the
    // graph itself has any nodes yet.
    const tip = document.getElementById("node-tooltip");
    expect(tip).not.toBeNull();
    expect(tip).toHaveClass("node-tooltip");
    expect(tip).toHaveStyle({ display: "none" });
    // Not nested inside #d3-graph-container -- see GraphCanvas.tsx's
    // NODE_TOOLTIP_STYLE comment for why sibling placement is safe here.
    expect(document.querySelector("#d3-graph-container #node-tooltip")).toBeNull();
  });
});

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

// Task group B, Part 1 fix 1 (carried A1-3 correction, task-B-brief.md):
// mount previously applied noise AFTER vendor.render() and toggleNoise()
// unconditionally re-renders once a dataset exists -- every mount ran the
// full force layout TWICE, with a possible flash of noise nodes when the
// pref was false. The vendor's own toggleNoise() contract (verified in
// lib/graph/d3-graph-vendor.remount.test.ts's "toggleNoise() call BEFORE
// the first render()" case) is a documented, pre-existing no-op-until-
// rendered guard -- GraphCanvas.tsx now actually calls toggleNoise BEFORE
// render() so the vendor's real internal re-render never fires at mount.
// The genuinely discriminating assertion here is CALL ORDER: this
// shallow-mocked renderMock/toggleNoiseMock pair can't observe the real
// vendor's internal double-layout (the mock's own toggleNoise never calls
// renderMock itself), so a plain "renderMock called once" check would pass
// against the OLD, buggy order too -- invocationCallOrder instead directly
// observes which of the two GraphCanvas.tsx itself calls first, which is
// exactly the line this fix reorders.
describe("GraphCanvas Part 1 fix 1: toggleNoise applied BEFORE the first render() call", () => {
  it("calls vendor.toggleNoise() strictly BEFORE vendor.render() at mount", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas(
      { id: 1, email: "u@example.com", role: "user", acting_as_demo: false, preferences: { show_noise: false } },
      200
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggleNoiseMock).toHaveBeenCalledWith(false));

    const toggleOrder = toggleNoiseMock.mock.invocationCallOrder[0];
    const renderOrder = renderMock.mock.invocationCallOrder[0];
    expect(toggleOrder).toBeLessThan(renderOrder);
  });

  it("still applies mount-time selection + filter dim, EXPLICITLY after render (not incidentally via a since-eliminated second render pass)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    // Seed both BEFORE the vendor mount resolves -- same "during the import
    // window" timing the existing A1-1 minor test uses.
    act(() => screen.getByText("seed-select").click());
    act(() => screen.getByText("seed-filter").click());

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(setSelectionMock).toHaveBeenCalledWith("node", "seed-node"));
    await waitFor(() => expect(setFilterDimMock).toHaveBeenCalledWith(["a"]));

    // Both applies happen strictly after the (one and only) render call --
    // the explicit ordering this fix establishes, rather than depending on
    // setFilterDim happening to run last.
    const renderOrder = renderMock.mock.invocationCallOrder[0];
    expect(setSelectionMock.mock.invocationCallOrder[0]).toBeGreaterThan(renderOrder);
    expect(setFilterDimMock.mock.invocationCallOrder[0]).toBeGreaterThan(renderOrder);
  });

  it("mounts with exactly ONE call to vendor.render() regardless of the noise pref value", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas(
      { id: 1, email: "u@example.com", role: "user", acting_as_demo: false, preferences: { show_noise: true } },
      200
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggleNoiseMock).toHaveBeenCalledWith(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(renderMock).toHaveBeenCalledTimes(1);
  });
});

// Task group B, Part 1 fix 2 (carried A1-3 correction, task-B-brief.md):
// the mount effect's `.then()` previously closed over `payload`/
// `graphVersion` at effect-DEFINITION time. A window switch committing
// DURING the vendor's dynamic import() window (same `hasNodes` value, so
// the mount effect does not re-run) painted the STALE payload and recorded
// a stale graphVersion, self-healing only on some LATER, unrelated
// graphVersion bump. This is the SAME class of bug the A1-1 selection fix
// (above, "A1-1 ledgered minor") already closed for `state.selectedNodeId`
// -- fixed here with the same always-current-ref pattern.
//
// progress.md flags the EXISTING A1-1 regression test as non-discriminating
// (it dispatches its state change before `hasNodes` even flips true, well
// before the import is ever kicked off -- "needs deferrable import/fetch to
// discriminate"). This describe block builds that deferrable import via
// vi.resetModules() + vi.doMock() scoped to ONE test, so the race window
// between "the mount effect starts (import kicked off)" and "the import
// resolves" is under full, deterministic test control -- a plain
// `await Promise.resolve()` gap is far too fast/implementation-dependent to
// reliably land a real fetchGraph commit inside that window otherwise.
describe("GraphCanvas Part 1 fix 2: mount .then reads fresh payload/graphVersion via always-current refs", () => {
  afterEach(() => {
    // Restore the file-wide shared mock EXACTLY as declared at the top of
    // this file, so every other (non-resetModules) test in this file keeps
    // resolving the fast/shallow mock rather than this block's own
    // deferred-gate override -- vi.resetModules() clears the module
    // registry's cached resolution, and only a fresh vi.doMock()
    // registration (not vi.doUnmock(), which disables mocking for the path
    // entirely) restores the ORIGINAL hoisted factory for the next import.
    vi.doMock("@/lib/graph/d3-graph-vendor.js", () => ({
      render: (...args: unknown[]) => {
        renderMock(...args);
        return disposeMock;
      },
      setSelection: (...args: unknown[]) => setSelectionMock(...args),
      recolor: (...args: unknown[]) => recolorMock(...args),
      toggleNoise: (...args: unknown[]) => toggleNoiseMock(...args),
      setFilterDim: (...args: unknown[]) => setFilterDimMock(...args),
    }));
  });

  it("a window switch committing DURING the vendor's dynamic-import window paints the FRESH payload/graphVersion, not the stale closure from when the effect started", async () => {
    vi.resetModules();
    let releaseImport!: () => void;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    // Untyped vi.fn() (matching renderMock's own file-top declaration
    // style) -- an inline `() => vi.fn()` implementation would infer a
    // ZERO-arg call signature, breaking `mock.calls[0][1]` below even
    // though the real vendor.render() is always called with 3 args.
    const deferredRenderMock = vi.fn();
    deferredRenderMock.mockReturnValue(vi.fn());
    vi.doMock("@/lib/graph/d3-graph-vendor.js", async () => {
      await importGate;
      return {
        render: deferredRenderMock,
        setSelection: vi.fn(),
        recolor: vi.fn(),
        toggleNoise: vi.fn(),
        setFilterDim: vi.fn(),
      };
    });

    const first = ONE_NODE_PAYLOAD;
    const second: GraphPayload = { ...ONE_NODE_PAYLOAD, nodes: [node("page-1"), node("page-2")] };
    const fetchSpy = vi
      .spyOn(api, "fetchGraph")
      .mockImplementation(async (window) => (window === "7" ? second : first));
    renderCanvas();

    // The mount effect has started against the FIRST payload (hasNodes
    // flipped true) -- its dynamic import is now pending behind
    // importGate, unresolved.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("all"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deferredRenderMock).not.toHaveBeenCalled();

    // Commit a window switch BEFORE releasing the import -- `hasNodes`
    // stays true (both payloads have nodes), so the SAME mount-effect
    // instance (still awaiting importGate) is the one that will eventually
    // paint this.
    act(() => screen.getByText("window-7").click());
    await waitFor(() => expect(fetchSpy).toHaveBeenLastCalledWith("7"));
    await waitFor(() => expect(screen.getByTestId("graph-version")).toHaveTextContent("1"));
    expect(deferredRenderMock).not.toHaveBeenCalled(); // import STILL pending

    // NOW release the import -- the mount effect's `.then()` finally runs.
    releaseImport();
    await waitFor(() => expect(deferredRenderMock).toHaveBeenCalledTimes(1));

    // Must have painted the FRESH (window-7, second) payload -- the STALE
    // closure captured when the effect started would have been `first`.
    expect(deferredRenderMock.mock.calls[0][1]).toBe(second);
  });
});

// Task group B, Part 2 (spec decision C): saved tuner profiles apply BEFORE
// first paint, Next-native (no boot latch, no timeout). GraphCanvas.tsx
// resolves this via a dedicated GET /api/auth/me call (id + preferences)
// feeding lib/graph/tuner-snapshot.ts's resolveTunerSnapshot(), merged onto
// GRAPH_DEFAULTS and handed to the vendor as opts.tunerSnapshot on the
// FIRST (only) render call -- see task-B-report.md for the full wiring
// design.
describe("GraphCanvas Part 2 (decision C): tuner snapshot resolves before first paint", () => {
  it("no saved profile -- opts.tunerSnapshot is exactly GRAPH_DEFAULTS (plain-demo / no-profile paints code defaults)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas({ id: 7, email: "u@example.com", role: "user", acting_as_demo: false }, 200);

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    const [, , opts] = renderMock.mock.calls[0] as [unknown, unknown, { tunerSnapshot?: Record<string, unknown> }];
    expect(opts.tunerSnapshot).toEqual(GRAPH_DEFAULTS);
  });

  it("a signed-out/failed /api/auth/me still paints code defaults -- no hang, no throw", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas(SIGNED_OUT, 401); // renderCanvas()'s own default

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    const [, , opts] = renderMock.mock.calls[0] as [unknown, unknown, { tunerSnapshot?: Record<string, unknown> }];
    expect(opts.tunerSnapshot).toEqual(GRAPH_DEFAULTS);
  });

  it("applies the server-default active profile, merged onto GRAPH_DEFAULTS", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas(
      {
        id: 7,
        email: "u@example.com",
        role: "user",
        acting_as_demo: false,
        preferences: {
          tuner_profiles: {
            "1": { TYPO_V: 3, FOG_V: 2, BASE_PAGE_DOT_SIZE: 4.2 },
          },
          tuner_active_profile: "1",
        },
      },
      200
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    const [, , opts] = renderMock.mock.calls[0] as [unknown, unknown, { tunerSnapshot?: Record<string, unknown> }];
    expect(opts.tunerSnapshot).toMatchObject({ ...GRAPH_DEFAULTS, BASE_PAGE_DOT_SIZE: 4.2 });
  });

  it("a per-machine localStorage override wins over the server-default slot", async () => {
    localStorage.setItem("compendium_tuner_slot_7", "2");
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas(
      {
        id: 7,
        email: "u@example.com",
        role: "user",
        acting_as_demo: false,
        preferences: {
          tuner_profiles: {
            "1": { TYPO_V: 3, FOG_V: 2, BASE_PAGE_DOT_SIZE: 1 },
            "2": { TYPO_V: 3, FOG_V: 2, BASE_PAGE_DOT_SIZE: 2 },
          },
          tuner_active_profile: "1",
        },
      },
      200
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    const [, , opts] = renderMock.mock.calls[0] as [unknown, unknown, { tunerSnapshot?: Record<string, unknown> }];
    expect(opts.tunerSnapshot).toMatchObject({ BASE_PAGE_DOT_SIZE: 2 });
  });

  it("a stale TYPO_V drops typography keys but keeps ungated spatial keys, on the FIRST paint (no late re-render snap)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas(
      {
        id: 7,
        email: "u@example.com",
        role: "user",
        acting_as_demo: false,
        preferences: {
          tuner_profiles: {
            "1": { TYPO_V: 2, FOG_V: 2, BASE_LABEL_FONT_SIZE: 99, BASE_PAGE_DOT_SIZE: 4.2 },
          },
          tuner_active_profile: "1",
        },
      },
      200
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    const [, , opts] = renderMock.mock.calls[0] as [unknown, unknown, { tunerSnapshot?: Record<string, unknown> }];
    // Typography key dropped -- falls back to the code default.
    expect(opts.tunerSnapshot?.BASE_LABEL_FONT_SIZE).toBe(GRAPH_DEFAULTS.BASE_LABEL_FONT_SIZE);
    // Ungated spatial key still applies.
    expect(opts.tunerSnapshot?.BASE_PAGE_DOT_SIZE).toBe(4.2);
    // Only ONE render call -- no separate "corrected" re-render after the
    // gate resolves; the gating already happened before this first call.
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  // Review fix round 1, finding F1: TWO independent /api/auth/me callers
  // exist in this tree -- SessionProvider (role/showNoise, mounted by
  // renderCanvas()) and GraphCanvas's own resolveTunerSnapshotFromMe. A
  // bare "was /api/auth/me called at least once" assertion does NOT
  // discriminate a genuinely CONCURRENT tuner fetch from one wrongly
  // SEQUENCED after the graph fetch (e.g. gated on `payload !== null`) --
  // SessionProvider's own call satisfies "at least one" regardless of the
  // tuner effect's timing. The reviewer empirically confirmed a serialized
  // implementation still passed the old single-call assertion here, then
  // reverted it. Asserting a COUNT of (at least) two calls observed BEFORE
  // the graph fetch is released is what actually proves both callers fired
  // concurrently, not just that SessionProvider's own (unrelated) call
  // happened to satisfy the assertion.
  function countMeCalls(): number {
    return vi
      .mocked(api.apiFetch)
      .mock.calls.filter(([input]) => {
        const url = typeof input === "string" ? input : String(input);
        return url.includes("/api/auth/me");
      }).length;
  }

  it("resolution runs WHILE the graph fetch is in flight -- BOTH /api/auth/me callers (SessionProvider's + the tuner resolution's) fire before fetchGraph settles, not gated on hasNodes", async () => {
    let releaseGraphFetch!: (payload: GraphPayload) => void;
    const graphFetchGate = new Promise<GraphPayload>((resolve) => {
      releaseGraphFetch = resolve;
    });
    vi.spyOn(api, "fetchGraph").mockReturnValue(graphFetchGate);
    renderCanvas({ id: 7, email: "u@example.com", role: "user", acting_as_demo: false }, 200);

    // The graph fetch is still pending (hasNodes stays false, vendor never
    // mounts) -- but BOTH /api/auth/me callers must already have fired by
    // now. A serialized (gated-on-payload) implementation would only ever
    // show SessionProvider's ONE call here.
    await waitFor(() => expect(countMeCalls()).toBeGreaterThanOrEqual(2));
    expect(renderMock).not.toHaveBeenCalled();

    releaseGraphFetch(ONE_NODE_PAYLOAD);
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    const [, , opts] = renderMock.mock.calls[0] as [unknown, unknown, { tunerSnapshot?: Record<string, unknown> }];
    expect(opts.tunerSnapshot).toEqual(GRAPH_DEFAULTS);
  });
});

// Task A1-4 fix round 2 (review Finding 2): a plain before/after read of
// window.__compendiumGraphRendered only proves the flag's value at the two
// sampled instants, not that it was never toggled to something else at any
// point in between -- the cross-transition tests below want the STRONGER
// claim their own comments were making. This installs an accessor property
// that records every value ever assigned, so the assertion can check the
// full write sequence, not just its endpoints. `configurable: true` lets
// the existing afterEach's `delete window.__compendiumGraphRendered`
// remove the accessor cleanly, restoring plain-property behavior for the
// next test.
function spyOnGraphRenderedFlag(): { values: unknown[] } {
  const values: unknown[] = [];
  let current: unknown;
  Object.defineProperty(window, "__compendiumGraphRendered", {
    configurable: true,
    get: () => current,
    set: (v: unknown) => {
      values.push(v);
      current = v;
    },
  });
  return { values };
}

describe("GraphCanvas render-complete signal (Task A1-4: CompendiumLoader.tsx's real dismiss trigger)", () => {
  it("sets window.__compendiumGraphRendered once the vendor's onFirstPaint callback fires", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();

    expect(window.__compendiumGraphRendered).toBeUndefined();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.__compendiumGraphRendered).toBe(true));
  });

  // Task group W, W3 step: the signal moved from "render() returned" to
  // "the worker's first tick painted" -- render() itself stays
  // synchronous (starting a worker and returning immediately), so this
  // pins the actual contract change: reaching/returning from render() is
  // NOT sufficient on its own, only the onFirstPaint callback firing is.
  it("does NOT set the signal merely from render() being called -- only from its onFirstPaint callback firing", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    let capturedOnFirstPaint: (() => void) | undefined;
    renderMock.mockImplementationOnce((...args: unknown[]) => {
      const opts = args[2] as { onFirstPaint?: () => void } | undefined;
      capturedOnFirstPaint = opts?.onFirstPaint;
      // Deliberately do not invoke it here -- this test controls exactly
      // when "first paint" happens, unlike the shared mock's default
      // (queueMicrotask-deferred, see the vi.mock factory above) which
      // every other test in this file relies on for a plain eventual
      // `waitFor`.
      return disposeMock;
    });
    renderCanvas();

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    expect(typeof capturedOnFirstPaint).toBe("function");
    // render() has already been called (and, per its own synchronous
    // contract, already returned) -- the signal must still be unset.
    expect(window.__compendiumGraphRendered).toBeUndefined();

    capturedOnFirstPaint?.();
    expect(window.__compendiumGraphRendered).toBe(true);
  });

  it("is exactly-once even if the vendor's onFirstPaint callback fires more than once (idempotent write)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    const flag = spyOnGraphRenderedFlag();
    let capturedOnFirstPaint: (() => void) | undefined;
    renderMock.mockImplementationOnce((...args: unknown[]) => {
      const opts = args[2] as { onFirstPaint?: () => void } | undefined;
      capturedOnFirstPaint = opts?.onFirstPaint;
      return disposeMock;
    });
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    capturedOnFirstPaint?.();
    capturedOnFirstPaint?.();
    capturedOnFirstPaint?.();

    expect(window.__compendiumGraphRendered).toBe(true);
    expect(flag.values.every((v) => v === true)).toBe(true);
  });

  it("does NOT set the signal while the fetch is still pending", async () => {
    vi.spyOn(api, "fetchGraph").mockImplementation(() => new Promise(() => {})); // never resolves
    renderCanvas();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderMock).not.toHaveBeenCalled();
    expect(document.querySelector("#compendium-empty-state")).toBeNull();
    expect(window.__compendiumGraphRendered).toBeUndefined();
  });

  it("stays true (does not get unset) across a LATER graphVersion-bump re-render", async () => {
    const first = ONE_NODE_PAYLOAD;
    const second: GraphPayload = { ...ONE_NODE_PAYLOAD, nodes: [node("page-1"), node("page-2")] };
    vi.spyOn(api, "fetchGraph").mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.__compendiumGraphRendered).toBe(true));

    act(() => screen.getByText("trigger-refresh").click());
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(2));

    expect(window.__compendiumGraphRendered).toBe(true);
  });

  // Coordinator-adjudicated fix (task-A1-4-report.md's "fix" section): the
  // dismiss trigger's real domain is "canvas settled," and the empty state
  // (payload committed, zero nodes -- GraphPlaceholder TODO(mig-03)
  // obligation 1, `showEmptyState` below) IS a settled state -- a
  // first-time user with nothing captured yet is exactly the loader's own
  // first-run audience, so leaving this path unsignaled would strand it on
  // CompendiumLoader.tsx's ~10s MAX_TRIES fallback instead of dismissing
  // promptly.
  it("sets window.__compendiumGraphRendered once the canvas settles into the empty state (zero nodes, vendor never mounts)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas();

    await waitFor(() => expect(document.querySelector("#compendium-empty-state")).not.toBeNull());
    expect(renderMock).not.toHaveBeenCalled();
    await waitFor(() => expect(window.__compendiumGraphRendered).toBe(true));
  });

  it("does not double-fire or resurrect when a later refetch goes EMPTY -> RENDERED (graphVersion bump)", async () => {
    const flag = spyOnGraphRenderedFlag();
    vi.spyOn(api, "fetchGraph").mockResolvedValueOnce(EMPTY_PAYLOAD).mockResolvedValueOnce(ONE_NODE_PAYLOAD);
    renderCanvas();

    await waitFor(() => expect(document.querySelector("#compendium-empty-state")).not.toBeNull());
    await waitFor(() => expect(window.__compendiumGraphRendered).toBe(true));
    expect(renderMock).not.toHaveBeenCalled();

    act(() => screen.getByText("trigger-refresh").click());
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    // Stronger than an endpoint-only read (review Finding 2): every value
    // EVER assigned to the flag across the WHOLE empty -> rendered
    // transition was `true` -- the empty-state settle and the later real
    // render are two writes of the SAME value, never a toggle through
    // false/undefined at any point in between, not just at the instants
    // this test happened to sample.
    expect(flag.values.length).toBeGreaterThan(0);
    expect(flag.values.every((v) => v === true)).toBe(true);
  });

  it("does not double-fire or resurrect when a later refetch goes RENDERED -> EMPTY (graphVersion bump)", async () => {
    const flag = spyOnGraphRenderedFlag();
    vi.spyOn(api, "fetchGraph").mockResolvedValueOnce(ONE_NODE_PAYLOAD).mockResolvedValueOnce(EMPTY_PAYLOAD);
    renderCanvas();

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.__compendiumGraphRendered).toBe(true));

    act(() => screen.getByText("trigger-refresh").click());
    await waitFor(() => expect(document.querySelector("#compendium-empty-state")).not.toBeNull());

    // Same stronger, full-sequence check as the EMPTY -> RENDERED test
    // above (review Finding 2), mirrored for the opposite direction.
    expect(flag.values.length).toBeGreaterThan(0);
    expect(flag.values.every((v) => v === true)).toBe(true);
    expect(renderMock).toHaveBeenCalledTimes(1); // vendor never re-invoked for the now-empty payload
  });

  // Task A1-4 fix round 2 (review Finding 1): a REJECTED fetchGraph is
  // ALSO a settled canvas -- payload stays null (neither the render() nor
  // the showEmptyState write site above ever fires), but the "Couldn't
  // load graph: ..." error message (JSX below, `error &&` branch) has
  // already painted. Pre-fix, this scenario (e.g. backend down at page
  // load) left the loader stuck on CompendiumLoader.tsx's ~10s MAX_TRIES
  // fallback above an already-rendered error, when the pre-A1-4 stand-in
  // dismissed in under 200ms.
  it("sets window.__compendiumGraphRendered once the canvas settles into the error state (rejected fetch)", async () => {
    vi.spyOn(api, "fetchGraph").mockRejectedValue(new Error("boom"));
    renderCanvas();

    await waitFor(() => expect(screen.getByText(/couldn't load graph: boom/i)).toBeInTheDocument());
    expect(renderMock).not.toHaveBeenCalled();
    await waitFor(() => expect(window.__compendiumGraphRendered).toBe(true));
  });

  it("does not double-fire or resurrect when the error recovers into a rendered graph (retry succeeds)", async () => {
    const flag = spyOnGraphRenderedFlag();
    vi.spyOn(api, "fetchGraph").mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(ONE_NODE_PAYLOAD);
    renderCanvas();

    await waitFor(() => expect(screen.getByText(/couldn't load graph: boom/i)).toBeInTheDocument());
    await waitFor(() => expect(window.__compendiumGraphRendered).toBe(true));
    expect(renderMock).not.toHaveBeenCalled();

    act(() => screen.getByText("trigger-refresh").click());
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    expect(flag.values.length).toBeGreaterThan(0);
    expect(flag.values.every((v) => v === true)).toBe(true);
  });
});

describe("GraphCanvas <-> useGraph() binding (Step 1a/2: graphVersion re-render, no refetch churn)", () => {
  it("mounts once via useGraph() -- an unrelated GraphCanvas re-render does not trigger a second fetchGraph call", async () => {
    const fetchSpy = vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Selecting a node re-renders GraphCanvas via NavProvider's context
    // (same re-render final-review already exercises for recolor() below)
    // -- this must never be mistaken for a reason to refetch.
    act(() => screen.getByText("seed-select").click());
    expect(screen.getByTestId("selected")).toHaveTextContent("seed-node");

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-invokes vendor.render() with the new payload when graphVersion bumps (refresh()), without an extra fetchGraph call beyond the refresh itself", async () => {
    const first = ONE_NODE_PAYLOAD;
    const second: GraphPayload = { ...ONE_NODE_PAYLOAD, nodes: [node("page-1"), node("page-2")] };
    const fetchSpy = vi.spyOn(api, "fetchGraph").mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    renderCanvas();

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    expect(renderMock.mock.calls[0][1]).toBe(first);
    expect(screen.getByTestId("graph-version")).toHaveTextContent("0");

    act(() => screen.getByText("trigger-refresh").click());

    await waitFor(() => expect(screen.getByTestId("graph-version")).toHaveTextContent("1"));
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(2));
    expect(renderMock.mock.calls[1][1]).toBe(second);
    // Same container both times -- a re-render, not a remount.
    expect(renderMock.mock.calls[1][0]).toBe(renderMock.mock.calls[0][0]);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // initial mount load + the one refresh() flight
  });

  it("does NOT re-invoke vendor.render() on mount itself (graphVersion starts at, and stays, 0)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("graph-version")).toHaveTextContent("0");
  });

  it("reapplies the current selection after a graphVersion-triggered re-render", async () => {
    const first = ONE_NODE_PAYLOAD;
    const second: GraphPayload = { ...ONE_NODE_PAYLOAD, nodes: [node("page-1"), node("page-2")] };
    vi.spyOn(api, "fetchGraph").mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    act(() => screen.getByText("seed-select").click());
    await waitFor(() => expect(setSelectionMock).toHaveBeenCalledWith("node", "seed-node"));
    setSelectionMock.mockClear();

    act(() => screen.getByText("trigger-refresh").click());
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(setSelectionMock).toHaveBeenCalledWith("node", "seed-node"));
  });

  // Task V1 (vision-review fix loop, F1) discriminating test. The test
  // above already covers "setSelectionMock is EVENTUALLY called again after
  // a graphVersion bump" -- both the pre-fix and post-fix code satisfy that,
  // since renderMock's DEFAULT implementation fires onFirstPaint via a
  // queueMicrotask regardless of where GraphCanvas.tsx's own reapply call
  // sits, so `waitFor` can't tell the two apart. This test instead pins
  // down WHEN, by overriding renderMock's implementation for the re-render
  // call to capture (not auto-fire) onFirstPaint -- the real vendor's own
  // contract: paintPageDots (and therefore circle.page/use.star-spikes)
  // does not exist until the worker's first `tick` message, which
  // onFirstPaint signals. Pre-fix, GraphCanvas.tsx called
  // setSelectionRef.current?.(...)/setFilterDimRef.current?.(...)
  // synchronously right after renderRef.current(...) returned -- i.e.
  // BEFORE onFirstPaint could possibly have fired against a real worker.
  // Live-verified via CDP against the real (unmocked) vendor + a real
  // Worker (task-V1-report.md): the reapply landed on a DOM the vendor had
  // already wiped for the new render but not yet repainted, a silent no-op
  // that was never corrected once the real paint eventually arrived.
  it("does NOT reapply selection/filter until onFirstPaint fires (not synchronously after render() returns)", async () => {
    const first = ONE_NODE_PAYLOAD;
    const second: GraphPayload = { ...ONE_NODE_PAYLOAD, nodes: [node("page-1"), node("page-2")] };
    vi.spyOn(api, "fetchGraph").mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    act(() => screen.getByText("seed-select").click());
    act(() => screen.getByText("seed-filter").click());
    await waitFor(() => expect(setSelectionMock).toHaveBeenCalledWith("node", "seed-node"));
    await waitFor(() => expect(setFilterDimMock).toHaveBeenCalledWith(["a"]));
    setSelectionMock.mockClear();
    setFilterDimMock.mockClear();

    // Intercept the NEXT render() call: capture onFirstPaint instead of the
    // default mock's auto-fire-via-microtask behavior, so this test controls
    // exactly when the vendor's "DOM now exists" signal fires.
    let capturedOnFirstPaint: (() => void) | undefined;
    renderMock.mockImplementationOnce((...args: unknown[]) => {
      const opts = args[2] as { onFirstPaint?: () => void };
      capturedOnFirstPaint = opts.onFirstPaint;
      return disposeMock;
    });

    act(() => screen.getByText("trigger-refresh").click());
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(2));
    expect(capturedOnFirstPaint).toBeDefined();

    // The DISCRIMINATING assertion: onFirstPaint has NOT fired yet, so
    // neither reapply call may have happened. This is exactly the
    // regression -- pre-fix, GraphCanvas.tsx called setSelectionRef/
    // setFilterDimRef immediately after renderRef.current(...) returned,
    // which would already have satisfied these two calls at this point.
    expect(setSelectionMock).not.toHaveBeenCalled();
    expect(setFilterDimMock).not.toHaveBeenCalled();

    // Now fire the vendor's real "DOM now exists" signal -- the reapply
    // must happen from here, not before.
    act(() => capturedOnFirstPaint?.());
    expect(setSelectionMock).toHaveBeenCalledWith("node", "seed-node");
    expect(setFilterDimMock).toHaveBeenCalledWith(["a"]);
  });

  it("A1-1 ledgered minor (fixed): a selection made DURING the vendor's dynamic-import mount window is not dropped", async () => {
    // Previously (task-A1-1-report.md / progress.md): the mount effect read
    // state.selectedNodeId via closure at effect-DEFINITION time, so a
    // selection made after the effect started but before the dynamic
    // import() resolved was silently ignored until some LATER, unrelated
    // nav action happened to re-fire the separate inbound-wiring effect.
    // The fix reads selection through a ref that's always current, checked
    // at import-RESOLUTION time instead. Dispatching the selection
    // synchronously right after render (before awaiting anything) fires it
    // well before EITHER the mocked fetchGraph() promise or the dynamic
    // import() of the mocked vendor module has had a chance to resolve --
    // exactly the race window the A1-1 report flagged.
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    act(() => screen.getByText("seed-select").click());
    expect(screen.getByTestId("selected")).toHaveTextContent("seed-node");

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    // The mount-time apply must have picked up the selection made during
    // the import window -- not dropped it.
    await waitFor(() => expect(setSelectionMock).toHaveBeenCalledWith("node", "seed-node"));
  });
});

describe("GraphCanvas time-window wiring (Step 3: TimeWindowProvider's second reader)", () => {
  it("mounts with fetchGraph called against the default window 'all'", async () => {
    const fetchSpy = vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith("all");
  });

  it("clicking a DATE RANGE pill refetches with the new window and re-renders the canvas with fewer nodes", async () => {
    const fetchSpy = vi
      .spyOn(api, "fetchGraph")
      .mockImplementation(async (window) => (window === "7" ? WINDOW_7_PAYLOAD : ONE_NODE_PAYLOAD));
    renderCanvas();

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    expect(renderMock.mock.calls[0][1]).toBe(ONE_NODE_PAYLOAD);

    act(() => screen.getByText("window-7").click());

    await waitFor(() => expect(fetchSpy).toHaveBeenLastCalledWith("7"));
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(2));
    expect(renderMock.mock.calls[1][1]).toBe(WINDOW_7_PAYLOAD);
    // graphVersion bumped -- Dash parity (filter_graph_by_time_window bumps
    // graph-version too), and the SAME re-render path a recluster uses.
    await waitFor(() => expect(screen.getByTestId("graph-version")).toHaveTextContent("1"));
  });

  it("re-clicking the currently-active window pill is a no-op -- no extra fetch or re-render", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    act(() => screen.getByText("window-all").click()); // "all" already active
    await act(async () => {
      await Promise.resolve();
    });

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("graph-version")).toHaveTextContent("0");
  });

  it("selection persists across a window-triggered re-render (reapplied via setSelection)", async () => {
    vi.spyOn(api, "fetchGraph").mockImplementation(async (window) =>
      window === "30" ? WINDOW_7_PAYLOAD : ONE_NODE_PAYLOAD
    );
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    act(() => screen.getByText("seed-select").click());
    await waitFor(() => expect(setSelectionMock).toHaveBeenCalledWith("node", "seed-node"));
    setSelectionMock.mockClear();

    act(() => screen.getByText("window-30").click());
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(setSelectionMock).toHaveBeenCalledWith("node", "seed-node"));
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

describe("GraphCanvas filter dimming (Step 5: carried A1-1 deferral)", () => {
  it("state.filterHighlightIds change calls vendor.setFilterDim with the id set", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    setFilterDimMock.mockClear(); // drop the initial mount-time apply ([] -- no filter yet)

    act(() => screen.getByText("seed-filter").click());

    expect(screen.getByTestId("filter-ids")).toHaveTextContent("a");
    await waitFor(() => expect(setFilterDimMock).toHaveBeenCalledWith(["a"]));
  });

  it("does NOT clobber the current selection -- setSelection is not re-invoked as a side effect of a filter change", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    act(() => screen.getByText("seed-select").click());
    await waitFor(() => expect(setSelectionMock).toHaveBeenCalledWith("node", "seed-node"));
    setSelectionMock.mockClear();

    act(() => screen.getByText("seed-filter").click());

    await waitFor(() => expect(setFilterDimMock).toHaveBeenCalledWith(["a"]));
    // Selection state itself is untouched (NavProvider's own reducer row,
    // lib/nav.ts's SET_WINDOW_FILTER: "selection is untouched").
    expect(screen.getByTestId("selected")).toHaveTextContent("seed-node");
    // And the vendor's own setSelection was never re-called by the filter
    // effect -- filter dimming is a genuinely SEPARATE entry point, not
    // routed through setSelection('nodes', ids) (the clobbering path A1-1
    // ruled out).
    expect(setSelectionMock).not.toHaveBeenCalled();
  });

  it("switching to a DIFFERENT filter window updates the vendor with the new id set", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    act(() => screen.getByText("seed-filter").click());
    await waitFor(() => expect(setFilterDimMock).toHaveBeenCalledWith(["a"]));

    act(() => screen.getByText("seed-filter-2").click());
    await waitFor(() => expect(setFilterDimMock).toHaveBeenCalledWith(["a", "b"]));
  });

  it("CLEAR_FILTER calls setFilterDim with an empty array, and leaves selection alone", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    act(() => screen.getByText("seed-select").click());
    act(() => screen.getByText("seed-filter").click());
    await waitFor(() => expect(setFilterDimMock).toHaveBeenCalledWith(["a"]));

    act(() => screen.getByText("clear-filter").click());

    expect(screen.getByTestId("filter-ids")).toHaveTextContent("");
    await waitFor(() => expect(setFilterDimMock).toHaveBeenCalledWith([]));
    expect(screen.getByTestId("selected")).toHaveTextContent("seed-node");
  });

  it("a background-tap HOME clears both selection and the filter, applying setFilterDim([])", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    const [, , opts] = renderMock.mock.calls[0] as [
      unknown,
      unknown,
      { onSelect: (kind: string | null, id: string | null) => void },
    ];

    act(() => screen.getByText("seed-select").click());
    act(() => screen.getByText("seed-filter").click());
    await waitFor(() => expect(setFilterDimMock).toHaveBeenCalledWith(["a"]));

    act(() => opts.onSelect(null, null)); // background tap -> HOME

    expect(screen.getByTestId("selected")).toHaveTextContent("null");
    expect(screen.getByTestId("filter-ids")).toHaveTextContent("");
    await waitFor(() => expect(setFilterDimMock).toHaveBeenLastCalledWith([]));
  });

  it("does not call setFilterDim before the vendor mount has resolved (no crash on a null handle)", async () => {
    // Empty payload -- the vendor never mounts, so setFilterDimRef.current
    // stays null for this render's whole lifetime; dispatching a filter
    // change must still be a safe no-op, not a crash.
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(document.querySelector("#compendium-empty-state")).not.toBeNull());
    expect(renderMock).not.toHaveBeenCalled();

    act(() => screen.getByText("seed-filter").click());
    await act(async () => {
      await Promise.resolve();
    });

    expect(setFilterDimMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("filter-ids")).toHaveTextContent("a");
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

  // Task V3 item 2: the topic panel (Task A1-5) is removed entirely, and
  // with it components/GraphCanvas.tsx's handleCanvasClick -- the ONLY
  // consumer of the #graph-debug-overlay/#compendium-empty-state/
  // .graph-load-error click-exclusion, which existed solely to keep a
  // click on these controls from incorrectly closing the (now-gone) topic
  // panel. #d3-graph-container carries no click handler at all anymore.
  // These 2 tests are adapted from the removed "topic panel opening
  // affordance" describe block's own exclusion regression tests
  // (originally: "clicking noise-toggle-btn does NOT close the panel" /
  // "clicking inside #compendium-empty-state does NOT close the panel") --
  // kept as a regression guard against the SAME class of bug reappearing
  // if a future container-level click handler is added without the same
  // exclusion: a click on these controls/regions must never throw or
  // disturb #graph-debug-overlay's other contents.
  it("regression (Task V3 item 2): clicking noise-toggle-btn does not disturb #graph-debug-overlay or its other controls", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas({ id: 1, email: "admin@example.com", name: "Admin", role: "admin", acting_as_demo: false }, 200);

    await waitFor(() => expect(screen.getByText("view demo")).toBeInTheDocument());
    act(() => screen.getByText("noise: off").click());

    expect(document.querySelector("#graph-debug-overlay")).not.toBeNull();
    expect(screen.getByText("view demo")).toBeInTheDocument();
  });

  it("regression (Task V3 item 2): clicking inside #compendium-empty-state does not throw and leaves #graph-debug-overlay intact", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas({ id: 3, email: "user@example.com", role: "user", acting_as_demo: false }, 200);

    await waitFor(() => expect(document.querySelector("#compendium-empty-state")).not.toBeNull());
    expect(() => (document.getElementById("compendium-empty-state") as HTMLElement).click()).not.toThrow();
    expect(document.querySelector("#graph-debug-overlay")).not.toBeNull();
  });
});

describe("GraphCanvas noise toggle (Step 4)", () => {
  it("defaults to 'noise: off' when the session's show_noise preference is unset, and applies it to the vendor at mount", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas({ id: 1, email: "u@example.com", role: "user", acting_as_demo: false }, 200);

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("noise: off")).toBeInTheDocument());
    await waitFor(() => expect(toggleNoiseMock).toHaveBeenCalledWith(false));
  });

  it("renders 'noise: on' and applies true to the vendor when the session's show_noise preference is true", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas(
      { id: 1, email: "u@example.com", role: "user", acting_as_demo: false, preferences: { show_noise: true } },
      200
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("noise: on")).toBeInTheDocument());
    await waitFor(() => expect(toggleNoiseMock).toHaveBeenCalledWith(true));
  });

  it("clicking the toggle flips the label and calls vendor.toggleNoise with the new state", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    renderCanvas({ id: 1, email: "u@example.com", role: "user", acting_as_demo: false }, 200);
    await waitFor(() => expect(screen.getByText("noise: off")).toBeInTheDocument());
    toggleNoiseMock.mockClear();

    act(() => screen.getByText("noise: off").click());

    expect(screen.getByText("noise: on")).toBeInTheDocument();
    await waitFor(() => expect(toggleNoiseMock).toHaveBeenCalledWith(true));
  });

  it("is keyboard-activatable via Enter/Space (app CSS already targets :focus/:focus-visible on #noise-toggle-btn)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas({ id: 1, email: "u@example.com", role: "user", acting_as_demo: false }, 200);
    await waitFor(() => expect(screen.getByText("noise: off")).toBeInTheDocument());

    const toggle = screen.getByText("noise: off");
    expect(toggle).toHaveAttribute("tabIndex", "0");

    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(screen.getByText("noise: on")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByText("noise: on"), { key: " " });
    expect(screen.getByText("noise: off")).toBeInTheDocument();
  });

  it("clicking the toggle calls patchPreferences with { show_noise } for a normal/admin session", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    const patchSpy = vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    renderCanvas({ id: 1, email: "admin@example.com", role: "admin", acting_as_demo: false }, 200);
    await waitFor(() => expect(screen.getByText("noise: off")).toBeInTheDocument());

    act(() => screen.getByText("noise: off").click());

    await waitFor(() => expect(patchSpy).toHaveBeenCalledWith({ show_noise: true }));
  });

  it("(Step 1c) SKIPS patchPreferences for a plain-demo session (role===demo, not acting), but still flips the control", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    const patchSpy = vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    renderCanvas({ id: 2, email: "demo@example.com", role: "demo", acting_as_demo: false }, 200);
    await waitFor(() => expect(screen.getByText("noise: off")).toBeInTheDocument());

    act(() => screen.getByText("noise: off").click());

    expect(screen.getByText("noise: on")).toBeInTheDocument();
    await waitFor(() => expect(toggleNoiseMock).toHaveBeenCalledWith(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("an admin acting-as-demo session still persists (isPlainDemo is false while acting)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    const patchSpy = vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    renderCanvas(
      { id: 2, email: "demo@example.com", role: "demo", acting_as_demo: true, admin_origin_email: "admin@example.com" },
      200
    );
    await waitFor(() => expect(screen.getByText("noise: off")).toBeInTheDocument());

    act(() => screen.getByText("noise: off").click());

    await waitFor(() => expect(patchSpy).toHaveBeenCalledWith({ show_noise: true }));
  });

  it("the toggle control is never hidden -- visible for a plain (non-admin, non-acting) user, even with an empty graph", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas({ id: 3, email: "user@example.com", role: "user", acting_as_demo: false }, 200);

    await waitFor(() => expect(screen.getByText(/^noise: (on|off)$/)).toBeInTheDocument());
  });
});

describe("GraphCanvas live palette recolor (Task A1-2 wave 8: wire vendor recolor() to theme changes)", () => {
  it("does not call recolor() at mount time -- only on a LATER palette change", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    // Give any stray effects a tick to settle before asserting the negative.
    await act(async () => {
      await Promise.resolve();
    });
    expect(recolorMock).not.toHaveBeenCalled();
  });

  it("calls vendor.recolor() exactly once when the palette changes", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    expect(recolorMock).not.toHaveBeenCalled();

    act(() => screen.getByText("switch-pink").click());
    expect(screen.getByTestId("theme-variant")).toHaveTextContent("Pink");

    await waitFor(() => expect(recolorMock).toHaveBeenCalledTimes(1));
    // Called with no arguments -- the vendor's recolor() takes none.
    expect(recolorMock).toHaveBeenCalledWith();
  });

  it("calls recolor() again on a second, distinct palette switch -- not a one-shot subscription", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    act(() => screen.getByText("switch-pink").click());
    await waitFor(() => expect(recolorMock).toHaveBeenCalledTimes(1));

    act(() => screen.getByText("switch-teal").click());
    await waitFor(() => expect(recolorMock).toHaveBeenCalledTimes(2));
  });

  it("does NOT call recolor() on an unrelated re-render (NavProvider selection change)", async () => {
    vi.spyOn(api, "fetchGraph").mockResolvedValue(ONE_NODE_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    // Selecting a node re-renders GraphCanvas (via NavProvider's context)
    // but never touches the theme variant -- recolor() must stay silent.
    act(() => screen.getByText("seed-select").click());
    expect(screen.getByTestId("selected")).toHaveTextContent("seed-node");

    await act(async () => {
      await Promise.resolve();
    });
    expect(recolorMock).not.toHaveBeenCalled();
  });

  it("does not call recolor() before the vendor mount has resolved (no crash on a null handle)", async () => {
    // Empty payload -- the vendor never mounts (hasNodes stays false), so
    // recolorRef.current stays null for this render's whole lifetime.
    // Switching the palette must still be a safe no-op, not a crash.
    vi.spyOn(api, "fetchGraph").mockResolvedValue(EMPTY_PAYLOAD);
    renderCanvas();
    await waitFor(() => expect(document.querySelector("#compendium-empty-state")).not.toBeNull());
    expect(renderMock).not.toHaveBeenCalled();

    act(() => screen.getByText("switch-pink").click());
    await act(async () => {
      await Promise.resolve();
    });

    expect(recolorMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("theme-variant")).toHaveTextContent("Pink");
  });
});

