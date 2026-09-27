import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { GET, PUT } from "./route";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

function makeFakeCookieJar(accessToken?: string) {
  return {
    get(name: string) {
      return name === "access_token" && accessToken ? { name, value: accessToken } : undefined;
    },
  };
}

describe("PUT /api/[...path]", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  it("forwards PUT with body and auth header", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar("test-token") as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = { icon: "star" };
    const req = new Request("http://localhost/api/topics/demo/icon", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const res = await PUT(req);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    // Asserts the PATH/QUERY the proxy built, not the host -- BACKEND is
    // read once at module-import time from process.env.BACKEND_URL
    // (falling back to localhost:8001), so a literal full-URL assertion
    // here would depend on whatever BACKEND_URL happened to be set to in
    // the ambient environment this test runs under, rather than the
    // proxying logic under test.
    expect(new URL(url).pathname).toBe("/api/topics/demo/icon");
    expect(init.method).toBe("PUT");
    expect(init.headers.get("authorization")).toBe("Bearer test-token");
    expect(Buffer.from(init.body as ArrayBuffer).toString()).toBe(JSON.stringify(payload));
  });

  it("forces identity accept-encoding upstream regardless of the client's header", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/api/topics/demo/icon", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "accept-encoding": "gzip, deflate, br, zstd",
      },
      body: JSON.stringify({ icon: "star" }),
    });

    await PUT(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    expect(init.headers.get("accept-encoding")).toBe("identity");
  });

  it("strips upstream content-encoding and content-length from the proxied response", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const upstreamHeaders = new Headers({
      "content-type": "application/json",
      "content-encoding": "br",
      "content-length": "123",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: upstreamHeaders }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/api/topics/demo/icon", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ icon: "star" }),
    });

    const res = await PUT(req);

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  // batch-06 (deploy-flip fix wave): the API ignores cookies entirely (it
  // authenticates via the injected Bearer token), so forwarding the
  // browser's own Cookie header upstream too is unnecessary exposure of
  // both tokens over the same hop. The Authorization injection (from the
  // Next-held access_token cookie via next/headers, a completely separate
  // read from the inbound request's own Cookie header) must still happen.
  it("strips the browser's cookie header before proxying, while still injecting the authorization header", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar("server-token") as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/api/topics/demo/icon", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: "access_token=browser-token; refresh_token=browser-refresh",
      },
      body: JSON.stringify({ icon: "star" }),
    });

    await PUT(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    expect(init.headers.has("cookie")).toBe(false);
    expect(init.headers.get("authorization")).toBe("Bearer server-token");
  });
});

describe("path building safety (fix round 1, review S1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  // The old implementation built the upstream path by joining Next's
  // catch-all params.path (each segment already decodeURIComponent'd by
  // Next's route matcher). That let a decoded dot-segment collapse the
  // upstream URL outside /api (still carrying the bearer), and let a
  // decoded #/?/% truncate or rewrite the path the caller intended. The
  // fix reads the upstream path from req.url's own (still percent-encoded)
  // pathname and rejects anything that doesn't resolve under the /api/
  // prefix.

  it("preserves encoded reserved characters (%23, %3F, %25) verbatim in the upstream path", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/api/a%23b%3Fc%25d");
    await GET(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/a%23b%3Fc%25d");
  });

  it("rejects with 404 (no fetch call) when an encoded dot-segment resolves outside the prefix", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar("test-token") as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // The WHATWG URL parser treats "%2e%2e" as a double-dot path segment
    // (per spec, not just literal ".."), so this already resolves to
    // "/secret" -- outside the prefix -- by the time req.url reflects it.
    const req = new Request("http://localhost/api/%2e%2e/secret");
    const res = await GET(req);

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects with 404 (no fetch call) when the pathname doesn't start with the prefix", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar("test-token") as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/other/path");
    const res = await GET(req);

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
