import { describe, expect, it } from "vitest";
import {
  initialNavState,
  navReducer,
  parseTagBtnIndex,
  resolveCanvasTapAction,
  type NavAction,
  type NavState,
} from "./nav";

// Ports frontend/dash/callbacks/navigation.py's update_nav_stack callback
// (flat post-2026-05-02 schema) to a pure reducer. Each test below cites the
// Dash source row it ports (see this task's brief / controller corrections --
// the brief's own row list had two rows WRONG relative to navigation.py at
// explorer HEAD: "background click clears selection only" and "breadcrumb ''
// == home-for-selection" -- both actually clear BOTH selection and filter.
// Verified directly against navigation.py, not against the brief's summary.

const selected = "node-a";
const otherId = "node-b";

function withSelection(nodeId: string | null = selected): NavState {
  return { ...initialNavState, selectedNodeId: nodeId };
}

function withFilter(key = "win-1", nodeIds = ["a", "b"]): NavState {
  return { ...initialNavState, filterWindowKey: key, filterHighlightIds: nodeIds };
}

describe("initialNavState", () => {
  it("normalizes Dash's null filter_highlight_ids to an empty array", () => {
    // Dash's flat schema stores filter_highlight_ids as list[str] | None,
    // using None for "no highlights". This side normalizes that to [] so
    // consumers never have to null-check the array itself.
    expect(initialNavState).toEqual({
      selectedNodeId: null,
      filterWindowKey: null,
      filterHighlightIds: [],
    });
  });
});

describe("navReducer", () => {
  // Dash row 1: node tap from canvas sets selection; filter untouched.
  it("row 1 -- SELECT_NODE sets selectedNodeId and leaves the filter untouched", () => {
    const state = withFilter();
    const next = navReducer(state, { type: "SELECT_NODE", id: selected });
    expect(next).toEqual({ ...state, selectedNodeId: selected });
  });

  // Dash row 1: "Both 'node' and 'cluster' tap types just set selection" --
  // SELECT_CLUSTER must be behaviorally identical to SELECT_NODE.
  it("row 1 -- SELECT_CLUSTER behaves identically to SELECT_NODE (cluster tap kind)", () => {
    const state = withFilter();
    const viaNode = navReducer(state, { type: "SELECT_NODE", id: selected });
    const viaCluster = navReducer(state, { type: "SELECT_CLUSTER", id: selected });
    expect(viaCluster).toEqual(viaNode);
  });

  // Dash row 2 (background tap): "background-click only fires when nothing
  // is selected, so it reads as go Home" -- clears BOTH selection and
  // filter. The brief's test-list summary ("background click clears
  // selection only") is WRONG per navigation.py at explorer HEAD; this test
  // asserts the corrected, verified behavior.
  it("row 2 -- a background canvas tap (resolveCanvasTapAction(null)) clears BOTH selection and filter", () => {
    const state: NavState = { ...withSelection(), filterWindowKey: "win-1", filterHighlightIds: ["a"] };
    const action = resolveCanvasTapAction(null);
    expect(action).toEqual({ type: "HOME" });
    const next = navReducer(state, action);
    expect(next).toEqual(initialNavState);
  });

  // Dash row 2 continued: a tap with a kind but no id is ALSO a background
  // tap (the brief's binding-point note: "kind null (or missing id) =
  // background tap -> full clear").
  it("row 2 -- resolveCanvasTapAction with a kind but a missing id is also treated as a background tap", () => {
    expect(resolveCanvasTapAction("node", undefined)).toEqual({ type: "HOME" });
    expect(resolveCanvasTapAction("cluster", "")).toEqual({ type: "HOME" });
  });

  it("resolveCanvasTapAction resolves node/cluster kinds to the matching select action", () => {
    expect(resolveCanvasTapAction("node", selected)).toEqual({ type: "SELECT_NODE", id: selected });
    expect(resolveCanvasTapAction("cluster", selected)).toEqual({ type: "SELECT_CLUSTER", id: selected });
  });

  // Dash row 3: window-btn sets the filter; selection untouched so a prior
  // drill-down survives the filter switch.
  it("row 3 -- SET_WINDOW_FILTER (window-btn) sets the filter and leaves selection untouched", () => {
    const state = withSelection();
    const next = navReducer(state, { type: "SET_WINDOW_FILTER", key: "win-1", nodeIds: ["a", "b"] });
    expect(next).toEqual({ ...state, filterWindowKey: "win-1", filterHighlightIds: ["a", "b"] });
  });

  // Dash row 3: "overflow-btn ≡ window-btn exactly" -- there is no separate
  // action type or reducer branch for it; the same SET_WINDOW_FILTER
  // dispatch covers both call sites identically.
  it("row 3 -- overflow-btn dispatches the identical SET_WINDOW_FILTER action as window-btn (no separate branch exists)", () => {
    const state = withSelection();
    const windowBtn = navReducer(state, { type: "SET_WINDOW_FILTER", key: "win-2", nodeIds: ["c"] });
    const overflowBtn = navReducer(state, { type: "SET_WINDOW_FILTER", key: "win-2", nodeIds: ["c"] });
    expect(overflowBtn).toEqual(windowBtn);
  });

  // Dash row 4: Dash deliberately REMOVED toggle-to-home on 2026-05-02 (it
  // conflated user intent with Dash callback re-fires). Repeat-clicking the
  // already-active window re-sets the SAME filter -- idempotent, NOT a
  // toggle-off. This reducer has no toggle branch at all, so the
  // idempotence falls out of the plain assignment rather than needing a
  // special "already active" check.
  it("row 4 -- repeat SET_WINDOW_FILTER on the already-active window is idempotent, not a toggle-off", () => {
    const state = withSelection();
    const first = navReducer(state, { type: "SET_WINDOW_FILTER", key: "win-1", nodeIds: ["a"] });
    const second = navReducer(first, { type: "SET_WINDOW_FILTER", key: "win-1", nodeIds: ["a"] });
    expect(second).toEqual(first);
    expect(second.filterWindowKey).toBe("win-1");
    expect(second.filterHighlightIds).toEqual(["a"]);
  });

  // Dash row 5: tag-btn index is "{sessionId}::{nodeId}" or a bare nodeId.
  // Ports idx_str.split("::", 1)[-1] if "::" in idx_str else idx_str.
  it("row 5 -- SELECT_CLUSTER from a parsed tag-btn index sets selection and leaves filter untouched", () => {
    const state = withFilter();
    const parsedId = parseTagBtnIndex("win-1::cluster-7");
    const next = navReducer(state, { type: "SELECT_CLUSTER", id: parsedId });
    expect(next).toEqual({ ...state, selectedNodeId: "cluster-7" });
  });

  it("parseTagBtnIndex splits on the FIRST '::' only and takes the LAST part", () => {
    expect(parseTagBtnIndex("win-1::cluster-7")).toBe("cluster-7");
  });

  it("parseTagBtnIndex returns a bare id unchanged when there is no '::'", () => {
    expect(parseTagBtnIndex("cluster-7")).toBe("cluster-7");
  });

  it("parseTagBtnIndex keeps everything after the FIRST '::' when the id itself contains more '::'", () => {
    // Python's idx_str.split("::", 1)[-1] uses maxsplit=1: splitting
    // "win-1::a::b" yields ["win-1", "a::b"], and [-1] takes "a::b" WHOLE --
    // not "b". A naive split-on-all-and-take-last would wrongly truncate
    // this to "b".
    expect(parseTagBtnIndex("win-1::a::b")).toBe("a::b");
  });

  // Dash row 6: home-btn clears BOTH selection and filter.
  it("row 6 -- HOME clears both selection and filter", () => {
    const state: NavState = { selectedNodeId: selected, filterWindowKey: "win-1", filterHighlightIds: ["a"] };
    const next = navReducer(state, { type: "HOME" });
    expect(next).toEqual(initialNavState);
  });

  // Dash row 7: clear-filter-btn (filter chip's X) clears filter only,
  // selection untouched.
  it("row 7 -- CLEAR_FILTER clears the filter only, leaving selection untouched", () => {
    const state: NavState = { selectedNodeId: selected, filterWindowKey: "win-1", filterHighlightIds: ["a"] };
    const next = navReducer(state, { type: "CLEAR_FILTER" });
    expect(next).toEqual({ selectedNodeId: selected, filterWindowKey: null, filterHighlightIds: [] });
  });

  // Dash row 8: nav-node-btn (right-panel child item) just sets selection,
  // same as SELECT_NODE -- there's no dedicated action type for it, callers
  // dispatch SELECT_NODE directly.
  it("row 8 -- nav-node-btn (right-panel child) sets selection via SELECT_NODE, filter untouched", () => {
    const state = withFilter();
    const next = navReducer(state, { type: "SELECT_NODE", id: otherId });
    expect(next).toEqual({ ...state, selectedNodeId: otherId });
  });

  // Dash row 9: breadcrumb-btn with an id jumps selection; filter untouched.
  it("row 9 -- BREADCRUMB_JUMP with an id jumps selection and leaves filter untouched", () => {
    const state = withFilter();
    const next = navReducer(state, { type: "BREADCRUMB_JUMP", id: otherId });
    expect(next).toEqual({ ...state, selectedNodeId: otherId });
  });

  // Dash row 9 continued: `if not index: _clear_all()` -- an EMPTY id is
  // the Home crumb and clears BOTH selection and filter. The brief's
  // test-list summary ("breadcrumb '' == home-for-selection", i.e.
  // selection-only) is WRONG per navigation.py at explorer HEAD; this is
  // full Home, same as row 6.
  it('row 9 -- BREADCRUMB_JUMP("") clears BOTH selection and filter (full Home, not selection-only)', () => {
    const state: NavState = { selectedNodeId: selected, filterWindowKey: "win-1", filterHighlightIds: ["a"] };
    const next = navReducer(state, { type: "BREADCRUMB_JUMP", id: "" });
    expect(next).toEqual(initialNavState);
  });

  // Dash row 10: unknown/absent action data -> state unchanged.
  it("row 10 -- an unrecognized action type leaves state unchanged", () => {
    const state = withFilter("win-1", ["a"]);
    const unknown = { type: "SOMETHING_UNKNOWN" } as unknown as NavAction;
    const next = navReducer(state, unknown);
    expect(next).toEqual(state);
  });

  // CLEAR_SELECTION exists only for batch 03's Esc-key path -- Dash has no
  // equivalent input that maps to it (background tap maps to HOME instead,
  // per row 2's test above). Still part of the exact NavAction contract, so
  // gets its own reducer test.
  it("CLEAR_SELECTION clears selection only, leaving the filter untouched (03's Esc-key path, no Dash row maps to it)", () => {
    const state: NavState = { selectedNodeId: selected, filterWindowKey: "win-1", filterHighlightIds: ["a"] };
    const next = navReducer(state, { type: "CLEAR_SELECTION" });
    expect(next).toEqual({ selectedNodeId: null, filterWindowKey: "win-1", filterHighlightIds: ["a"] });
  });
});
