import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { PUT } from "./route";

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

    const res = await PUT(req, makeCtx(["topics", "demo", "icon"]));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    // Asserts the PATH/QUERY the proxy built, not the host -- route.ts's
    // BACKEND const is read once at module-import time from
    // process.env.BACKEND_URL (falling back to localhost:8001), so a literal
    // full-URL assertion here would depend on whatever BACKEND_URL happened
    // to be set to in the ambient environment this test runs under, rather
    // than the proxying logic under test.
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

    await PUT(req, makeCtx(["topics", "demo", "icon"]));

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

    const res = await PUT(req, makeCtx(["topics", "demo", "icon"]));

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

    await PUT(req, makeCtx(["topics", "demo", "icon"]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    expect(init.headers.has("cookie")).toBe(false);
    expect(init.headers.get("authorization")).toBe("Bearer server-token");
  });
});
