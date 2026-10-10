"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEMO_ENTRY_ROUTE, TURNSTILE_SCRIPT_URL } from "@/lib/demo-entry";
import { BACKEND_UNREACHABLE_MESSAGE, CHALLENGE_FAILED_MESSAGE, WIDGET_FAILED_MESSAGE } from "@/lib/login-messages";

// demo-one-click-entry: the hosted demo's login card. Cloudflare Turnstile
// renders into the container (managed mode: most visitors see nothing);
// its callback hands us a single-use token that enables the button. The
// web route forwards the token to the API, which verifies it and mints a
// 24-hour demo session. Any error resets the widget, since a token cannot
// be replayed.
export default function DemoEntryForm({ siteKey }: { siteKey: string }) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const renderWidget = useCallback(() => {
    if (!container.current || widgetId.current || !window.turnstile) return;
    widgetId.current = window.turnstile.render(container.current, {
      sitekey: siteKey,
      theme: "dark",
      appearance: "interaction-only",
      callback: (t: string) => setToken(t),
      "expired-callback": () => setToken(""),
      "error-callback": () => {
        setToken("");
        setError(WIDGET_FAILED_MESSAGE);
      },
    });
  }, [siteKey]);

  useEffect(() => {
    renderWidget(); // script already present (navigation back to /login)
    return () => {
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [renderWidget]);

  function resetWidget() {
    setToken("");
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  }

  async function enter() {
    if (!token || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(DEMO_ENTRY_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnstileToken: token }),
      });
      if (res.ok) {
        // Full reload (not router navigation), same idiom as the password
        // login: the app must hydrate every client cache fresh.
        // busy stays set: the navigation is pending and a second click
        // would replay the used token.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload required after login
        window.location.href = "/";
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || CHALLENGE_FAILED_MESSAGE);
      resetWidget();
      setBusy(false);
    } catch {
      setError(BACKEND_UNREACHABLE_MESSAGE);
      resetWidget();
      setBusy(false);
    }
  }

  const disabled = !token || busy;
  return (
    <div data-testid="demo-entry">
      <Script
        src={TURNSTILE_SCRIPT_URL}
        strategy="afterInteractive"
        onLoad={renderWidget}
        onError={() => setError(WIDGET_FAILED_MESSAGE)}
      />
      <p style={{ color: "var(--subtle, #777)", fontSize: "0.85rem", margin: "0 0 16px 0" }}>
        Read-only hosted demo of a sample compendium.
      </p>
      <div ref={container} style={{ minHeight: 0, marginBottom: 12 }} />
      {error && (
        <p role="alert" style={{ color: "var(--subtle, #777)", fontSize: "0.85rem", margin: "0 0 12px 0" }}>
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={enter}
        disabled={disabled}
        style={{
          width: "100%",
          padding: "11px 12px",
          fontSize: "0.95rem",
          fontWeight: 600,
          color: "var(--text)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {busy ? "Entering..." : "Enter demo"}
      </button>
    </div>
  );
}
