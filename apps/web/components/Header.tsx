"use client";

import type { CSSProperties } from "react";
import HeaderCards from "./HeaderCards";
import SettingsMenu from "./SettingsMenu";
import DevTabs from "./dev/DevTabs";
import { useSession } from "./SessionProvider";
import { DevArrowsIcon, GraphGlyphIcon, visibleDevViews } from "@/lib/dev-views";

// Mirrors app.py's .app-header inline style block (:1877-1899). Header grew
// 84px -> 118px in the 2026-07-13 header-scaling pass; padding stays
// asymmetric (5px left matches the widget bar's own perimeter, 14px right
// matches the SETTINGS button's top/bottom inset).
const APP_HEADER_STYLE: CSSProperties = {
  height: "118px",
  background: "var(--accent)",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  padding: "0 14px 0 5px",
  gap: "5px",
  flexShrink: 0,
};

const DIVIDER_STYLE: CSSProperties = {
  width: "1px",
  alignSelf: "stretch",
  background: "var(--border)",
  marginLeft: "0",
  marginRight: "9px",
};

const ACCOUNT_COLUMN_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  justifyContent: "center",
  gap: "5px",
  flexShrink: 0,
  marginRight: "5px",
};

const ACCOUNT_LABEL_STYLE: CSSProperties = {
  color: "var(--on-primary, white)",
  fontFamily: "inherit",
  fontSize: "0.7rem",
  fontWeight: 600,
  opacity: 0.75,
  lineHeight: 1,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};

const ACCOUNT_VALUE_STYLE: CSSProperties = {
  color: "var(--on-primary, white)",
  fontFamily: "inherit",
  fontSize: "0.78rem",
  fontWeight: 400,
  opacity: 0.9,
  lineHeight: 1,
  letterSpacing: "0.01em",
  whiteSpace: "nowrap",
};

// Dash implements sign-out as a native <form method="POST"> because
// dcc.Location(refresh=False) intercepts in-app anchor/button clicks as
// client-side routing, swallowing the server-side session-clear. Next has
// no such router interception, so this follows the app's own established
// idiom instead (app/login/page.tsx: fetch + redirect) rather than
// reproducing the Dash-specific form-POST workaround.
const SIGN_OUT_BUTTON_STYLE: CSSProperties = {
  color: "var(--on-primary, white)",
  fontFamily: "inherit",
  fontSize: "0.72rem",
  fontWeight: 400,
  background: "transparent",
  padding: "0",
  border: "none",
  opacity: 0.75,
  cursor: "pointer",
  lineHeight: 1,
  letterSpacing: "0.01em",
  textDecoration: "underline",
  display: "block",
};

export default function Header({ mode = "graph" }: { mode?: "graph" | "dev" }) {
  const { account, role, actingAsDemo } = useSession();
  const firstDev = visibleDevViews(role, actingAsDemo)[0];
  const toggleHref = mode === "graph" ? (firstDev?.href ?? "/dev/pipeline") : "/";

  async function handleSignOut(): Promise<void> {
    await fetch("/api/auth/logout", { method: "POST" });
    // Full reload (not router navigation) is deliberate: sign-out must
    // invalidate every client-side cache/context tied to the ended session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload required after sign-out
    window.location.href = "/login";
  }

  return (
    <div className="app-header" style={APP_HEADER_STYLE}>
      <div id="mode-switch-bar" className={`mode-switch-bar mode-${mode}`}>
        <div id="header-graph-controls" className="hbar-graph-widgets">
          <HeaderCards />
        </div>
        <DevTabs />
        <div className="dev-menu">
          {/* Plain anchor (full navigation) on purpose, as in the Dash app: a
              client-side return to "/" leaves CompendiumLoader's return-fade
              overlay opaque, because the vendored loader initializes once per
              page load and does not re-run its dismiss sequence on remount. */}
          <a
            id="dev-graph-toggle-btn"
            className="header-nav-btn"
            href={toggleHref}
            title={mode === "graph" ? "Open the dev views" : "Back to the graph"}
          >
            <div className="hbar-nav-icon">
              <DevArrowsIcon className="hbar-nav-icon-img hbar-nav-icon-dev" />
              <GraphGlyphIcon className="hbar-nav-icon-img hbar-nav-icon-graph" />
            </div>
            <span id="dev-menu-label" className="hbar-nav-caption">
              {mode === "graph" ? "Dev" : "Graph"}
            </span>
          </a>
        </div>
      </div>

      <div style={DIVIDER_STYLE} />

      <div style={ACCOUNT_COLUMN_STYLE}>
        <div style={ACCOUNT_LABEL_STYLE}>Account:</div>
        <div id="account-display" style={ACCOUNT_VALUE_STYLE}>
          {account}
        </div>
        <button
          type="button"
          title="Sign out (clears session, returns to login screen)"
          style={SIGN_OUT_BUTTON_STYLE}
          onClick={handleSignOut}
        >
          Sign out
        </button>
      </div>

      <SettingsMenu
        // window.__compendiumLoader is attached by lib/vendor/
        // compendium-loader.js once CompendiumLoader.tsx's mount effect
        // finishes loading it (see that component + lib/vendor/vendor.d.ts
        // for the shared ambient type). Optional-chained: a click before
        // the vendor module has initialized is a no-op rather than a
        // throw, which can only happen in the first ~100ms after mount.
        onReplayTutorial={() => window.__compendiumLoader?.replay()}
      />
    </div>
  );
}
