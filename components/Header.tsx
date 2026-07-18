"use client";

import type { CSSProperties } from "react";
import SettingsMenu from "./SettingsMenu";
import { useSession } from "./SessionProvider";
import { apiFetch } from "@/lib/api";

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

// Admin-only "view demo" trigger. Same minimal underlined-text idiom as
// Sign out -- Dash's CURRENT version of this link (frontend/dash/layouts/
// graph_canvas.py render_graph_canvas, id="graph-debug-overlay") lives
// inline in the graph-canvas debug overlay's monospace strip, styled to
// match that strip (2026-07-13 relocation). That surface doesn't exist in
// this app yet (batch-03/graph canvas), so per spec.md D4 this trigger
// lives here in the meantime, deliberately NOT trying to mirror the debug
// strip's styling.
// TODO(mig-03): move into the graph debug overlay once it lands; drop this
// header placement then.
const VIEW_DEMO_BUTTON_STYLE: CSSProperties = {
  ...SIGN_OUT_BUTTON_STYLE,
};

// Mirrors the PRE-2026-07-13 Dash floating "Return to admin" pill
// (frontend/dash/app.py, retired in explorer commit 5644ebe -- "the
// position:fixed pill and its clearance-tuning history are deleted" --
// folded into the graph-canvas debug overlay's inline strip instead,
// batch-03 territory). spec.md D4 calls for exactly this floating button
// as the stopgap home until that overlay exists here, so this reconstructs
// the pill's own inline style dict byte-for-byte (Dash styled it inline,
// no CSS class -- app/styles/style.css carries no matching rule to reuse)
// rather than the current debug-strip version. top:150px clears this
// app's own 118px header (see APP_HEADER_STYLE's comment above) with the
// same clearance Dash's own 2026-07-13 header-scaling remeasurement used.
const RETURN_TO_ADMIN_BUTTON_STYLE: CSSProperties = {
  position: "fixed",
  top: "150px",
  left: "12px",
  zIndex: 1000,
  margin: "0",
  background: "var(--highlight, #b39bf3)",
  border: "none",
  borderRadius: "4px",
  color: "#fff",
  fontSize: "0.7rem",
  fontWeight: 600,
  padding: "3px 8px",
  cursor: "pointer",
};

export default function Header() {
  const { role, account, actingAsDemo } = useSession();

  async function handleSignOut(): Promise<void> {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  // JWT port of Dash's admin-only /__view_as_demo switch (D5, batch 04).
  // Non-2xx (403 not-admin/already-acting/demo-unavailable, 401, 5xx) is
  // logged and left for the admin to retry -- the route contract
  // deliberately leaves cookies untouched on failure, so there's no
  // session to recover from here.
  async function handleViewDemo(): Promise<void> {
    const res = await apiFetch("/api/auth/view-as", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "demo" }),
    });
    if (!res.ok) {
      // TODO(mig-03): richer inline error UX once this trigger moves into
      // the graph debug overlay -- kept minimal here per spec.md D4.
      console.error("view-as failed:", res.status);
      return;
    }
    // Full navigation, not client-side state surgery -- Dash's own
    // /__view_as_demo redirects to "/" for the same reason: every
    // server-read preference/role needs to re-hydrate against the new
    // (demo-scoped) identity, not just the parts of the UI this component
    // happens to own.
    window.location.assign("/");
  }

  // JWT port of Dash's /__return_to_admin (D5, batch 04) -- same
  // full-navigation rationale as handleViewDemo above.
  async function handleReturnToAdmin(): Promise<void> {
    const res = await apiFetch("/api/auth/return", { method: "POST" });
    if (!res.ok) {
      console.error("return-to-admin failed:", res.status);
      return;
    }
    window.location.assign("/");
  }

  return (
    <>
      <div className="app-header" style={APP_HEADER_STYLE}>
        <div id="mode-switch-bar" className="mode-switch-bar mode-graph">
          {/* Widget cards (CLUSTERING / DATE RANGE / SUPERCLUSTERS) arrive in
              a later batch -- container hierarchy only for now. */}
          <div id="header-graph-controls" className="hbar-graph-widgets">
            <div className="hbar-cards-row" />
          </div>

          {/* TODO(mig-01 task 5): dev/graph mode switching. Kept in the DOM
              (structure + classes match app.py's _build_dev_menu) but hidden
              until that task decides whether/how it ships. */}
          <div className="dev-menu" style={{ display: "none" }}>
            <button id="dev-graph-toggle-btn" className="header-nav-btn" type="button">
              <div className="hbar-nav-icon" />
              <span id="dev-menu-label" className="hbar-nav-caption">
                Dev
              </span>
            </button>
          </div>
        </div>

        <div style={DIVIDER_STYLE} />

        <div style={ACCOUNT_COLUMN_STYLE}>
          <div style={ACCOUNT_LABEL_STYLE}>Account:</div>
          <div id="account-display" style={ACCOUNT_VALUE_STYLE}>
            {account}
          </div>
          {role === "admin" && (
            <button
              type="button"
              title="View the app as the demo account"
              style={VIEW_DEMO_BUTTON_STYLE}
              onClick={() => void handleViewDemo()}
            >
              view demo
            </button>
          )}
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

      {actingAsDemo && (
        <button
          type="button"
          title="Return to your admin account"
          style={RETURN_TO_ADMIN_BUTTON_STYLE}
          onClick={() => void handleReturnToAdmin()}
        >
          Return to admin
        </button>
      )}
    </>
  );
}
