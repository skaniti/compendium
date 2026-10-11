import { describe, expect, it, vi } from "vitest";
import { CROSS_ORIGIN_ERROR, crossOriginRefusal } from "./cross-origin-guard";

function req(method: string, headers: Record<string, string> = {}, url = "https://app.test/api/x") {
  return new Request(url, { method, headers });
}

describe("crossOriginRefusal", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});

  it.each([
    ["GET", { "sec-fetch-site": "cross-site" }],
    ["HEAD", { "sec-fetch-site": "cross-site" }],
    ["OPTIONS", { "sec-fetch-site": "same-site" }],
    ["POST", { "sec-fetch-site": "same-origin" }],
    ["POST", { "sec-fetch-site": "none" }],
    ["POST", {}],
    ["POST", { origin: "https://app.test" }],
    ["POST", { origin: "https://APP.test" }],
    ["DELETE", { origin: "https://app.test", host: "app.test" }],
  ])("allows %s %j", (method, headers) => {
    expect(crossOriginRefusal(req(method, headers as Record<string, string>))).toBeNull();
  });

  it.each([
    ["POST", { "sec-fetch-site": "same-site" }],
    ["POST", { "sec-fetch-site": "cross-site" }],
    ["PUT", { "sec-fetch-site": "same-site" }],
    ["PATCH", { "sec-fetch-site": "cross-site" }],
    ["DELETE", { "sec-fetch-site": "same-site" }],
    ["POST", { "sec-fetch-site": "same-site", origin: "https://app.test" }],
    ["POST", { origin: "https://demo.app.test" }],
    ["POST", { origin: "https://app.test:8443" }],
    ["POST", { origin: "http://evil.test" }],
    ["POST", { origin: "null" }],
    ["POST", { origin: "not a url" }],
  ])("refuses %s %j", async (method, headers) => {
    const res = crossOriginRefusal(req(method, headers as Record<string, string>));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: CROSS_ORIGIN_ERROR });
  });

  it("compares the Origin with the Host header when one is present", () => {
    const r = req("POST", { origin: "https://owner.example.com", host: "owner.example.com" }, "http://127.0.0.1:3000/api/x");
    expect(crossOriginRefusal(r)).toBeNull();
  });
});
