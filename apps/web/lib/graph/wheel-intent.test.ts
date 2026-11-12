import { describe, it, expect } from "vitest";
import {
  classifyWheelEvent,
  resolveWheel,
  WHEEL_GESTURE_GAP_MS,
  type WheelGestureState,
  type WheelSample,
} from "./wheel-intent";

function sample(over: Partial<WheelSample>): WheelSample {
  return { deltaMode: 0, deltaX: 0, deltaY: 0, shiftKey: false, zoomModifier: false, time: 0, ...over };
}

describe("classifyWheelEvent", () => {
  it("Chromium mouse notch on Windows (deltaY +/-100, wheelDeltaY -/+120) is mouse", () => {
    expect(classifyWheelEvent(sample({ deltaY: 100, wheelDeltaY: -120 }))).toBe("mouse");
    expect(classifyWheelEvent(sample({ deltaY: -100, wheelDeltaY: 120 }))).toBe("mouse");
  });

  it("a small-deltaY mouse notch (browser zoom) still reads as mouse via the 120 multiple", () => {
    expect(classifyWheelEvent(sample({ deltaY: 33, wheelDeltaY: -120 }))).toBe("mouse");
  });

  it("Firefox mouse notch (line mode, deltaY +/-3) is mouse", () => {
    expect(classifyWheelEvent(sample({ deltaMode: 1, deltaY: 3 }))).toBe("mouse");
    expect(classifyWheelEvent(sample({ deltaMode: 1, deltaY: -3 }))).toBe("mouse");
    expect(classifyWheelEvent(sample({ deltaMode: 2, deltaY: 1 }))).toBe("mouse");
  });

  it("Chromium precision-touchpad scroll (wheelDeltaY = -3 * deltaY) is trackpad", () => {
    for (const dy of [1.5, 4, 12, 30]) {
      expect(classifyWheelEvent(sample({ deltaY: dy, wheelDeltaY: Math.round(-3 * dy) }))).toBe("trackpad");
    }
    expect(classifyWheelEvent(sample({ deltaY: -12, wheelDeltaY: 36 }))).toBe("trackpad");
  });

  it("a touchpad scroll with a horizontal component is trackpad even with a notch-sized deltaY", () => {
    expect(classifyWheelEvent(sample({ deltaX: 3, deltaY: 100, wheelDeltaY: -120 }))).toBe("trackpad");
    expect(classifyWheelEvent(sample({ deltaX: -7, deltaY: 0 }))).toBe("trackpad");
  });

  it("Firefox touchpad scroll (pixel mode, small deltas, no wheelDeltaY) is trackpad", () => {
    expect(classifyWheelEvent(sample({ deltaY: 4 }))).toBe("trackpad");
    expect(classifyWheelEvent(sample({ deltaY: 0.75 }))).toBe("trackpad");
  });

  it("magnitude fallback: >= 50 is mouse, below is trackpad, fractional below 50 is trackpad", () => {
    expect(classifyWheelEvent(sample({ deltaY: 50 }))).toBe("mouse");
    expect(classifyWheelEvent(sample({ deltaY: -120 }))).toBe("mouse");
    expect(classifyWheelEvent(sample({ deltaY: 49.9 }))).toBe("trackpad");
    expect(classifyWheelEvent(sample({ deltaY: 33.3333 }))).toBe("trackpad");
  });

  it("a pinch-shaped event (small fractional deltaY) classifies as trackpad", () => {
    expect(classifyWheelEvent(sample({ deltaY: -2.5, wheelDeltaY: -0, zoomModifier: true }))).toBe("trackpad");
  });

  it("Shift is ignored for the horizontal-component rule", () => {
    expect(classifyWheelEvent(sample({ deltaX: 100, deltaY: 0, shiftKey: true }))).toBe(null);
  });

  it("an event with no delta is ambiguous", () => {
    expect(classifyWheelEvent(sample({}))).toBeNull();
  });

  it("an event that fits both shapes (|deltaY| a multiple of 40) is ambiguous", () => {
    expect(classifyWheelEvent(sample({ deltaY: 40, wheelDeltaY: -120 }))).toBeNull();
    expect(classifyWheelEvent(sample({ deltaY: -80, wheelDeltaY: 240 }))).toBeNull();
  });
});

describe("resolveWheel", () => {
  it("Ctrl/Cmd+wheel zooms in every profile and leaves the gesture state alone", () => {
    const st: WheelGestureState = { kind: "trackpad", lastTime: 5 };
    for (const p of ["auto", "mouse", "trackpad"] as const) {
      const r = resolveWheel(p, st, sample({ deltaY: -2.5, zoomModifier: true, time: 6 }));
      expect(r.intent).toBe("zoom");
      expect(r.kind).toBeNull();
      expect(r.state).toBe(st);
    }
  });

  it("Shift+wheel pans in every profile, never zooms", () => {
    for (const p of ["auto", "mouse", "trackpad"] as const) {
      const r = resolveWheel(p, null, sample({ deltaY: 100, wheelDeltaY: -120, shiftKey: true }));
      expect(r.intent).toBe("pan");
    }
  });

  it("explicit profiles ignore the device shape", () => {
    expect(resolveWheel("mouse", null, sample({ deltaY: 4 })).intent).toBe("zoom");
    expect(resolveWheel("trackpad", null, sample({ deltaY: 100, wheelDeltaY: -120 })).intent).toBe("pan");
  });

  it("auto: mouse notch zooms, touchpad scroll pans", () => {
    expect(resolveWheel("auto", null, sample({ deltaY: 100, wheelDeltaY: -120 })).intent).toBe("zoom");
    expect(resolveWheel("auto", null, sample({ deltaY: 5, wheelDeltaY: -15 })).intent).toBe("pan");
  });

  it("auto: a large-delta event 50 ms after a trackpad event stays trackpad", () => {
    const a = resolveWheel("auto", null, sample({ deltaY: 5, wheelDeltaY: -15, time: 1000 }));
    expect(a.kind).toBe("trackpad");
    const b = resolveWheel("auto", a.state, sample({ deltaY: 100, wheelDeltaY: -120, time: 1050 }));
    expect(b.kind).toBe("trackpad");
    expect(b.intent).toBe("pan");
  });

  it("auto: the same large-delta event after 300 ms is re-classified as mouse", () => {
    const a = resolveWheel("auto", null, sample({ deltaY: 5, wheelDeltaY: -15, time: 1000 }));
    const b = resolveWheel("auto", a.state, sample({ deltaY: 100, wheelDeltaY: -120, time: 1300 }));
    expect(b.kind).toBe("mouse");
    expect(b.intent).toBe("zoom");
  });

  it("auto: the gap is measured from the latest event, so a long gesture stays one gesture", () => {
    let st: WheelGestureState | null = null;
    let t = 0;
    const first = resolveWheel("auto", st, sample({ deltaY: 5, wheelDeltaY: -15, time: t }));
    st = first.state;
    for (let i = 0; i < 20; i++) {
      t += WHEEL_GESTURE_GAP_MS - 20;
      const r = resolveWheel("auto", st, sample({ deltaY: 100, wheelDeltaY: -120, time: t }));
      expect(r.kind).toBe("trackpad");
      st = r.state;
    }
  });

  it("auto: an ambiguous new gesture reuses the previous gesture's classification", () => {
    const a = resolveWheel("auto", null, sample({ deltaY: 100, wheelDeltaY: -120, time: 0 }));
    const b = resolveWheel("auto", a.state, sample({ time: 1000 }));
    expect(b.kind).toBe("mouse");
    const c = resolveWheel("auto", null, sample({ deltaY: 3, time: 0 }));
    const d = resolveWheel("auto", c.state, sample({ time: 1000 }));
    expect(d.kind).toBe("trackpad");
    expect(d.intent).toBe("pan");
  });

  it("auto: with nothing ever classified, an ambiguous event yields a null kind", () => {
    const r = resolveWheel("auto", null, sample({}));
    expect(r.kind).toBeNull();
  });
});
