import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";

// D1 (batch 04 auth/session parity): apiFetch is a thin fetch wrapper, not a
// second enforcement layer -- the backend's verify_api_key is what actually
// rejects unauthenticated requests. This just closes the UX loop client-side:
// a 401 body means the HttpOnly cookie is gone/expired, so bounce to /login
// instead of leaving the caller to render a blank/broken state.

describe("apiFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards args to fetch and returns its response untouched on 200", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });

    const res = await apiFetch("/api/foo", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledWith("/api/foo", { method: "POST" });
    expect(res.status).toBe(200);
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("calls fetch with exactly the args given (no injected second arg)", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });

    await apiFetch("/api/foo");

    expect(fetchMock).toHaveBeenCalledWith("/api/foo");
  });

  it("on a 401 in the browser, navigates to /login via window.location.assign", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignMock });

    await apiFetch("/api/foo");

    expect(assignMock).toHaveBeenCalledWith("/login");
    expect(assignMock).toHaveBeenCalledTimes(1);
  });

  it("still returns the 401 response so callers can behave (not swallowed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });

    const res = await apiFetch("/api/foo");

    expect(res.status).toBe(401);
  });

  it("on a 500, does not navigate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignMock });

    await apiFetch("/api/foo");

    expect(assignMock).not.toHaveBeenCalled();
  });

  it("server-side (no window) on a 401 never navigates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignMock });
    vi.stubGlobal("window", undefined);

    const res = await apiFetch("/api/foo");

    expect(assignMock).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("propagates a rejected fetch instead of swallowing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    await expect(apiFetch("/api/foo")).rejects.toThrow("network down");
  });
});
