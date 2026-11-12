// Pure wheel-event classification for the graph's input profiles (vendor
// header comment delta #42). No DOM access: the vendor reads the fields off a
// real WheelEvent and hands them in as a plain sample, so every rule below is
// unit-testable with the event shapes real browsers deliver.

export type InputProfile = "auto" | "mouse" | "trackpad";
export const INPUT_PROFILES: readonly InputProfile[] = ["auto", "mouse", "trackpad"];

export type WheelKind = "mouse" | "trackpad";
export type WheelIntent = "zoom" | "pan";

export interface WheelSample {
  // Read deltaMode BEFORE the delta values at the call site: Firefox only
  // reports line mode when deltaMode is read first.
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  // Legacy Chromium/WebKit field; absent (undefined) on Firefox.
  wheelDeltaY?: number;
  shiftKey: boolean;
  // ctrlKey || metaKey (a trackpad pinch arrives as a ctrlKey wheel).
  zoomModifier: boolean;
  // Event timestamp in ms (any monotonic origin).
  time: number;
}

// Wheel events less than this far apart belong to one gesture and keep the
// first event's classification, so a trackpad flick whose tail momentarily
// shows a big delta never flips from pan to zoom mid-gesture. Trackpad
// scroll/inertia events are ~16 ms apart; a person pausing between mouse
// notches is well past 200 ms.
export const WHEEL_GESTURE_GAP_MS = 200;
// Chromium reports one wheelDeltaY unit-notch as 120 (Windows/Linux/macOS
// mice); a precision touchpad reports wheelDeltaY = -3 * deltaY instead.
export const WHEEL_DELTA_NOTCH = 120;
export const CHROMIUM_TOUCHPAD_WHEEL_DELTA_RATIO = 3;
// wheelDeltaY is an integer rounded from -3 * deltaY, so a fractional deltaY
// (1.5 -> -4.5 -> -4 or -5) misses an exact equality by up to 1.
export const WHEEL_DELTA_ROUNDING_TOLERANCE = 1;
// Last-resort magnitude split (no deltaMode / wheelDeltaY signal): a pixel
// mouse notch is 100 (Chromium Windows), ~53 (Chromium Linux); a touchpad
// emits many small events (typically < 30 each, rarely above 50 at the
// fastest flick). Below this a fractional or small deltaY reads as trackpad.
export const MOUSE_NOTCH_MIN_DELTA_PX = 50;
// Used only when nothing has ever been classified and the first event carries
// no delta at all (a zero-delta event does nothing either way).
export const DEFAULT_WHEEL_KIND: WheelKind = "mouse";

const DOM_DELTA_PIXEL = 0;

// Signals a-d for a single event; null when the event carries no usable
// delta or fits both device shapes (signal e, resolved by the caller).
export function classifyWheelEvent(s: WheelSample): WheelKind | null {
  // a. Line or page mode only comes from a notched wheel (Firefox mouse).
  if (s.deltaMode !== DOM_DELTA_PIXEL) return "mouse";
  // b. A horizontal component without Shift only comes from a touchpad.
  if (s.deltaX !== 0 && !s.shiftKey) return "trackpad";
  // c. Chromium/WebKit legacy wheelDeltaY.
  const w = s.wheelDeltaY;
  if (typeof w === "number" && w !== 0 && s.deltaY !== 0) {
    const touchpadShaped =
      Math.abs(w + CHROMIUM_TOUCHPAD_WHEEL_DELTA_RATIO * s.deltaY) <= WHEEL_DELTA_ROUNDING_TOLERANCE;
    const notchShaped = Math.abs(w) % WHEEL_DELTA_NOTCH === 0;
    // e. Both fit when |deltaY| is a multiple of 40 (a 40px mouse notch, or a
    // touchpad step that happens to land there): undecidable from one event,
    // so the caller reuses the previous gesture's classification.
    if (touchpadShaped && notchShaped) return null;
    if (touchpadShaped) return "trackpad";
    if (notchShaped) return "mouse";
  }
  // d. Magnitude fallback.
  if (s.deltaY === 0) return null;
  return Math.abs(s.deltaY) >= MOUSE_NOTCH_MIN_DELTA_PX ? "mouse" : "trackpad";
}

export interface WheelGestureState {
  // Classification of the most recent gesture (null until one is decided).
  kind: WheelKind | null;
  lastTime: number;
}

export interface WheelResolution {
  intent: WheelIntent;
  // The gesture's classification when Auto decided it; null when the event
  // did not go through the classifier (explicit profile, Shift, Ctrl/Cmd).
  kind: WheelKind | null;
  state: WheelGestureState | null;
}

// Maps one wheel event to zoom or pan under `profile`. Shift+wheel always
// pans, Ctrl/Cmd+wheel always zooms; otherwise the profile decides, and Auto
// classifies per gesture (see WHEEL_GESTURE_GAP_MS). Neither modifier case
// touches the gesture state, so a pinch or Shift scroll never re-labels the
// device.
export function resolveWheel(
  profile: InputProfile,
  state: WheelGestureState | null,
  s: WheelSample,
): WheelResolution {
  if (s.zoomModifier) return { intent: "zoom", kind: null, state };
  if (s.shiftKey) return { intent: "pan", kind: null, state };
  if (profile === "mouse") return { intent: "zoom", kind: null, state };
  if (profile === "trackpad") return { intent: "pan", kind: null, state };

  let kind: WheelKind | null;
  if (state && state.kind && s.time - state.lastTime < WHEEL_GESTURE_GAP_MS && s.time >= state.lastTime) {
    kind = state.kind; // same gesture: keep its first classification
  } else {
    // New gesture; an event with no usable delta reuses the previous one.
    kind = classifyWheelEvent(s) ?? state?.kind ?? null;
  }
  return {
    intent: (kind ?? DEFAULT_WHEEL_KIND) === "mouse" ? "zoom" : "pan",
    kind,
    state: { kind, lastTime: s.time },
  };
}
