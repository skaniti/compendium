import { describe, expect, it } from "vitest";
import { INGRESS_HEADER, ingressHeaders } from "./ingress";

// batch-06 deploy-flip fix wave: apps/web is fronted by Vercel, with no
// trusted edge in front of it that could overwrite a client-supplied
// header (the tailnet Caddy listener that used to do this never fronts
// Vercel). ingressHeaders() must therefore NEVER read the inbound
// request's header -- doing so would let any caller claim the
// "remembered" trusted-refresh policy for itself. These pin that it
// always returns {}, including the adversarial case: a request that
// carries the header set to the trusted-looking value.

describe("ingressHeaders", () => {
  it("returns {} even when the inbound request carries the header with the trusted-looking value", () => {
    const req = new Request("http://localhost/api/auth/login", {
      headers: { [INGRESS_HEADER]: "tailnet" },
    });

    expect(ingressHeaders(req)).toEqual({});
  });

  it("returns {} regardless of the header's value -- it never reads the inbound request at all", () => {
    const req = new Request("http://localhost/api/auth/login", {
      headers: { [INGRESS_HEADER]: "public" },
    });

    expect(ingressHeaders(req)).toEqual({});
  });

  it("returns {} when the inbound request has no ingress header", () => {
    const req = new Request("http://localhost/api/auth/login");

    expect(ingressHeaders(req)).toEqual({});
  });
});
