import { describe, it, expect } from "vitest";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  REFRESH_COOKIE_MAX_AGE_SECONDS_DEFAULT,
  REFRESH_COOKIE_MAX_AGE_SECONDS_REMEMBERED,
  SESSION_EXPIRES_AT_COOKIE,
  SESSION_LAST_ACTIVE_COOKIE,
  SESSION_POLICY_COOKIE,
  applySessionCookies,
  clearSessionCookies,
  decodeJwtExpiryMs,
  parseSessionPolicy,
  stampLastActive,
} from "./session-cookies";

// Shared cookie-setting logic used by the login, refresh, and logout routes
// (D2, batch 04): kept in one place so the three routes' cookie shape never
// drifts from each other. Exercised here against a minimal fake cookie jar
// that mirrors the subset of next/headers' RequestCookies API these routes
// actually call (.set/.get/.delete) -- there's no route-handler test idiom
// in this repo yet (task-4-brief correction #3), so this is a thin unit
// test around real logic, not a mock of Next internals.

interface StoredCookie {
  value: string;
  options?: Record<string, unknown>;
}

function makeFakeCookieJar() {
  const store = new Map<string, StoredCookie>();
  return {
    set(name: string, value: string, options?: Record<string, unknown>) {
      store.set(name, { value, options });
    },
    get(name: string) {
      const entry = store.get(name);
      return entry ? { name, value: entry.value } : undefined;
    },
    delete(name: string) {
      store.delete(name);
    },
    _store: store,
  };
}

// A syntactically valid (unsigned test fixture, not a real backend token)
// JWT: header.payload.signature, base64url-encoded, payload {"exp": <secs>}.
function makeJwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "1", exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("decodeJwtExpiryMs", () => {
  it("reads exp (seconds) off the payload and returns it in milliseconds", () => {
    const token = makeJwtWithExp(1_700_000_000);
    expect(decodeJwtExpiryMs(token)).toBe(1_700_000_000_000);
  });

  it("returns null for a token with no exp claim", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "1" })).toString("base64url");
    expect(decodeJwtExpiryMs(`${header}.${payload}.sig`)).toBeNull();
  });

  it("returns null for a malformed token (not three dot-separated segments)", () => {
    expect(decodeJwtExpiryMs("not-a-jwt")).toBeNull();
  });

  it("returns null for a payload segment that isn't valid base64url JSON", () => {
    expect(decodeJwtExpiryMs("header.%%%not-base64%%%.sig")).toBeNull();
  });

  it("never throws on garbage input", () => {
    expect(() => decodeJwtExpiryMs("")).not.toThrow();
    expect(decodeJwtExpiryMs("")).toBeNull();
  });
});

describe("applySessionCookies", () => {
  it("sets access_token and refresh_token as httpOnly", () => {
    const jar = makeFakeCookieJar();
    applySessionCookies(jar as never, { accessToken: "access-abc", refreshToken: "refresh-xyz" });

    expect(jar.get(ACCESS_TOKEN_COOKIE)?.value).toBe("access-abc");
    expect(jar._store.get(ACCESS_TOKEN_COOKIE)?.options).toMatchObject({ httpOnly: true });
    expect(jar.get(REFRESH_TOKEN_COOKIE)?.value).toBe("refresh-xyz");
    expect(jar._store.get(REFRESH_TOKEN_COOKIE)?.options).toMatchObject({ httpOnly: true });
  });

  it("decodes the access token's exp and sets a readable (non-httpOnly) session_expires_at cookie", () => {
    const jar = makeFakeCookieJar();
    const token = makeJwtWithExp(1_700_000_000);

    applySessionCookies(jar as never, { accessToken: token, refreshToken: "refresh-xyz" });

    expect(jar.get(SESSION_EXPIRES_AT_COOKIE)?.value).toBe("1700000000000");
    expect(jar._store.get(SESSION_EXPIRES_AT_COOKIE)?.options).toMatchObject({ httpOnly: false });
  });

  it("clears any stale session_expires_at cookie when the access token has no readable exp", () => {
    const jar = makeFakeCookieJar();
    jar.set(SESSION_EXPIRES_AT_COOKIE, "stale-value");

    applySessionCookies(jar as never, { accessToken: "not-a-jwt", refreshToken: "refresh-xyz" });

    expect(jar.get(SESSION_EXPIRES_AT_COOKIE)).toBeUndefined();
  });

  // D5 (batch 04 auth/session parity): view-as/return-to-admin responses
  // deliberately omit refresh_token (the backend never renews it for an
  // acting-as-demo session -- rotation would resurrect the admin identity
  // past the acting token's 60-min cap). Those two routes must still be
  // able to swap the access token without forking a second cookie writer,
  // so refreshToken becomes optional here rather than required.
  it("sets only access_token + session_expires_at, and does NOT call set() for refresh_token, when refreshToken is omitted", () => {
    const jar = makeFakeCookieJar();
    const token = makeJwtWithExp(1_700_000_000);

    applySessionCookies(jar as never, { accessToken: token });

    expect(jar.get(ACCESS_TOKEN_COOKIE)?.value).toBe(token);
    expect(jar.get(SESSION_EXPIRES_AT_COOKIE)?.value).toBe("1700000000000");
    expect(jar._store.has(REFRESH_TOKEN_COOKIE)).toBe(false);
  });

  it("preserves an existing refresh_token cookie untouched when refreshToken is omitted", () => {
    const jar = makeFakeCookieJar();
    jar.set(REFRESH_TOKEN_COOKIE, "admins-existing-refresh", { httpOnly: true });

    applySessionCookies(jar as never, { accessToken: makeJwtWithExp(1_700_000_000) });

    expect(jar.get(REFRESH_TOKEN_COOKIE)?.value).toBe("admins-existing-refresh");
  });
});

describe("applySessionCookies -- session_policy (D1/D2)", () => {
  // applySessionCookies gains an optional `policy` field (an already-parsed
  // SessionPolicy, camelCase) that sets the readable session_policy cookie.
  // Omitted entirely (not just falsy) is the rollout-backward-compat case --
  // see the field's own doc comment.
  it("sets the session_policy cookie (camelCase JSON, non-httpOnly, 90-day maxAge) when policy is given", () => {
    const jar = makeFakeCookieJar();
    const policy = { idleMinutes: 60, resume: true, remembered: false };

    applySessionCookies(jar as never, { accessToken: makeJwtWithExp(1_700_000_000), refreshToken: "r", policy });

    expect(jar.get(SESSION_POLICY_COOKIE)?.value).toBe(JSON.stringify(policy));
    expect(jar._store.get(SESSION_POLICY_COOKIE)?.options).toMatchObject({
      httpOnly: false,
      maxAge: 90 * 24 * 60 * 60,
    });
  });

  it("does NOT touch the session_policy cookie when policy is omitted (rollout backward-compat)", () => {
    const jar = makeFakeCookieJar();
    jar.set(SESSION_POLICY_COOKIE, "pre-existing", { httpOnly: false });

    applySessionCookies(jar as never, { accessToken: makeJwtWithExp(1_700_000_000), refreshToken: "r" });

    expect(jar.get(SESSION_POLICY_COOKIE)?.value).toBe("pre-existing");
  });
});

describe("applySessionCookies -- refresh_token retention (review fix item 1)", () => {
  // Item 1 (session-expiry-tuning review fixes): refresh_token used to be
  // browser-session-scoped (no maxAge) unconditionally, so a "remembered"
  // session (90-day backend refresh token) still died the moment the
  // browser was closed. When a policy is present, the cookie's maxAge now
  // mirrors the backend's own lifetime for that (role, remembered) row --
  // this is retention only, not enforcement (see the constants' doc
  // comment on session-cookies.ts); the backend's stored expiry remains
  // the authority exactly like every other cookie in this module.
  it("sets refresh_token maxAge to the remembered lifetime (90d) when policy.remembered is true", () => {
    const jar = makeFakeCookieJar();
    const policy = { idleMinutes: 0, resume: true, remembered: true };

    applySessionCookies(jar as never, { accessToken: makeJwtWithExp(1_700_000_000), refreshToken: "r", policy });

    expect(jar._store.get(REFRESH_TOKEN_COOKIE)?.options).toMatchObject({
      httpOnly: true,
      maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS_REMEMBERED,
    });
    expect(REFRESH_COOKIE_MAX_AGE_SECONDS_REMEMBERED).toBe(90 * 24 * 3600);
  });

  it("sets refresh_token maxAge to the default lifetime (7d) when policy.remembered is false", () => {
    const jar = makeFakeCookieJar();
    const policy = { idleMinutes: 60, resume: true, remembered: false };

    applySessionCookies(jar as never, { accessToken: makeJwtWithExp(1_700_000_000), refreshToken: "r", policy });

    expect(jar._store.get(REFRESH_TOKEN_COOKIE)?.options).toMatchObject({
      httpOnly: true,
      maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS_DEFAULT,
    });
    expect(REFRESH_COOKIE_MAX_AGE_SECONDS_DEFAULT).toBe(7 * 24 * 3600);
  });

  it("does not set a refresh_token maxAge when no policy is given (unchanged: browser-session-scoped)", () => {
    const jar = makeFakeCookieJar();

    applySessionCookies(jar as never, { accessToken: makeJwtWithExp(1_700_000_000), refreshToken: "r" });

    expect(jar._store.get(REFRESH_TOKEN_COOKIE)?.options).not.toHaveProperty("maxAge");
  });
});

describe("stampLastActive (review fix item 3)", () => {
  // Item 3 (session-expiry-tuning review fixes): login is genuine activity
  // -- the login route sets session_last_active to "now" instead of
  // deleting it, via this shared helper, so the cookie attributes stay in
  // one place alongside the rest of this module's cookie-shape logic.
  it("sets session_last_active to the given epoch-ms timestamp, non-httpOnly with a 90-day maxAge", () => {
    const jar = makeFakeCookieJar();

    stampLastActive(jar as never, 1_700_000_000_000);

    expect(jar.get(SESSION_LAST_ACTIVE_COOKIE)?.value).toBe("1700000000000");
    expect(jar._store.get(SESSION_LAST_ACTIVE_COOKIE)?.options).toMatchObject({
      httpOnly: false,
      maxAge: 90 * 24 * 60 * 60,
    });
  });
});

describe("parseSessionPolicy", () => {
  it("accepts the backend's snake_case session_policy body and normalizes it to camelCase", () => {
    expect(parseSessionPolicy({ idle_minutes: 60, resume: true, remembered: false })).toEqual({
      idleMinutes: 60,
      resume: true,
      remembered: false,
    });
  });

  it("accepts idle_minutes: 0 (never idle out -- remembered device row)", () => {
    expect(parseSessionPolicy({ idle_minutes: 0, resume: true, remembered: true })).toEqual({
      idleMinutes: 0,
      resume: true,
      remembered: true,
    });
  });

  it("rejects undefined (missing session_policy -- rollout backward-compat)", () => {
    expect(parseSessionPolicy(undefined)).toBeNull();
  });

  it("rejects null", () => {
    expect(parseSessionPolicy(null)).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(parseSessionPolicy("nope")).toBeNull();
  });

  it("rejects a body missing a required field", () => {
    expect(parseSessionPolicy({ idle_minutes: 60, resume: true })).toBeNull();
  });

  it("rejects a body with the wrong field types", () => {
    expect(parseSessionPolicy({ idle_minutes: "60", resume: true, remembered: false })).toBeNull();
    expect(parseSessionPolicy({ idle_minutes: 60, resume: "true", remembered: false })).toBeNull();
  });

  it("rejects a negative idle_minutes", () => {
    expect(parseSessionPolicy({ idle_minutes: -1, resume: true, remembered: false })).toBeNull();
  });

  it("ignores extra/unknown fields on the backend body", () => {
    expect(
      parseSessionPolicy({ idle_minutes: 60, resume: true, remembered: false, extra: "ignored" })
    ).toEqual({ idleMinutes: 60, resume: true, remembered: false });
  });
});

describe("clearSessionCookies", () => {
  it("deletes all five session cookies", () => {
    const jar = makeFakeCookieJar();
    jar.set(ACCESS_TOKEN_COOKIE, "a");
    jar.set(REFRESH_TOKEN_COOKIE, "r");
    jar.set(SESSION_EXPIRES_AT_COOKIE, "123");
    jar.set(SESSION_POLICY_COOKIE, "{}");
    jar.set(SESSION_LAST_ACTIVE_COOKIE, "456");

    clearSessionCookies(jar as never);

    expect(jar.get(ACCESS_TOKEN_COOKIE)).toBeUndefined();
    expect(jar.get(REFRESH_TOKEN_COOKIE)).toBeUndefined();
    expect(jar.get(SESSION_EXPIRES_AT_COOKIE)).toBeUndefined();
    expect(jar.get(SESSION_POLICY_COOKIE)).toBeUndefined();
    expect(jar.get(SESSION_LAST_ACTIVE_COOKIE)).toBeUndefined();
  });
});
