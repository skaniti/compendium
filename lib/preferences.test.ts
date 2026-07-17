import { describe, it, expect, vi, afterEach } from "vitest";
import { getPreferences, patchPreferences } from "./preferences";

describe("getPreferences", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/auth/preferences (through the proxy) and returns parsed JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ theme: "Pink" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const prefs = await getPreferences();

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/preferences");
    expect(prefs).toEqual({ theme: "Pink" });
  });

  it("returns {} without throwing on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(getPreferences()).resolves.toEqual({});
  });

  it("returns {} without throwing when fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    await expect(getPreferences()).resolves.toEqual({});
  });

  it("returns {} without throwing on a malformed (non-JSON) body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));

    await expect(getPreferences()).resolves.toEqual({});
  });
});

describe("patchPreferences", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PATCHes /api/auth/preferences with a JSON-encoded body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await patchPreferences({ theme: "Teal" });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "Teal" }),
    });
  });

  it("does not throw on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(patchPreferences({ theme: "Teal" })).resolves.toBeUndefined();
  });

  it("does not throw when fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    await expect(patchPreferences({ theme: "Teal" })).resolves.toBeUndefined();
  });
});
