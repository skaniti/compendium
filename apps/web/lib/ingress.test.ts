import { describe, expect, it } from "vitest";
import { INGRESS_HEADER, ingressHeaders } from "./ingress";

// D1/D4/D6 (session-expiry-tuning, 2026-09-10 amendment): apps/web relays
// the X-Compendium-Ingress header Caddy sets at the edge; it never sets or
// invents a value. These pin the two forwarding cases the four auth routes
// depend on (login/refresh/view-as/return route tests each build on this).

describe("ingressHeaders", () => {
  it("forwards the header when the inbound request carries it", () => {
    const req = new Request("http://localhost/api/auth/login", {
      headers: { [INGRESS_HEADER]: "tailnet" },
    });

    expect(ingressHeaders(req)).toEqual({ [INGRESS_HEADER]: "tailnet" });
  });

  it("forwards whatever value is present, without validating it (the API decides trust, not this helper)", () => {
    const req = new Request("http://localhost/api/auth/login", {
      headers: { [INGRESS_HEADER]: "public" },
    });

    expect(ingressHeaders(req)).toEqual({ [INGRESS_HEADER]: "public" });
  });

  it("returns {} when the inbound request has no ingress header", () => {
    const req = new Request("http://localhost/api/auth/login");

    expect(ingressHeaders(req)).toEqual({});
  });

  it("returns {} (not a header with an empty value) when the header is present but empty", () => {
    const req = new Request("http://localhost/api/auth/login", {
      headers: { [INGRESS_HEADER]: "" },
    });

    expect(ingressHeaders(req)).toEqual({});
  });
});
