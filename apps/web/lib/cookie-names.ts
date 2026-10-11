// owner-passkeys R12 (2026-10-11): the owner app shares its registrable
// site with the public demo, so in production every auth cookie carries the
// __Host- prefix. A browser stores such a cookie only when it is Secure, has
// Path=/ and no Domain, so no other name on the site can plant or overwrite
// it. Development keeps plain names: the dev stack is plain http on the
// tailnet address, where browsers drop __Host- cookies (they are not
// Secure). NODE_ENV is the switch that already sets `secure` on these
// cookies, and Next inlines it into client bundles too.
export const AUTH_COOKIE_PREFIX: "" | "__Host-" = process.env.NODE_ENV === "production" ? "__Host-" : "";

export function authCookieName(base: string): string {
  return `${AUTH_COOKIE_PREFIX}${base}`;
}

export const ACCESS_TOKEN_COOKIE = authCookieName("access_token");
export const REFRESH_TOKEN_COOKIE = authCookieName("refresh_token");
export const SESSION_EXPIRES_AT_COOKIE = authCookieName("session_expires_at");
export const SESSION_POLICY_COOKIE = authCookieName("session_policy");
export const SESSION_LAST_ACTIVE_COOKIE = authCookieName("session_last_active");
export const TRUSTED_BROWSER_COOKIE = authCookieName("trusted_browser");
export const TAILNET_PAUSED_COOKIE = authCookieName("tailnet_login_paused");

// The names from before the prefix (clean break, spec D8): ignored, and
// deleted on sign-in and sign-out in production so they do not linger.
export const LEGACY_AUTH_COOKIE_NAMES = [
  "access_token",
  "refresh_token",
  "session_expires_at",
  "session_policy",
  "session_last_active",
  "trusted_browser",
  "tailnet_login_paused",
] as const;
