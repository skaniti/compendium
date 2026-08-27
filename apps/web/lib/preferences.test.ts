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

  it("returns {} instead of null when the body is a JSON null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("null", { status: 200 })));

    await expect(getPreferences()).resolves.toEqual({});
  });

  it("returns {} instead of a scalar when the body is a bare JSON number", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("42", { status: 200 })));

    await expect(getPreferences()).resolves.toEqual({});
  });

  it("returns {} instead of an array when the body is a JSON array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[1,2,3]", { status: 200 })));

    await expect(getPreferences()).resolves.toEqual({});
  });
});

describe("patchPreferences", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PATCHes /api/auth/preferences with the partial wrapped as {preferences: ...}", async () => {
    // Backend contract: PreferencesRequest expects {"preferences": {...}},
    // not the bare partial -- an unwrapped body 422s.
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await patchPreferences({ theme: "Teal" });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: { theme: "Teal" } }),
    });
  });

  it("callers still pass the bare partial -- wrapping is patchPreferences's job", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await patchPreferences({ panel_left_width: "25.00%", panel_right_width: "20%" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      preferences: { panel_left_width: "25.00%", panel_right_width: "20%" },
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
