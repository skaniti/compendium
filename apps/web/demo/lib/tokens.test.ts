// Task 5: stub auth token minting + decode-only parsing. Structural checks
// only -- these tokens are deliberately unsigned ("demosig" literal third
// segment), matching lib/session-cookies.ts's own decode-without-verify
// contract on the frontend (see tokens.mjs module header).
import { describe, expect, it } from "vitest";
import { bearerFromRequest, decodeToken, mintToken } from "./tokens.mjs";

function decodeSegment(b64u: string): unknown {
  return JSON.parse(Buffer.from(b64u, "base64url").toString("utf8"));
}

describe("mintToken", () => {
  it("mints a 3-part jwt with numeric exp seconds", () => {
    const beforeSec = Math.floor(Date.now() / 1000);
    const token = mintToken({ id: 1, email: "admin@demo.local", role: "admin" });
    const parts = token.split(".");
    expect(parts.length).toBe(3);
    const header = decodeSegment(parts[0]) as { alg: string; typ: string };
    expect(header.alg).toBe("none");
    expect(header.typ).toBe("JWT");
    const payload = decodeSegment(parts[1]) as { exp: number; iat: number };
    expect(typeof payload.exp).toBe("number");
    expect(Number.isFinite(payload.exp)).toBe(true);
    // Seconds, not milliseconds -- bounded relative to "now" (captured just
    // before minting) plus the default 3600s ttl, with a few seconds' test-
    // execution slack. A hardcoded future cutoff (the previous
    // `< 2_000_000_000` bound) itself goes stale: it false-fails once the
    // wall clock passes 2033-05-18, since a legitimate ms-free exp would
    // then also exceed it. A 13-digit epoch-ms value would blow this much
    // tighter window by many orders of magnitude, so the "seconds, not ms"
    // property is still exactly what's being asserted.
    expect(payload.exp).toBeGreaterThanOrEqual(beforeSec);
    expect(payload.exp).toBeLessThan(beforeSec + 3600 + 5);
    expect(parts[2]).toBe("demosig");
  });

  it("embeds sub/email/role from the given user", () => {
    const token = mintToken({ id: 42, email: "demo@demo.local", role: "demo" });
    const payload = decodeSegment(token.split(".")[1]) as { sub: string; email: string; role: string };
    expect(payload.sub).toBe("42");
    expect(payload.email).toBe("demo@demo.local");
    expect(payload.role).toBe("demo");
  });

  it("omits acting_as_demo entirely when not acting", () => {
    const token = mintToken({ id: 1, email: "demo@demo.local", role: "demo" });
    const payload = decodeSegment(token.split(".")[1]) as Record<string, unknown>;
    expect("acting_as_demo" in payload).toBe(false);
  });

  it("sets acting_as_demo: true when actingAsDemo is passed", () => {
    const token = mintToken({ id: 1, email: "demo@demo.local", role: "demo" }, { actingAsDemo: true });
    const payload = decodeSegment(token.split(".")[1]) as { acting_as_demo: boolean };
    expect(payload.acting_as_demo).toBe(true);
  });

  it("defaults ttlSec to 3600 (exp - iat)", () => {
    const token = mintToken({ id: 1, email: "admin@demo.local", role: "admin" });
    const payload = decodeSegment(token.split(".")[1]) as { iat: number; exp: number };
    expect(payload.exp - payload.iat).toBe(3600);
  });

  it("honors a custom ttlSec", () => {
    const token = mintToken({ id: 1, email: "admin@demo.local", role: "admin" }, { ttlSec: 120 });
    const payload = decodeSegment(token.split(".")[1]) as { iat: number; exp: number };
    expect(payload.exp - payload.iat).toBe(120);
  });

  it("mints structurally distinct tokens on successive calls (rotation depends on this)", () => {
    const user = { id: 1, email: "admin@demo.local", role: "admin" };
    const a = mintToken(user);
    const b = mintToken(user);
    expect(a).not.toBe(b);
  });
});

describe("decodeToken", () => {
  it("round-trips a token minted by mintToken", () => {
    const token = mintToken({ id: 7, email: "demo@demo.local", role: "demo" }, { actingAsDemo: true });
    const payload = decodeToken(token) as { sub: string; role: string; acting_as_demo: boolean };
    expect(payload.sub).toBe("7");
    expect(payload.role).toBe("demo");
    expect(payload.acting_as_demo).toBe(true);
  });

  it("returns null for a token with the wrong number of parts", () => {
    expect(decodeToken("not-a-jwt")).toBeNull();
    expect(decodeToken("a.b")).toBeNull();
  });

  it("returns null for a non-base64/non-JSON middle segment", () => {
    expect(decodeToken("a.!!!not-valid-base64url!!!.c")).toBeNull();
  });

  it("returns null for non-string input (undefined/null/garbage)", () => {
    expect(decodeToken(undefined)).toBeNull();
    expect(decodeToken(null)).toBeNull();
    expect(decodeToken(12345)).toBeNull();
  });
});

describe("bearerFromRequest", () => {
  it("extracts the token from a well-formed Authorization header", () => {
    const token = mintToken({ id: 1, email: "admin@demo.local", role: "admin" });
    const req = { headers: { authorization: `Bearer ${token}` } };
    expect(bearerFromRequest(req)).toBe(token);
  });

  it("is case-insensitive on the Bearer scheme", () => {
    const req = { headers: { authorization: "bearer sometoken" } };
    expect(bearerFromRequest(req)).toBe("sometoken");
  });

  it("returns null when there is no Authorization header", () => {
    expect(bearerFromRequest({ headers: {} })).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(bearerFromRequest({ headers: { authorization: "Basic dXNlcjpwYXNz" } })).toBeNull();
  });
});
