"use client";

import { useEffect } from "react";
import { useSession } from "./SessionProvider";

// Next equivalent of app.py's plain-demo-class-dummy clientside callback
// (#7, 2026-07-13 item 2): toggles a `.plain-demo` class on <body> for a
// DIRECT demo login only (role "demo" with no admin_launched_demo/
// actingAsDemo marker -- demo-as-admin and the real admin keep the class
// off). The ported CSS (app/styles/style.css:1326) keys off this class to
// hide .hbar-sc-popover, #suggested-topics-panel, etc. for that session
// (#recluster-btn is greyed out instead, by HeaderCards, for any demo).
//
// UX ONLY, same as Dash's own comment on this callback: the actual
// privilege boundary is server-side (the backend's is_plain_demo gate on
// each guarded mutation endpoint) -- this class only hides controls that
// would otherwise invite a click nothing will honor.
//
// Mounted inside AppShell (a server component, so the effect itself can't
// live there) -- anywhere within SessionProvider's subtree works, since
// this reads useSession() and renders nothing.
export default function PlainDemoBodyClass() {
  const { role, actingAsDemo } = useSession();

  useEffect(() => {
    const isPlainDemo = role === "demo" && !actingAsDemo;
    document.body.classList.toggle("plain-demo", isPlainDemo);
    return () => {
      document.body.classList.remove("plain-demo");
    };
  }, [role, actingAsDemo]);

  return null;
}
