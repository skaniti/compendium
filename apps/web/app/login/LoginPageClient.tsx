"use client";

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import Starfield from "@/components/Starfield";
import StarfieldProvider, { DEFAULT_STARFIELD_VARIANT } from "@/components/StarfieldProvider";
import { getTokens } from "@/lib/theme";
import { recoverSession } from "@/lib/api";
import { TAILNET_LOGIN_ROUTE } from "@/lib/tailnet-login";
import { sessionMayResume } from "@/lib/session-policy-client";
import { turnstileSiteKey } from "@/lib/demo-entry";
import { passkeyErrorMessage, runPasskeyAuthentication } from "@/lib/passkey-client";
import { PASSKEY_FAILED_MESSAGE, PASSKEY_NEEDS_TAILNET_MESSAGE } from "@/lib/login-messages";
import DemoEntryForm from "./DemoEntryForm";

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

const primaryButtonStyle: CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "var(--text)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
};

const errorStyle: CSSProperties = {
  color: "#c0392b",
  fontSize: "0.8rem",
  minHeight: 20,
  marginBottom: 14,
};

const linkButtonStyle: CSSProperties = {
  display: "block",
  textAlign: "center",
  width: "100%",
  boxSizing: "border-box",
  padding: "11px 12px",
  marginBottom: 18,
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "var(--text)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  textDecoration: "none",
};

const quietLinkStyle: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  marginTop: 14,
  color: "var(--subtle, #777)",
  fontSize: "0.78rem",
  textDecoration: "underline",
  cursor: "pointer",
};

export interface LoginPageClientProps {
  tailnetLogin?: string | null;
  trustedBrowser?: boolean;
  paused?: boolean;
  tailnetNotice?: "failed" | "error" | null;
  demoEntry?: boolean;
  passkey?: { onRpHost: boolean; rpId: string } | null;
}

function LoginForm({
  tailnetLogin = null,
  trustedBrowser = false,
  paused = false,
  tailnetNotice = null,
  demoEntry = false,
  passkey = null,
}: LoginPageClientProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const offerTrust = tailnetLogin !== null && !trustedBrowser;
  const [trustBrowser, setTrustBrowser] = useState(true);
  const [breakGlassOpen, setBreakGlassOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // D4 (session-expiry-tuning): a remembered (or otherwise still-resumable)
  // visitor landing on /login -- e.g. a stale bookmark, or redirectToLogin
  // firing just before an idle-window-eligible refresh would have succeeded
  // -- gets sent straight back in instead of being shown a form they don't
  // need. sessionMayResume reads the session_policy/session_last_active
  // cookies client-side (no network call); recoverSession is the same
  // single-flight refresh apiFetch's own 401 path shares.
  useEffect(() => {
    if (!sessionMayResume(Date.now())) return;
    let cancelled = false;
    void recoverSession().then((recovered) => {
      if (recovered && !cancelled) {
        // Full reload (not router navigation), same idiom as the
        // post-login redirect below -- a resumed session must hydrate
        // every client-side cache/context fresh, same as a normal login.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload required after session resume
        window.location.assign("/");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, ...(offerTrust && !passkey ? { trustBrowser } : {}) }),
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

  async function handlePasskey() {
    setError("");
    setBusy(true);
    try {
      const optionsRes = await fetch("/api/auth/passkey/login/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const optionsData = (await optionsRes.json().catch(() => ({}))) as { options?: unknown; error?: string };
      if (!optionsRes.ok || !optionsData.options) {
        setError(optionsData.error || PASSKEY_FAILED_MESSAGE);
        return;
      }
      let response: unknown;
      try {
        response = await runPasskeyAuthentication(optionsData.options as never);
      } catch (err) {
        setError(passkeyErrorMessage(err, "login"));
        return;
      }
      const verifyRes = await fetch("/api/auth/passkey/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, trustBrowser: offerTrust ? trustBrowser : false }),
      });
      if (verifyRes.ok) {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload required after login
        window.location.href = "/";
        return;
      }
      const data = (await verifyRes.json().catch(() => ({}))) as { error?: string };
      setError(data.error || PASSKEY_FAILED_MESSAGE);
    } catch {
      setError(PASSKEY_FAILED_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  // Shared by the password form and the break-glass form.
  const identifierField = (
    <>
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
    </>
  );

  const trustCheckbox = (
    <label htmlFor="login-trust" style={{ ...labelStyle, display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
      <input
        type="checkbox"
        id="login-trust"
        checked={trustBrowser}
        onChange={(e) => setTrustBrowser(e.target.checked)}
      />
      Trust this browser for automatic sign-in
    </label>
  );

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
        {demoEntry ? (
          <DemoEntryForm siteKey={turnstileSiteKey()} />
        ) : (
          <>
            {tailnetLogin && (
              <p data-testid="tailnet-identity" style={{ ...labelStyle, margin: "0 0 12px 0" }}>
                Tailscale: signed in as {tailnetLogin}
              </p>
            )}
            {tailnetNotice && (
              <p role="status" style={{ ...labelStyle, margin: "0 0 12px 0" }}>
                {passkey && !passkey.onRpHost
                  ? `Automatic sign-in isn't available on this address. Sign in at https://${passkey.rpId}, or use a break-glass code.`
                  : passkey
                  ? tailnetNotice === "failed"
                    ? "Automatic sign-in didn't work for this browser. Sign in with your passkey to trust it again."
                    : "Automatic sign-in is unavailable right now. Sign in with your passkey."
                  : tailnetNotice === "failed"
                    ? "Automatic sign-in didn't work for this browser. Sign in with your password to trust it again."
                    : "Automatic sign-in is unavailable right now. Sign in with your password."}
              </p>
            )}
            {tailnetLogin && trustedBrowser && (paused || tailnetNotice) && (
              <a
                data-testid="tailnet-continue"
                href={`${TAILNET_LOGIN_ROUTE}?resume=1`}
                style={linkButtonStyle}
              >
                Continue as {tailnetLogin}
              </a>
            )}
            {passkey ? (
              <>
                {passkey.onRpHost && tailnetLogin && (
                  <>
                    <button
                      type="button"
                      data-testid="passkey-sign-in"
                      onClick={() => void handlePasskey()}
                      disabled={busy}
                      style={{ ...primaryButtonStyle, marginBottom: 12 }}
                    >
                      Sign in with passkey
                    </button>
                    {offerTrust && trustCheckbox}
                  </>
                )}
                {passkey.onRpHost && !tailnetLogin && (
                  <p data-testid="passkey-needs-tailnet" style={{ ...labelStyle, margin: "0 0 12px 0" }}>
                    {PASSKEY_NEEDS_TAILNET_MESSAGE}
                  </p>
                )}
                {!passkey.onRpHost && (
                  <a data-testid="passkey-elsewhere" href={`https://${passkey.rpId}/`} style={linkButtonStyle}>
                    Sign in at https://{passkey.rpId}
                  </a>
                )}
                <div role={error ? "alert" : undefined} style={errorStyle}>{error}</div>
                {!breakGlassOpen ? (
                  <button type="button" data-testid="break-glass-toggle" onClick={() => setBreakGlassOpen(true)} style={quietLinkStyle}>
                    Use a break-glass code
                  </button>
                ) : (
                  <form data-testid="break-glass-form" onSubmit={handleSubmit}>
                    {identifierField}
                    <label htmlFor="login-break-glass" style={labelStyle}>Break-glass code</label>
                    <input
                      type="text"
                      name="password"
                      id="login-break-glass"
                      autoComplete="one-time-code"
                      autoCapitalize="characters"
                      spellCheck={false}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      style={{ ...fieldStyle, marginTop: 4, marginBottom: 14 }}
                    />
                    <button type="submit" style={primaryButtonStyle}>Sign in</button>
                  </form>
                )}
              </>
            ) : (
              <form onSubmit={handleSubmit}>
                {identifierField}
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
                {offerTrust && trustCheckbox}
                <div role={error ? "alert" : undefined} style={errorStyle}>
                  {error}
                </div>
                <button type="submit" style={primaryButtonStyle}>
                  Sign in
                </button>
              </form>
            )}
          </>
        )}
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
export default function LoginPageClient(props: LoginPageClientProps) {
  return (
    <StarfieldProvider initialVariant={DEFAULT_STARFIELD_VARIANT}>
      <LoginForm {...props} />
    </StarfieldProvider>
  );
}
