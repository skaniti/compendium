import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { proxyToBackend } from "./backend-proxy";
import { PROXY_CLIENT_IP_HEADER, PROXY_SECRET_HEADER } from "./proxy-attest";

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

describe("proxyToBackend", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  it("forwards the method and body, using upstreamPath verbatim", async () => {
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

    const res = await proxyToBackend(req, "/api/topics/demo/icon");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    // Asserts the PATH/QUERY built, not the host -- BACKEND is read once at
    // module-import time from process.env.BACKEND_URL (falling back to
    // localhost:8001), so a literal full-URL assertion here would depend on
    // whatever BACKEND_URL happened to be set to in the ambient environment
    // this test runs under, rather than the proxying logic under test.
    expect(new URL(url).pathname).toBe("/api/topics/demo/icon");
    expect(init.method).toBe("PUT");
    expect(init.headers.get("authorization")).toBe("Bearer test-token");
    expect(Buffer.from(init.body as ArrayBuffer).toString()).toBe(JSON.stringify(payload));
  });

  it("does not inject the cookie Bearer when the request carries an X-API-Key", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar("ambient-token") as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/api/passive-captures", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "ext-key" },
      body: JSON.stringify({ pages: [] }),
    });

    await proxyToBackend(req, "/api/passive-captures");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    expect(init.headers.get("x-api-key")).toBe("ext-key");
    expect(init.headers.get("authorization")).toBeNull();
  });

  it("appends the caller's query string to upstreamPath", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/captured-assets/a/b/load.php?foo=bar", {
      method: "GET",
    });

    await proxyToBackend(req, "/captured-assets/a/b/load.php");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/captured-assets/a/b/load.php");
    expect(parsed.searchParams.get("foo")).toBe("bar");
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

    await proxyToBackend(req, "/api/topics/demo/icon");

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

    const res = await proxyToBackend(req, "/api/topics/demo/icon");

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

    await proxyToBackend(req, "/api/topics/demo/icon");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    expect(init.headers.has("cookie")).toBe(false);
    expect(init.headers.get("authorization")).toBe("Bearer server-token");
  });

  // Task 7e (post-flip-closeout): proxyToBackend copies the inbound
  // request's headers wholesale (new Headers(req.headers) above), so
  // without an explicit strip a browser could set the attest headers
  // itself and claim any rate-limit key it likes.
  describe("proxy attest headers", () => {
    const ORIGINAL_SECRET = process.env.BACKEND_PROXY_SECRET;

    afterEach(() => {
      if (ORIGINAL_SECRET === undefined) delete process.env.BACKEND_PROXY_SECRET;
      else process.env.BACKEND_PROXY_SECRET = ORIGINAL_SECRET;
    });

    it("strips inbound attest headers even when BACKEND_PROXY_SECRET is unset", async () => {
      delete process.env.BACKEND_PROXY_SECRET;
      vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const req = new Request("http://localhost/api/topics/demo", {
        headers: {
          [PROXY_SECRET_HEADER]: "browser-supplied-secret",
          [PROXY_CLIENT_IP_HEADER]: "9.9.9.9",
        },
      });

      await proxyToBackend(req, "/api/topics/demo");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
      expect(init.headers.has(PROXY_SECRET_HEADER)).toBe(false);
      expect(init.headers.has(PROXY_CLIENT_IP_HEADER)).toBe(false);
    });

    it("strips a browser-supplied attest pair AND sets the real attested pair when the secret is configured", async () => {
      process.env.BACKEND_PROXY_SECRET = "real-shared-secret";
      vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const req = new Request("http://localhost/api/topics/demo", {
        headers: {
          [PROXY_SECRET_HEADER]: "browser-supplied-secret",
          [PROXY_CLIENT_IP_HEADER]: "9.9.9.9",
          "x-forwarded-for": "198.51.100.9",
        },
      });

      await proxyToBackend(req, "/api/topics/demo");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
      expect(init.headers.get(PROXY_SECRET_HEADER)).toBe("real-shared-secret");
      expect(init.headers.get(PROXY_CLIENT_IP_HEADER)).toBe("198.51.100.9");
    });
  });
});
