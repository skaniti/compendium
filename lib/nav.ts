// Navigation state model -- ports frontend/dash/callbacks/navigation.py's
// update_nav_stack callback (flat post-2026-05-02 schema) to a plain,
// synchronous reducer. Selection and filter are separate concerns: filter
// persists across selection changes (clicking a window then a node leaves
// the highlight overlay intact); the two only clear together on a
// Home-shaped action (HOME, BREADCRUMB_JUMP(""), and a canvas background
// tap -- see resolveCanvasTapAction below).
//
// Dash's flat schema: {selected_node_id, filter_session_id,
// filter_highlight_ids} (filter_highlight_ids: list[str] | None, using None
// for "no highlights"). We normalize that to [] here instead of carrying a
// nullable array -- this is pure client state with no wire format to stay
// bit-compatible with, so [] is the more ergonomic empty representation
// (consumers never have to null-check the array itself).
//
// Breadcrumb is intentionally NOT part of this state, same as Dash
// (topic_detail.py's _build_breadcrumbs derives it from selected_node_id by
// walking graph parents rather than storing a path). hooks/useGraph.ts's
// breadcrumbFor() is the equivalent derivation on this side.

export interface NavState {
  selectedNodeId: string | null;
  filterWindowKey: string | null;
  filterHighlightIds: string[];
}

// Interface contract -- Tasks 6-7 and batch 03 consume this; keep the type
// and field names exact.
//
// SELECT_NODE / SELECT_CLUSTER are behaviorally IDENTICAL in the reducer
// (both just set selectedNodeId): they exist as two names for semantic
// clarity at call sites (a d3 node tap vs a cluster label/tag-btn tap), not
// because the state transition differs. CLEAR_SELECTION clears selection
// only -- it exists for batch 03's Esc-key path, which has no Dash
// equivalent. Dash's canvas background tap does NOT map to CLEAR_SELECTION;
// see resolveCanvasTapAction's comment for why it resolves to HOME instead.
export type NavAction =
  | { type: "SELECT_NODE"; id: string }
  | { type: "SELECT_CLUSTER"; id: string }
  | { type: "SET_WINDOW_FILTER"; key: string; nodeIds: string[] }
  | { type: "CLEAR_SELECTION" }
  | { type: "CLEAR_FILTER" }
  | { type: "HOME" }
  | { type: "BREADCRUMB_JUMP"; id: string };

export const initialNavState: NavState = {
  selectedNodeId: null,
  filterWindowKey: null,
  filterHighlightIds: [],
};

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case "SELECT_NODE":
    case "SELECT_CLUSTER":
      // Dash row 1: both "node" and "cluster" d3-tap kinds just set
      // selection; filter is untouched.
      return { ...state, selectedNodeId: action.id };

    case "SET_WINDOW_FILTER":
      // Dash row 3: window-btn / overflow-btn set the filter; selection is
      // untouched so a prior drill-down survives the filter switch.
      // Dash row 4: repeat-clicking the SAME already-active window re-sets
      // the identical filter -- idempotent, NOT a toggle-off. Dash removed
      // toggle-to-home on 2026-05-02 (it conflated user intent with Dash
      // callback re-fires); this reducer has no toggle branch at all, so
      // dispatching SET_WINDOW_FILTER twice with the same payload is
      // structurally idempotent by construction rather than by a special case.
      return { ...state, filterWindowKey: action.key, filterHighlightIds: action.nodeIds };

    case "CLEAR_SELECTION":
      // Batch 03's Esc-key path only -- Dash's background tap does NOT
      // dispatch this (it clears both selection and filter; see
      // resolveCanvasTapAction below).
      return { ...state, selectedNodeId: null };

    case "CLEAR_FILTER":
      // Dash row 7: clear-filter-btn (filter chip's X) clears filter only,
      // selection untouched.
      return { ...state, filterWindowKey: null, filterHighlightIds: [] };

    case "HOME":
      // Dash row 6: home-btn clears BOTH selection and filter.
      return { ...initialNavState };

    case "BREADCRUMB_JUMP":
      // Dash row 9: an id jumps selection (filter untouched); an EMPTY id
      // is the Home crumb and clears BOTH -- `if not index: _clear_all()`
      // in navigation.py. NOT "home-for-selection-only" -- verified
      // directly against navigation.py at explorer HEAD.
      return action.id === "" ? { ...initialNavState } : { ...state, selectedNodeId: action.id };

    default:
      // Dash row 10: unknown/absent action data -> state unchanged.
      return state;
  }
}

// Dash row 5: tag-btn's `index` is "{sessionId}::{nodeId}" or a bare
// nodeId. Ports `idx_str.split("::", 1)[-1] if "::" in idx_str else
// idx_str` EXACTLY: split on the FIRST "::" only (maxsplit=1), take the
// part AFTER it -- which may itself still contain "::" if the id had more
// than one occurrence. A naive `.split("::")` (no limit) + take-last would
// be WRONG for an id like "key::a::b" (Dash keeps "a::b" whole; a naive
// split-all-and-last would truncate it to just "b").
export function parseTagBtnIndex(idxStr: string): string {
  const sep = "::";
  const i = idxStr.indexOf(sep);
  return i === -1 ? idxStr : idxStr.slice(i + sep.length);
}

// The d3 canvas tap binding point -- batch 03 wires the D3 click handler to
// this via useNav()'s selectFromCanvas convenience (components/NavProvider.tsx).
// Two distinct Dash cases here, per navigation.py's d3-tap-node branch
// (explorer frontend/dash/callbacks/navigation.py:164-179):
//   - kind === null (no tap_data at all) is a BACKGROUND tap: `if not
//     tap_data: result = _clear_all()`. The SVG walk-up only sends a null
//     tap when nothing is already selected, so at that point it reads as
//     "go Home" -- this resolves to HOME (not CLEAR_SELECTION;
//     CLEAR_SELECTION is reserved for batch 03's Esc-key path, a distinct,
//     selection-only-clear user action Dash has no equivalent of).
//   - kind non-null but id missing/empty is tap_data PRESENT with a falsy
//     id: `node_id = tap_data.get("id"); if not node_id: result =
//     no_update`. Dash IGNORES this tap entirely -- the tap is a no-op,
//     nothing clears and nothing selects. This resolves to null; callers
//     MUST skip dispatching when they get null back (see NavProvider.tsx's
//     selectFromCanvas).
export function resolveCanvasTapAction(
  kind: "node" | "cluster" | null,
  id?: string
): NavAction | null {
  if (kind === null) return { type: "HOME" };
  if (!id) return null;
  return kind === "cluster" ? { type: "SELECT_CLUSTER", id } : { type: "SELECT_NODE", id };
}
