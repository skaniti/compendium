"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { passkeyErrorMessage, runPasskeyRegistration } from "@/lib/passkey-client";
import { ENROLL_LINK_UNUSABLE_MESSAGE, PASSKEY_SETUP_FAILED_MESSAGE } from "@/lib/login-messages";

const cardStyle: CSSProperties = {
  maxWidth: 360,
  margin: "15vh auto 0",
  padding: "32px 28px",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 10,
};
const buttonStyle: CSSProperties = {
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
const noteStyle: CSSProperties = { fontSize: "0.85rem", color: "var(--subtle, #777)" };

export default function EnrollClient({ ready }: { ready: boolean }) {
  // undefined = fragment not read yet; null = no token in the link.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [trust, setTrust] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const raw = window.location.hash.slice(1);
    // Idempotent: Strict Mode runs this twice and the second read sees the
    // already-cleared hash, so never overwrite a token that was read.
    setToken((prev) => raw || (prev ?? null));
    // Drop the one-time token from the address bar and history.
    if (raw) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function enroll() {
    if (!token) return;
    setError("");
    setBusy(true);
    try {
      const optionsRes = await fetch("/api/auth/passkey/enroll/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const optionsData = (await optionsRes.json().catch(() => ({}))) as { options?: unknown; error?: string };
      if (!optionsRes.ok || !optionsData.options) {
        setError(optionsData.error || PASSKEY_SETUP_FAILED_MESSAGE);
        return;
      }
      let response: unknown;
      try {
        response = await runPasskeyRegistration(optionsData.options as never);
      } catch (err) {
        setError(passkeyErrorMessage(err, "enroll"));
        return;
      }
      const verifyRes = await fetch("/api/auth/passkey/enroll/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, response, trustBrowser: trust }),
      });
      if (verifyRes.ok) {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload required after login
        window.location.href = "/";
        return;
      }
      const data = (await verifyRes.json().catch(() => ({}))) as { error?: string };
      setError(data.error || PASSKEY_SETUP_FAILED_MESSAGE);
    } catch {
      setError(PASSKEY_SETUP_FAILED_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  if (token === undefined) return <div style={cardStyle} />;
  if (!ready || token === null) {
    return (
      <div style={cardStyle}>
        <p data-testid="enroll-error" role="alert" style={noteStyle}>{ENROLL_LINK_UNUSABLE_MESSAGE}</p>
      </div>
    );
  }
  return (
    <div style={cardStyle}>
      <h1 style={{ fontFamily: "Georgia, serif", fontSize: "1.6rem", margin: "0 0 12px 0" }}>Set up a passkey</h1>
      <p style={noteStyle}>Save the passkey in your password manager when the browser asks.</p>
      <label htmlFor="enroll-trust" style={{ ...noteStyle, display: "flex", gap: 6, alignItems: "center", margin: "12px 0" }}>
        <input type="checkbox" id="enroll-trust" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
        Trust this browser for automatic sign-in
      </label>
      <div role={error ? "alert" : undefined} style={{ color: "#c0392b", fontSize: "0.8rem", minHeight: 20, marginBottom: 12 }}>
        {error}
      </div>
      <button type="button" data-testid="enroll-create" onClick={() => void enroll()} disabled={busy} style={buttonStyle}>
        Create passkey
      </button>
    </div>
  );
}
