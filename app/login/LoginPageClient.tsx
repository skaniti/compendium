"use client";

import { useState, type CSSProperties, type FormEvent } from "react";
import Starfield from "@/components/Starfield";
import StarfieldProvider, { DEFAULT_STARFIELD_VARIANT } from "@/components/StarfieldProvider";
import { getTokens } from "@/lib/theme";

// Ported from explorer frontend/dash/app.py:_build_login_layout (app.py:2149-2309).
// The Dash login view forces the Teal palette on every visitor regardless of
// their saved theme (app.py:2164-2175: "Teal's mint highlight pairs with the
// favicon") -- we mirror that by overriding the CSS custom properties inline
// on the page's own wrapper rather than touching the global theme-root style
// tag ThemeProvider owns (app/layout.tsx), same isolation Dash gets from
// building a standalone layout tree for the pre-auth view.
const LOGIN_PALETTE = "Teal";

function buildDarkVars(): CSSProperties {
  const tokens = getTokens(LOGIN_PALETTE);
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    vars[`--${key.replace(/_/g, "-")}`] = value;
  }
  // app.py:2175 -- "fill gap (no var(--subtle) is derived)"; text_muted
  // stands in, same as Dash's _dark_vars["--subtle"] assignment.
  vars["--subtle"] = tokens.text_muted;
  return vars as CSSProperties;
}

const fieldStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: "0.95rem",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  fontSize: "0.78rem",
  color: "var(--subtle, #777)",
};

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      // Full reload (not router navigation) is deliberate: login must
      // invalidate every client-side cache/context left over from the
      // previous (signed-out or different-user) session.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload required after login
      window.location.href = "/";
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setError(data.error || "Invalid credentials");
  }

  return (
    <div
      style={{
        ...buildDarkVars(),
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 20,
        boxSizing: "border-box",
        colorScheme: "dark",
      }}
    >
      {/* Full-viewport background (position:fixed by default -- see
          lib/vendor/starry-sky.js) -- Dash's #starry-sky-mount sits outside
          .panel-center on this view so it never gets the canvas-scoped
          position:absolute override from starry-selector.css, unlike the
          logged-in app's center panel. */}
      <Starfield />
      <div
        style={{
          width: "100%",
          maxWidth: 360,
          padding: "40px 36px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
          position: "relative",
          zIndex: 2,
        }}
      >
        <h1
          style={{
            fontFamily: "Georgia, serif",
            fontSize: "2.4rem",
            margin: "0 0 4px 0",
            letterSpacing: "0.04em",
            color: "var(--text)",
          }}
        >
          compendium
        </h1>
        <p
          style={{
            color: "var(--subtle, #777)",
            fontSize: "0.85rem",
            margin: "0 0 28px 0",
          }}
        >
          Knowledge graph from your browsing rabbit-holes
        </p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="login-email" style={labelStyle}>
            Email or username
          </label>
          {/* type="text" (not "email"): an email-typed input makes the
              browser reject a bare username before submit. name="email"
              stays -- the API route reads that field and resolves
              email-or-username server-side (get_user_by_login). */}
          <input
            type="text"
            name="email"
            id="login-email"
            placeholder="you@example.com or username"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ ...fieldStyle, marginTop: 4, marginBottom: 14 }}
          />
          <label htmlFor="login-password" style={labelStyle}>
            Password
          </label>
          <input
            type="password"
            name="password"
            id="login-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ ...fieldStyle, marginTop: 4, marginBottom: 8 }}
          />
          <div
            role={error ? "alert" : undefined}
            style={{
              color: "#c0392b",
              fontSize: "0.8rem",
              minHeight: 20,
              marginBottom: 14,
            }}
          >
            {error}
          </div>
          <button
            type="submit"
            style={{
              width: "100%",
              padding: "11px 12px",
              fontSize: "0.95rem",
              fontWeight: 600,
              color: "var(--text)",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}

// The login form renders pre-auth and lives outside AppShell (no header,
// no panels) -- it composes its own StarfieldProvider instead of inheriting
// one, seeded to the same default a logged-out visitor gets in Dash
// (STARRY_SKY_VARIANT default "twinkle", app.py:2198 / graph_canvas.py:75).
//
// Extracted out of app/login/page.tsx (dev-login recovery fix): that file
// is now a server component that probes identity before deciding whether
// this form is reachable at all -- see its own comment. This client half
// is unchanged from before that split; it's still the ONLY thing rendered
// when the probe can't resolve a usable identity (hosted/prod's real
// signed-out state, or a probe failure).
export default function LoginPageClient() {
  return (
    <StarfieldProvider initialVariant={DEFAULT_STARFIELD_VARIANT}>
      <LoginForm />
    </StarfieldProvider>
  );
}
