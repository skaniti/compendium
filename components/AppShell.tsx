import type { ReactNode } from "react";
import CompendiumLoader from "./CompendiumLoader";
import Header from "./Header";
import PanelGrid from "./PanelGrid";
import StarfieldProvider from "./StarfieldProvider";
import {
  getInitialCompendiumLoaderSeen,
  getInitialPanelWidths,
  getInitialStarfieldVariant,
} from "@/lib/preferences.server";

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
  // Independent backend reads (different response fields off the same
  // preferences row, but neither call depends on the other's result) --
  // run them concurrently rather than serializing two round-trips.
  const [
    { panelLeftWidth, panelRightWidth },
    initialStarfieldVariant,
    { hasSeen: compendiumLoaderSeen, canPersist: compendiumLoaderCanPersist },
  ] = await Promise.all([
    getInitialPanelWidths(),
    // Same "read before first paint" role as the panel widths above, so
    // the STARFIELD pills (Header -> SettingsMenu) and the mounted
    // background (PanelGrid's center slot -> Starfield) agree on the
    // persisted variant from the very first render -- no client-side GET,
    // no flash of the wrong variant. StarfieldProvider wraps both here
    // since they're siblings below this point, not nested in one another.
    getInitialStarfieldVariant(),
    // Same role again for the loader's first-run/return mode split -- see
    // getInitialCompendiumLoaderSeen's own comment for why this must be
    // resolved server-side (avoids a first-run/return flash).
    getInitialCompendiumLoaderSeen(),
  ]);

  return (
    <StarfieldProvider initialVariant={initialStarfieldVariant}>
      {/* Full-screen overlay (position: fixed, inset: 0, z-index: 99999 --
          app/styles/compendium-loader.css) -- rendered first so it's the
          first thing painted, though its own z-index (not DOM order) is
          what actually pins it above Header/PanelGrid. */}
      <CompendiumLoader
        initialHasSeen={compendiumLoaderSeen}
        canPersist={compendiumLoaderCanPersist}
      />
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
    </StarfieldProvider>
  );
}
