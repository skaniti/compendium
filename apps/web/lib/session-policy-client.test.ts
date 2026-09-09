import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetThrottleForTests,
  effectiveIdleMinutes,
  readLastActiveMs,
  readSessionPolicy,
  sessionMayResume,
  writeLastActiveMs,
} from "./session-policy-client";

// D2/D3 (session-expiry-tuning): client-side reads/writes for the
// session_policy / session_last_active cookies lib/session-cookies.ts's
// applySessionCookies/clearSessionCookies own server-side. session_policy
// here is ALREADY the camelCase shape that module writes into the cookie
// (not the backend's raw snake_case body -- that normalization happens
// once, server-side, via parseSessionPolicy).

function clearCookies() {
  document.cookie = "session_policy=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  document.cookie = "session_last_active=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  document.cookie = "session_expires_at=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

function setPolicyCookie(policy: unknown) {
  document.cookie = `session_policy=${encodeURIComponent(JSON.stringify(policy))}; path=/`;
}

function setLastActiveCookie(raw: string) {
  document.cookie = `session_last_active=${raw}; path=/`;
}

function setExpiresAtCookie(epochMs: number) {
  document.cookie = `session_expires_at=${epochMs}; path=/`;
}

describe("readSessionPolicy", () => {
  afterEach(clearCookies);

  it("returns null when the cookie is absent", () => {
    expect(readSessionPolicy()).toBeNull();
  });

  it("reads and validates a well-formed camelCase policy cookie", () => {
    setPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    expect(readSessionPolicy()).toEqual({ idleMinutes: 60, resume: true, remembered: false });
  });

  it("returns null for malformed JSON", () => {
    document.cookie = `session_policy=not-json; path=/`;
    expect(readSessionPolicy()).toBeNull();
  });

  it("returns null for well-formed JSON that doesn't match the SessionPolicy shape", () => {
    setPolicyCookie({ foo: "bar" });
    expect(readSessionPolicy()).toBeNull();
  });
});

describe("readLastActiveMs", () => {
  afterEach(clearCookies);

  it("returns null when the cookie is absent", () => {
    expect(readLastActiveMs()).toBeNull();
  });

  it("reads a numeric epoch-ms value", () => {
    setLastActiveCookie("1700000000000");
    expect(readLastActiveMs()).toBe(1_700_000_000_000);
  });

  it("returns null for a non-numeric value", () => {
    setLastActiveCookie("not-a-number");
    expect(readLastActiveMs()).toBeNull();
  });
});

describe("writeLastActiveMs", () => {
  const base = 1_700_000_000_000;

  // The throttle's "last write" state lives at MODULE scope in
  // session-policy-client.ts (deliberately -- it needs to survive across
  // the many activity events a real page session generates, not reset
  // every call), which means it also survives across `it()` blocks in this
  // file. Resetting it explicitly here (rather than relying on every test
  // picking a timestamp far enough from every other test's) is the robust
  // fix -- see __resetThrottleForTests' own doc comment.
  beforeEach(() => {
    __resetThrottleForTests();
  });

  afterEach(() => {
    clearCookies();
    vi.useRealTimers();
  });

  it("writes the session_last_active cookie with the given epoch ms", () => {
    writeLastActiveMs(base);
    expect(readLastActiveMs()).toBe(base);
  });

  it("throttles: a second write within 30s of the first is dropped", () => {
    writeLastActiveMs(base);
    writeLastActiveMs(base + 10_000); // 10s later -- inside the 30s throttle window
    expect(readLastActiveMs()).toBe(base);
  });

  it("writes again once 30s have passed since the last write", () => {
    writeLastActiveMs(base);
    writeLastActiveMs(base + 30_001);
    expect(readLastActiveMs()).toBe(base + 30_001);
  });

  it("force:true bypasses the throttle even immediately after a prior write", () => {
    writeLastActiveMs(base);
    writeLastActiveMs(base + 1_000, { force: true });
    expect(readLastActiveMs()).toBe(base + 1_000);
  });
});

// Item 1 (session-expiry-tuning review fixes): idle lapse must be FINAL --
// once a session has genuinely lapsed (expired token + a persisted
// last-active already outside the policy's idle window), writeLastActiveMs
// must refuse to overwrite session_last_active, or the very next
// pointerdown/keydown would silently revive it (the batch-04 resurrection
// bug, this time surviving a reload since D2 persists last-active across
// them). SessionKeeper.test.tsx's "D2 finality" test is the component-level
// analog of this.
describe("writeLastActiveMs -- refuses to write once a session has lapsed (D2 finality)", () => {
  beforeEach(() => {
    __resetThrottleForTests();
  });

  afterEach(() => {
    clearCookies();
  });

  it("refuses the write when lapsed: expired token + stored last-active already beyond idleMinutes", () => {
    const now = Date.now();
    setPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    setExpiresAtCookie(now - 1_000); // expired
    const staleLastActive = now - 61 * 60_000; // 61min ago -- already past the 60min window
    setLastActiveCookie(String(staleLastActive));

    writeLastActiveMs(now);

    expect(readLastActiveMs()).toBe(staleLastActive); // unchanged
  });

  it("writes normally when the token has not expired yet, even with a stale stored last-active", () => {
    const now = Date.now();
    setPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    setExpiresAtCookie(now + 60_000); // not expired
    setLastActiveCookie(String(now - 61 * 60_000));

    writeLastActiveMs(now);

    expect(readLastActiveMs()).toBe(now);
  });

  it("writes normally when idleMinutes is 0 (remembered device), even with an expired token and long-stale last-active", () => {
    const now = Date.now();
    setPolicyCookie({ idleMinutes: 0, resume: true, remembered: true });
    setExpiresAtCookie(now - 1_000);
    setLastActiveCookie(String(now - 999_999_999));

    writeLastActiveMs(now);

    expect(readLastActiveMs()).toBe(now);
  });

  it("writes normally when there is no stored last-active cookie yet, even with an expired token", () => {
    const now = Date.now();
    setPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    setExpiresAtCookie(now - 1_000);

    writeLastActiveMs(now);

    expect(readLastActiveMs()).toBe(now);
  });

  it("writes normally when there is no session_expires_at cookie at all (dev no-auth mode)", () => {
    const now = Date.now();
    setPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    setLastActiveCookie(String(now - 61 * 60_000));

    writeLastActiveMs(now);

    expect(readLastActiveMs()).toBe(now);
  });

  it("writes normally when there is no policy cookie at all", () => {
    const now = Date.now();
    setExpiresAtCookie(now - 1_000);
    setLastActiveCookie(String(now - 999_999_999));

    writeLastActiveMs(now);

    expect(readLastActiveMs()).toBe(now);
  });
});

describe("sessionMayResume", () => {
  afterEach(clearCookies);

  it("is false with no policy cookie at all", () => {
    expect(sessionMayResume(Date.now())).toBe(false);
  });

  it("is false when policy.resume is false (e.g. an acting-as-demo session)", () => {
    setPolicyCookie({ idleMinutes: 60, resume: false, remembered: false });
    setLastActiveCookie(String(Date.now()));
    expect(sessionMayResume(Date.now())).toBe(false);
  });

  it("is true when idleMinutes is 0, regardless of how old (or absent) last-active is", () => {
    setPolicyCookie({ idleMinutes: 0, resume: true, remembered: true });
    expect(sessionMayResume(Date.now())).toBe(true);

    setLastActiveCookie(String(Date.now() - 999_999_999));
    expect(sessionMayResume(Date.now())).toBe(true);
  });

  it("is true when no last-active cookie exists yet (first visit after upgrade)", () => {
    setPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    expect(sessionMayResume(Date.now())).toBe(true);
  });

  it("is true when now - lastActive is within idleMinutes", () => {
    const now = Date.now();
    setPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    setLastActiveCookie(String(now - 5 * 60_000));
    expect(sessionMayResume(now)).toBe(true);
  });

  it("is false when now - lastActive exceeds idleMinutes", () => {
    const now = Date.now();
    setPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    setLastActiveCookie(String(now - 61 * 60_000));
    expect(sessionMayResume(now)).toBe(false);
  });
});

describe("effectiveIdleMinutes", () => {
  const original = process.env.NEXT_PUBLIC_IDLE_MINUTES;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_IDLE_MINUTES;
    else process.env.NEXT_PUBLIC_IDLE_MINUTES = original;
  });

  it("returns the policy's own idleMinutes when a policy exists", () => {
    expect(effectiveIdleMinutes({ idleMinutes: 720, resume: true, remembered: false })).toBe(720);
  });

  it("returns 0 (never idle out) verbatim when the policy says so", () => {
    expect(effectiveIdleMinutes({ idleMinutes: 0, resume: true, remembered: true })).toBe(0);
  });

  it("falls back to NEXT_PUBLIC_IDLE_MINUTES when there is no policy", () => {
    process.env.NEXT_PUBLIC_IDLE_MINUTES = "45";
    expect(effectiveIdleMinutes(null)).toBe(45);
  });

  it("falls back to the 60-minute default when there is no policy and no env override", () => {
    delete process.env.NEXT_PUBLIC_IDLE_MINUTES;
    expect(effectiveIdleMinutes(null)).toBe(60);
  });

  it("falls back to the 60-minute default when the env override is not a positive number", () => {
    process.env.NEXT_PUBLIC_IDLE_MINUTES = "not-a-number";
    expect(effectiveIdleMinutes(null)).toBe(60);
  });
});
