import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { GET, HEAD } from "./route";
import * as routeModule from "./route";

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

describe("GET/HEAD /captured-assets/[...path]", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  it("builds the upstream URL from the request's raw pathname", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar("test-token") as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/captured-assets/a/b/load.php");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/captured-assets/a/b/load.php");
  });

  it("injects the bearer from the cookie and strips the browser's cookie header", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar("server-token") as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/captured-assets/a/b/load.php", {
      headers: { cookie: "access_token=browser-token; refresh_token=browser-refresh" },
    });
    await GET(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    expect(init.headers.get("authorization")).toBe("Bearer server-token");
    expect(init.headers.has("cookie")).toBe(false);
  });

  it("passes the upstream status and content-type/cache-control through", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const upstreamHeaders = new Headers({
      "content-type": "image/png",
      "cache-control": "no-store",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 404, headers: upstreamHeaders }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/captured-assets/missing.png");
    const res = await GET(req);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("HEAD builds the same upstream URL and forwards the method", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/captured-assets/a/b/load.php", { method: "HEAD" });
    const res = await HEAD(req);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    expect(new URL(url).pathname).toBe("/captured-assets/a/b/load.php");
    expect(init.method).toBe("HEAD");
  });

  it("exports no POST handler", () => {
    expect((routeModule as Record<string, unknown>).POST).toBeUndefined();
  });

  // --- Fix round 1 (review S1) -------------------------------------------
  // The old implementation built the upstream path by joining Next's
  // catch-all params.path (each segment already decodeURIComponent'd by
  // Next's route matcher). That let a decoded dot-segment collapse the
  // upstream URL outside /captured-assets (still carrying the bearer), and
  // let a decoded #/?/% truncate or rewrite the exact captured_assets
  // file-path lookup key. The fix reads the upstream path from req.url's
  // own (still percent-encoded) pathname and rejects anything that doesn't
  // resolve under the /captured-assets/ prefix.

  it("preserves encoded reserved characters (%23, %3F, %25) verbatim in the upstream path", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/captured-assets/a%23b%3Fc%25d.png");
    await GET(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/captured-assets/a%23b%3Fc%25d.png");
  });

  it("rejects with 404 (no fetch call) when an encoded dot-segment resolves outside the prefix", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar("test-token") as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // The WHATWG URL parser treats "%2e%2e" as a double-dot path segment
    // (per spec, not just literal ".."), so this already resolves to
    // "/secret" -- outside the prefix -- by the time req.url reflects it.
    const req = new Request("http://localhost/captured-assets/%2e%2e/secret");
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
