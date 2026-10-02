import { describe, it, expect } from "vitest";
import { DEV_VIEWS, findDevView, liveDevViews, visibleDevViews, isPlainDemo, canSeeAdminViews } from "./dev-views";

describe("dev view registry", () => {
  it("pipeline is registered, demo-visitable, at /dev/pipeline", () => {
    const v = findDevView("pipeline");
    expect(v?.href).toBe("/dev/pipeline");
    expect(v?.access).toBe("any");
    expect(DEV_VIEWS[2].id).toBe("pipeline");
  });
  it("unknown id -> undefined", () => expect(findDevView("nope")).toBeUndefined());
  it("plain demo drops admin-only views; admin and acting-as-demo keep them", () => {
    const adminOnly = { id: "logs", label: "Logs", href: "/dev/logs", access: "admin" as const, status: "live" as const, Icon: () => null };
    const all = [findDevView("pipeline")!, adminOnly];
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
  it("canSeeAdminViews: admin or acting-as-demo only", () => {
    expect(canSeeAdminViews("admin", false)).toBe(true);
    expect(canSeeAdminViews("demo", true)).toBe(true);
    expect(canSeeAdminViews("demo", false)).toBe(false);
    expect(canSeeAdminViews("user", false)).toBe(false);
    expect(canSeeAdminViews(null, false)).toBe(false);
  });
  it("overview is registered, demo-visitable, first, live", () => {
    const v = findDevView("overview");
    expect(v?.href).toBe("/dev/overview");
    expect(v?.access).toBe("any");
    expect(v?.status).toBe("live");
    expect(DEV_VIEWS[0].id).toBe("overview");
  });
  it("registry order, three live views, rest planned", () => {
    expect(DEV_VIEWS.map((v) => v.id)).toEqual(["overview", "data", "pipeline", "clusters", "dqbot", "prompts", "logs", "traces"]);
    expect(DEV_VIEWS.filter((v) => v.status === "live")).toHaveLength(3);
    expect(liveDevViews().map((v) => v.id)).toEqual(["overview", "pipeline", "clusters"]);
  });
  it("plain demo keeps planned any-access tabs, drops planned admin-only ones", () => {
    const ids = visibleDevViews("demo", false).map((v) => v.id);
    expect(ids).toEqual(["overview", "data", "pipeline", "clusters", "prompts"]);
    expect(visibleDevViews("admin", false)).toHaveLength(8);
  });
});
