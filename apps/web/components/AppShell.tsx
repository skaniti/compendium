import type { ReactNode } from "react";
import CompendiumLoader from "./CompendiumLoader";
import Header from "./Header";
import NavProvider from "./NavProvider";
import PageZoomGuard from "./PageZoomGuard";
import PanelGrid from "./PanelGrid";
import PlainDemoBodyClass from "./PlainDemoBodyClass";
import StarfieldProvider from "./StarfieldProvider";
import TimeWindowProvider from "./TimeWindowProvider";
import {
  getInitialCompendiumLoaderSeen,
  getInitialPanelWidths,
  getInitialSessionRole,
  getInitialStarfieldVariant,
  getInitialTimeWindow,
} from "@/lib/preferences.server";

interface AppShellProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  mode?: "graph" | "dev";
  children?: ReactNode;
}

// Server component: reads the signed-in user's persisted panel widths
// before first paint (mirrors Dash's _panel_width_style(), rendered as
// inline style={_panel_width_style()} on .app-container at app.py:2010) so
// there's no resize flash while the client hydrates. Unauthenticated /
// backend-down falls back to the ported CSS's own 20% default, same as Dash.
export default async function AppShell({ left, center, right, mode = "graph", children }: AppShellProps) {
  // Independent backend reads (different response fields off the same
  // preferences row, but neither call depends on the other's result) --
  // run them concurrently rather than serializing two round-trips.
  const [
    { panelLeftWidth, panelRightWidth },
    initialStarfieldVariant,
    { hasSeen: compendiumLoaderSeen, canPersist: compendiumLoaderCanPersist },
    { role: sessionRole, actingAsDemo },
    initialTimeWindow,
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
    // Gate-2 walkthrough fix 3 (Dash parity): the demo role must NEVER see
    // the first-run tutorial. Dash bakes data-mode="return" for role demo
    // unconditionally -- direct demo login AND admin-launched view-as-demo
    // both get "return" mode, regardless of that account's own
    // compendium_loader_seen preference. Without this, "admin -> view
    // demo" showed first-run whenever the demo account's OWN prefs row
    // happened to have compendium_loader_seen unset (observed live).
    getInitialSessionRole(),
    // Persisted shared time period (graph + dev views), seeded before first paint.
    getInitialTimeWindow(),
  ]);

  const isPlainDemo = sessionRole === "demo" && !actingAsDemo;
  // Force return mode for any demo-role view (direct login or
  // admin-launched acting session) even if this account's own
  // compendium_loader_seen preference says otherwise.
  const forceReturnMode = sessionRole === "demo" || actingAsDemo;
  const initialHasSeen = compendiumLoaderSeen || forceReturnMode;
  // Plain (direct-login, non-acting) demo can never persist preferences
  // server-side -- the backend's update_preferences 403s that PATCH (see
  // its own is_plain_demo gate) -- so skip the pointless write attempt
  // client-side rather than let CompendiumLoader's first-run dismiss fire
  // one anyway. Acting-as-demo is NOT narrowed here: it already resolves
  // canPersist=true via getInitialCompendiumLoaderSeen (a valid token +
  // successful preferences read), and Dash's own behavior is that an
  // admin-launched demo session's writes land on the demo row.
  const canPersist = isPlainDemo ? false : compendiumLoaderCanPersist;

  // Plain demo sessions get 403'd by the backend on ANY preferences PATCH
  // (Dash parity, see the backend's is_plain_demo gate) -- not just the
  // compendium loader's own first-run dismiss (`canPersist` above), but the
  // palette debounce (ThemeProvider, seeded in app/layout.tsx from its own
  // getInitialSessionRole call), the starfield pill clicks
  // (StarfieldProvider, just below), and panel-resize drag persistence
  // (usePanelResize, via PanelGrid's canPersist prop) as well. Unlike
  // `canPersist` above -- which also requires compendiumLoaderCanPersist,
  // i.e. a resolvable authenticated session specifically for the loader's
  // own seen-flag persistence -- this gate is a pure function of
  // isPlainDemo: a null/failed role read (no session confirmed either way)
  // must default to true here, matching every other writer's pre-existing
  // (pre-this-change) behavior when nothing is known about the session.
  const canPersistPreferences = !isPlainDemo;

  return (
    <StarfieldProvider
      initialVariant={initialStarfieldVariant}
      canPersist={canPersistPreferences}
    >
      {/* Full-screen overlay (position: fixed, inset: 0, z-index: 99999 --
          app/styles/compendium-loader.css) -- rendered first so it's the
          first thing painted, though its own z-index (not DOM order) is
          what actually pins it above Header/PanelGrid. */}
      {mode === "graph" && (
        <CompendiumLoader initialHasSeen={initialHasSeen} canPersist={canPersist} />
      )}
      {/* PlainDemoBodyClass (Task 8-C2, deliverable 5): toggles .plain-demo
          on <body> for a direct demo login -- see that component's own
          comment. Renders nothing; mounted anywhere in SessionProvider's
          subtree (SessionProvider wraps this whole shell in
          app/layout.tsx). */}
      <PlainDemoBodyClass />
      {/* PageZoomGuard: prevents Ctrl/Cmd+wheel (and touchpad pinch) from
          page-zooming the browser anywhere in the app. Renders nothing --
          the mechanism (why d3-zoom alone doesn't cover this) is documented
          in that component's own header comment. */}
      {mode === "graph" && <PageZoomGuard />}
      {/* TimeWindowProvider (Task 8-C2): wraps the SAME subtree as
          NavProvider below so both the header (DATE RANGE pills, the
          writer) and the panels (batch 03's graph time-window filter, a
          future reader) share one context instance. */}
      <TimeWindowProvider initialWindow={initialTimeWindow} canPersist={canPersistPreferences}>
        <Header mode={mode} />
        {/* Supercluster popovers portal (app.py:1912) -- deliberately OUTSIDE
            .app-header. #header-graph-controls animates its mode-swap via
            `transform`, which makes it a containing block for any
            position:fixed descendant; rendering popovers here instead gives
            them a clean, un-transformed ancestor chain so position:fixed
            escapes to the viewport. HeaderCards' ScPopover and ScTooltips
            (Task 8-C3) both self-portal their content into this div. */}
        <div id="sc-popovers-portal" />
        {/* NavProvider (Task 5, lib/nav.ts's reducer) mounted here -- the
            lowest common ancestor covering both DiaryPanel (left slot, task
            6) and the future real TopicDetailPanel content (right slot,
            batch 03) that will consume useNav(). Wraps PanelGrid rather than
            each panel slot individually: left/center/right are
            already-rendered ReactNode props built by app/page.tsx (a server
            component), so NavProvider only needs to be a client-boundary
            ancestor somewhere above them in the tree -- it doesn't need to
            construct or touch those nodes itself, same as PanelGrid (also
            "use client") already doesn't. */}
        {mode === "dev" ? (
          <main className="dev-view">{children}</main>
        ) : (
        <NavProvider>
          <PanelGrid
            initialLeftWidth={panelLeftWidth}
            initialRightWidth={panelRightWidth}
            canPersist={canPersistPreferences}
            left={left}
            center={center}
            right={right}
          />
        </NavProvider>
        )}
      </TimeWindowProvider>
    </StarfieldProvider>
  );
}
