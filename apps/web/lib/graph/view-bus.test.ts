import { describe, expect, it, vi } from "vitest";
import { lastView, publishView, subscribeView, type GraphView } from "./view-bus";

// Batch B (spec docs/project-plans/2026-09-13-183006-graph-interaction-
// followups/spec.md): the vendor's zoom handler -> Starfield.tsx pub/sub.
// Pure module-state tests -- no DOM, no vendor, no React.

function view(overrides: Partial<GraphView> = {}): GraphView {
  return { x: 10, y: 20, k: 1, fitX: 0, fitY: 0, fitK: 1, ...overrides };
}

describe("view-bus", () => {
  it("delivers a published view to every current subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeView(a);
    subscribeView(b);
    const v = view({ x: 5 });
    publishView(v);
    expect(a).toHaveBeenCalledWith(v);
    expect(b).toHaveBeenCalledWith(v);
  });

  it("stops delivering to a subscriber once unsubscribed", () => {
    const fn = vi.fn();
    const unsubscribe = subscribeView(fn);
    publishView(view({ x: 1 }));
    expect(fn).toHaveBeenCalledTimes(1);

    unsubscribe();
    publishView(view({ x: 2 }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("lastView() returns the most recently published view", () => {
    publishView(view({ x: 7, y: 8, k: 2, fitX: 1, fitY: 2, fitK: 0.5 }));
    expect(lastView()).toEqual({ x: 7, y: 8, k: 2, fitX: 1, fitY: 2, fitK: 0.5 });

    publishView(view({ x: 9 }));
    expect(lastView()?.x).toBe(9);
  });

  it("a new subscriber does not get replayed the latest view (only future publishes)", () => {
    publishView(view({ x: 100 }));
    const fn = vi.fn();
    subscribeView(fn);
    expect(fn).not.toHaveBeenCalled();

    publishView(view({ x: 101 }));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
