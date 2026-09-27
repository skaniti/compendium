import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { GET, HEAD } from "./route";
import * as routeModule from "./route";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

type Ctx = { params: Promise<{ path: string[] }> };

function makeCtx(path: string[]): Ctx {
  return { params: Promise.resolve({ path }) };
}

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

  it("builds the upstream URL from the path params", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar("test-token") as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/captured-assets/a/b/load.php");
    const res = await GET(req, makeCtx(["a", "b", "load.php"]));

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
    await GET(req, makeCtx(["a", "b", "load.php"]));

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
    const res = await GET(req, makeCtx(["missing.png"]));

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
    const res = await HEAD(req, makeCtx(["a", "b", "load.php"]));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    expect(new URL(url).pathname).toBe("/captured-assets/a/b/load.php");
    expect(init.method).toBe("HEAD");
  });

  it("exports no POST handler", () => {
    expect((routeModule as Record<string, unknown>).POST).toBeUndefined();
  });
});
