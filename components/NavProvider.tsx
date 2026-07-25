"use client";

import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import {
  initialNavState,
  navReducer,
  resolveCanvasTapAction,
  type NavAction,
  type NavState,
} from "@/lib/nav";

// React context wrapper around lib/nav.ts's pure navReducer (Task 5, batch
// 02) -- see that file for the full Dash transition-table parity notes and
// lib/nav.test.ts for the row-by-row coverage. This file is deliberately
// thin: all the actual state-transition logic lives in the pure reducer so
// it stays independently testable without mounting React.

export interface NavContextValue {
  state: NavState;
  dispatch: (action: NavAction) => void;
  // The batch 03 binding point for the D3 canvas tap handler -- resolves a
  // (kind, id) tap into the right NavAction via lib/nav.ts's
  // resolveCanvasTapAction (see that function's comment for the
  // background-tap-clears-both rationale) and dispatches it. A kind with a
  // missing/empty id resolves to null (Dash's `if not node_id: no_update` --
  // the tap is ignored, nothing clears or selects): selectFromCanvas is a
  // no-op in that case, it does not dispatch anything.
  selectFromCanvas: (kind: "node" | "cluster" | null, id?: string) => void;
}

const NavContext = createContext<NavContextValue | null>(null);

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav must be used within a NavProvider");
  return ctx;
}

export default function NavProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(navReducer, initialNavState);

  const value = useMemo<NavContextValue>(
    () => ({
      state,
      dispatch,
      selectFromCanvas: (kind, id) => {
        const action = resolveCanvasTapAction(kind, id);
        if (action) dispatch(action);
      },
    }),
    [state]
  );

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}
