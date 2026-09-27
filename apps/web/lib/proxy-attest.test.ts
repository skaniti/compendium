import { afterEach, describe, expect, it } from "vitest";
import {
  PROXY_CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
  proxyAttestHeaders,
  stripInboundProxyAttestHeaders,
} from "./proxy-attest";

// Task 7e (post-flip-closeout): proxyAttestHeaders() attests the real
// client address to the backend so its rate limiter can key on more than
// one shared Vercel-egress bucket. Inert (returns {}) unless
// BACKEND_PROXY_SECRET is configured -- same "safe until explicitly
// configured" contract as lib/ingress.ts's ingressHeaders().

function makeRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/whatever", { headers });
}

describe("proxyAttestHeaders", () => {
  const ORIGINAL_SECRET = process.env.BACKEND_PROXY_SECRET;

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.BACKEND_PROXY_SECRET;
    else process.env.BACKEND_PROXY_SECRET = ORIGINAL_SECRET;
  });

  it("returns {} when BACKEND_PROXY_SECRET is unset", () => {
    delete process.env.BACKEND_PROXY_SECRET;

    expect(proxyAttestHeaders(makeRequest({ "x-forwarded-for": "198.51.100.9" }))).toEqual({});
  });

  it("returns both headers when the secret is set and x-forwarded-for is present", () => {
    process.env.BACKEND_PROXY_SECRET = "test-secret";

    const headers = proxyAttestHeaders(makeRequest({ "x-forwarded-for": "198.51.100.9" }));

    expect(headers).toEqual({
      [PROXY_SECRET_HEADER]: "test-secret",
      [PROXY_CLIENT_IP_HEADER]: "198.51.100.9",
    });
  });

  it("uses only the first hop of a multi-hop x-forwarded-for, trimmed", () => {
    process.env.BACKEND_PROXY_SECRET = "test-secret";

    const headers = proxyAttestHeaders(
      makeRequest({ "x-forwarded-for": "198.51.100.9 , 192.0.2.1, 192.0.2.2" })
    );

    expect(headers[PROXY_CLIENT_IP_HEADER]).toBe("198.51.100.9");
  });

  it("returns the secret only (no ip header) when x-forwarded-for is absent", () => {
    process.env.BACKEND_PROXY_SECRET = "test-secret";

    const headers = proxyAttestHeaders(makeRequest());

    expect(headers).toEqual({ [PROXY_SECRET_HEADER]: "test-secret" });
  });

  it("returns the secret only when the first hop does not parse as an ip literal", () => {
    process.env.BACKEND_PROXY_SECRET = "test-secret";

    const headers = proxyAttestHeaders(makeRequest({ "x-forwarded-for": "not-an-ip" }));

    expect(headers).toEqual({ [PROXY_SECRET_HEADER]: "test-secret" });
  });

  it("accepts an ipv6 literal as the first hop", () => {
    process.env.BACKEND_PROXY_SECRET = "test-secret";

    const headers = proxyAttestHeaders(makeRequest({ "x-forwarded-for": "2001:db8::1" }));

    expect(headers[PROXY_CLIENT_IP_HEADER]).toBe("2001:db8::1");
  });
});

describe("stripInboundProxyAttestHeaders", () => {
  it("removes both attest headers from a Headers object", () => {
    const headers = new Headers({
      [PROXY_SECRET_HEADER]: "browser-supplied",
      [PROXY_CLIENT_IP_HEADER]: "1.2.3.4",
      "content-type": "application/json",
    });

    stripInboundProxyAttestHeaders(headers);

    expect(headers.has(PROXY_SECRET_HEADER)).toBe(false);
    expect(headers.has(PROXY_CLIENT_IP_HEADER)).toBe(false);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("is a no-op when neither header is present", () => {
    const headers = new Headers({ "content-type": "application/json" });

    stripInboundProxyAttestHeaders(headers);

    expect(headers.get("content-type")).toBe("application/json");
  });
});
