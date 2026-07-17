import { describe, it, expect } from "vitest";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SESSION_EXPIRES_AT_COOKIE,
  applySessionCookies,
  clearSessionCookies,
  decodeJwtExpiryMs,
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
    applySessionCookies(jar, { accessToken: "access-abc", refreshToken: "refresh-xyz" });

    expect(jar.get(ACCESS_TOKEN_COOKIE)?.value).toBe("access-abc");
    expect(jar._store.get(ACCESS_TOKEN_COOKIE)?.options).toMatchObject({ httpOnly: true });
    expect(jar.get(REFRESH_TOKEN_COOKIE)?.value).toBe("refresh-xyz");
    expect(jar._store.get(REFRESH_TOKEN_COOKIE)?.options).toMatchObject({ httpOnly: true });
  });

  it("decodes the access token's exp and sets a readable (non-httpOnly) session_expires_at cookie", () => {
    const jar = makeFakeCookieJar();
    const token = makeJwtWithExp(1_700_000_000);

    applySessionCookies(jar, { accessToken: token, refreshToken: "refresh-xyz" });

    expect(jar.get(SESSION_EXPIRES_AT_COOKIE)?.value).toBe("1700000000000");
    expect(jar._store.get(SESSION_EXPIRES_AT_COOKIE)?.options).toMatchObject({ httpOnly: false });
  });

  it("clears any stale session_expires_at cookie when the access token has no readable exp", () => {
    const jar = makeFakeCookieJar();
    jar.set(SESSION_EXPIRES_AT_COOKIE, "stale-value");

    applySessionCookies(jar, { accessToken: "not-a-jwt", refreshToken: "refresh-xyz" });

    expect(jar.get(SESSION_EXPIRES_AT_COOKIE)).toBeUndefined();
  });
});

describe("clearSessionCookies", () => {
  it("deletes all three session cookies", () => {
    const jar = makeFakeCookieJar();
    jar.set(ACCESS_TOKEN_COOKIE, "a");
    jar.set(REFRESH_TOKEN_COOKIE, "r");
    jar.set(SESSION_EXPIRES_AT_COOKIE, "123");

    clearSessionCookies(jar);

    expect(jar.get(ACCESS_TOKEN_COOKIE)).toBeUndefined();
    expect(jar.get(REFRESH_TOKEN_COOKIE)).toBeUndefined();
    expect(jar.get(SESSION_EXPIRES_AT_COOKIE)).toBeUndefined();
  });
});
