import type { ReactNode } from "react";
import Header from "./Header";
import PanelGrid from "./PanelGrid";
import { getInitialPanelWidths } from "@/lib/preferences.server";

interface AppShellProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}

// Server component: reads the signed-in user's persisted panel widths
// before first paint (mirrors Dash's _panel_width_style(), rendered as
// inline style={_panel_width_style()} on .app-container at app.py:2010) so
// there's no resize flash while the client hydrates. Unauthenticated /
// backend-down falls back to the ported CSS's own 20% default, same as Dash.
export default async function AppShell({ left, center, right }: AppShellProps) {
  const { panelLeftWidth, panelRightWidth } = await getInitialPanelWidths();

  return (
    <>
      <Header />
      {/* Supercluster popovers portal (app.py:1912) -- deliberately OUTSIDE
          .app-header. #header-graph-controls animates its mode-swap via
          `transform`, which makes it a containing block for any
          position:fixed descendant; rendering popovers here instead gives
          them a clean, un-transformed ancestor chain so position:fixed
          escapes to the viewport. Empty until a later batch mounts
          supercluster tooltip content into it. */}
      <div id="sc-popovers-portal" />
      <PanelGrid
        initialLeftWidth={panelLeftWidth}
        initialRightWidth={panelRightWidth}
        left={left}
        center={center}
        right={right}
      />
    </>
  );
}
