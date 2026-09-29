import { describe, it, expect } from "vitest";
import { DEV_VIEWS, findDevView, visibleDevViews, isPlainDemo } from "./dev-views";

describe("dev view registry", () => {
  it("pipeline is registered, demo-visitable, at /dev/pipeline", () => {
    const v = findDevView("pipeline");
    expect(v?.href).toBe("/dev/pipeline");
    expect(v?.access).toBe("any");
    expect(DEV_VIEWS[0].id).toBe("pipeline");
  });
  it("unknown id -> undefined", () => expect(findDevView("nope")).toBeUndefined());
  it("plain demo drops admin-only views; admin and acting-as-demo keep them", () => {
    const adminOnly = { id: "logs", label: "Logs", href: "/dev/logs", access: "admin" as const, Icon: () => null, View: () => null };
    const all = [...DEV_VIEWS, adminOnly];
    expect(visibleDevViews("demo", false, all).map((v) => v.id)).toEqual(["pipeline"]);
    expect(visibleDevViews("admin", false, all).map((v) => v.id)).toEqual(["pipeline", "logs"]);
    expect(visibleDevViews("demo", true, all).map((v) => v.id)).toEqual(["pipeline", "logs"]);
    expect(visibleDevViews(null, false, all).map((v) => v.id)).toEqual(["pipeline"]);
  });
  it("isPlainDemo", () => {
    expect(isPlainDemo("demo", false)).toBe(true);
    expect(isPlainDemo("demo", true)).toBe(false);
    expect(isPlainDemo("admin", false)).toBe(false);
  });
});
