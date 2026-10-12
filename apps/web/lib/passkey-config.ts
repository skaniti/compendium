import { tailnetLoginEnabled, type HeaderReader } from "@/lib/tailnet-login";

// owner-passkeys (2026-10-11): passkeys are on only where WEBAUTHN_RP_ID is
// set (the owner stack), on top of the tailnet login. A passkey works only
// on the relying-party host, so another name (the ts.net fallback) shows a
// link to it instead of the passkey button.
export function passkeyRpId(): string | null {
  const value = (process.env.WEBAUTHN_RP_ID ?? "").trim().toLowerCase();
  return value ? value : null;
}

export function passkeysEnabled(): boolean {
  return passkeyRpId() !== null && tailnetLoginEnabled();
}

// The request's host name without its port, lower-cased. Falls back to the
// URL when there is no Host header (route handler tests).
export function requestHostName(headers: HeaderReader, url?: string): string | null {
  let raw = headers.get("host")?.trim().toLowerCase() ?? "";
  if (!raw && url) {
    try {
      raw = new URL(url).host.toLowerCase();
    } catch {
      raw = "";
    }
  }
  if (!raw) return null;
  if (raw.startsWith("[")) return raw.slice(0, raw.indexOf("]") + 1);
  return raw.replace(/:\d+$/, "");
}

export function onPasskeyHost(headers: HeaderReader, url?: string): boolean {
  const rp = passkeyRpId();
  return rp !== null && requestHostName(headers, url) === rp;
}
