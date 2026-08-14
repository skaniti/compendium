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
    expect(url).toBe("http://localhost:8001/api/topics/demo/icon");
    expect(init.method).toBe("PUT");
    expect(init.headers.get("authorization")).toBe("Bearer test-token");
    expect(Buffer.from(init.body as ArrayBuffer).toString()).toBe(JSON.stringify(payload));
  });
});
