import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import StarfieldProvider, { useStarfield } from "./StarfieldProvider";
import Starfield from "./Starfield";
import * as preferences from "@/lib/preferences";
import { publishView } from "@/lib/graph/view-bus";

// Drives StarfieldProvider's context from outside so tests can trigger
// variant changes the same way SettingsMenu's pills do.
function VariantButtons() {
  const { setVariant } = useStarfield();
  return (
    <div>
      <button onClick={() => setVariant("hyperspace")}>go-hyperspace</button>
      <button onClick={() => setVariant("pan")}>go-pan</button>
      <button onClick={() => setVariant("none")}>go-none</button>
    </div>
  );
}

function renderStarfield(initialVariant?: string) {
  return render(
    <StarfieldProvider initialVariant={initialVariant}>
      <VariantButtons />
      <Starfield />
    </StarfieldProvider>
  );
}

function getMount(): HTMLElement {
  const mount = document.getElementById("starry-sky-mount");
  if (!mount) throw new Error("#starry-sky-mount not found");
  return mount;
}

function getSky(): Element | null {
  return getMount().querySelector("starry-sky");
}

describe("Starfield", () => {
  beforeEach(() => {
    // Several cases below click through StarfieldProvider's real setVariant,
    // which calls patchPreferences -- mock it so those clicks don't fire
    // real fetches in jsdom (they'd fail and get silently swallowed by
    // patchPreferences' own try/catch, which is exactly the kind of
    // spurious-failure-if-the-swallow-ever-changes noise this guards
    // against). Persistence itself is StarfieldProvider's contract, covered
    // in StarfieldProvider.test.tsx -- this file only cares about the DOM
    // side (mount/attribute/visibility), so a resolved no-op is enough.
    vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the #starry-sky-mount div immediately", () => {
    renderStarfield("twinkle");
    expect(getMount()).toBeInTheDocument();
  });

  it("mounts a <starry-sky> element into the mount div, with the initial variant attribute", async () => {
    renderStarfield("pan");

    await waitFor(() => expect(getSky()).not.toBeNull());
    expect(getSky()!.getAttribute("variant")).toBe("pan");
  });

  it("defaults to twinkle when no initialVariant is provided", async () => {
    renderStarfield();

    await waitFor(() => expect(getSky()).not.toBeNull());
    expect(getSky()!.getAttribute("variant")).toBe("twinkle");
  });

  it("only mounts one <starry-sky> element (mount-once, not per render)", async () => {
    renderStarfield("twinkle");

    await waitFor(() => expect(getSky()).not.toBeNull());
    const first = getSky();

    await act(async () => {
      screen.getByText("go-pan").click();
    });

    expect(getMount().querySelectorAll("starry-sky")).toHaveLength(1);
    expect(getSky()).toBe(first);
  });

  it("updates the variant attribute on the mounted element when the context variant changes", async () => {
    renderStarfield("twinkle");
    await waitFor(() => expect(getSky()).not.toBeNull());

    await act(async () => {
      screen.getByText("go-hyperspace").click();
    });

    expect(getSky()!.getAttribute("variant")).toBe("hyperspace");
  });

  it('hides the element (display:none) when the variant is "none", without unmounting it', async () => {
    renderStarfield("twinkle");
    await waitFor(() => expect(getSky()).not.toBeNull());

    await act(async () => {
      screen.getByText("go-none").click();
    });

    const sky = getSky();
    expect(sky).not.toBeNull();
    expect((sky as HTMLElement).style.display).toBe("none");
  });

  it('mounting directly with initialVariant="none" mounts a hidden element with a real fallback variant', async () => {
    renderStarfield("none");

    await waitFor(() => expect(getSky()).not.toBeNull());
    const sky = getSky() as HTMLElement;
    expect(sky.style.display).toBe("none");
    // "none" isn't a real render variant on the underlying <starry-sky>
    // component -- it's mounted with the twinkle fallback so the element
    // (and its attribute-swap wiring) exists for later switches.
    expect(sky.getAttribute("variant")).toBe("twinkle");
  });

  it('un-hides and re-applies the attribute when switching away from "none"', async () => {
    renderStarfield("none");
    await waitFor(() => expect(getSky()).not.toBeNull());
    expect((getSky() as HTMLElement).style.display).toBe("none");

    await act(async () => {
      screen.getByText("go-pan").click();
    });

    const sky = getSky() as HTMLElement;
    expect(sky.style.display).toBe("");
    expect(sky.getAttribute("variant")).toBe("pan");
  });

  it("sets data-variant on the mount div, tracking the live variant", async () => {
    renderStarfield("twinkle");
    expect(getMount().dataset.variant).toBe("twinkle");

    await act(async () => {
      screen.getByText("go-hyperspace").click();
    });

    expect(getMount().dataset.variant).toBe("hyperspace");
  });

  // Batch B (spec docs/project-plans/2026-09-13-183006-graph-interaction-
  // followups/spec.md): starfield parallax with the pan. lib/graph/
  // view-bus.ts's publishView is called directly here (the same thing
  // components/GraphCanvas.tsx's onViewChange wiring does) -- no real
  // vendor render() involved, matching this file's existing "DOM side
  // only" scope (see the top-of-file comment on patchPreferences). Fix
  // review C1: every view below sets `cx`/`cy` explicitly -- when they
  // equal `fitX`/`fitY`, C1's correction term is zero regardless of zoom
  // ratio, so a test can isolate the ORIGINAL (pre-fix) pan-scaling
  // behavior by choosing `cx === fitX`/`cy === fitY`; two dedicated tests
  // below instead choose a nonzero `cx - fitX` specifically to exercise
  // the correction term itself.
  describe("parallax (Batch B, corrected for a pure zoom by fix review C1)", () => {
    it("applies a translate3d transform derived from a published view", async () => {
      renderStarfield("twinkle");
      await waitFor(() => expect(getSky()).not.toBeNull());

      act(() => {
        publishView({ x: 20, y: -10, k: 1, fitX: 0, fitY: 0, fitK: 1, cx: 0, cy: 0 });
      });

      // Default factor 0.5, at fit scale (fitK/k === 1, correction term
      // zero since cx===fitX/cy===fitY): dx = 20*0.5 = 10, dy = -10*0.5 = -5.
      expect(getMount().style.transform).toBe("translate3d(10px, -5px, 0)");
    });

    it("rescales a real pan's offset by fitK/k so a deeper zoom doesn't exaggerate it (correction term isolated: cx === fitX)", async () => {
      renderStarfield("twinkle");
      await waitFor(() => expect(getSky()).not.toBeNull());

      act(() => {
        // Panned 100 screen px at 2x zoom relative to fit (fitK/k = 0.5) --
        // cx===fitX/cy===fitY keeps the correction term zero, isolating the
        // SAME pan-scaling math the pre-fix formula used: pre-factor 100*0.5
        // = 50 ("half the screen delta"), and at the default 0.5 factor,
        // dx = 50*0.5 = 25.
        publishView({ x: 100, y: 0, k: 2, fitX: 0, fitY: 0, fitK: 1, cx: 0, cy: 0 });
      });

      expect(getMount().style.transform).toBe("translate3d(25px, 0px, 0)");
    });

    it("reports zero offset for a pure zoom about the canvas center (no real pan) -- fix review C1", async () => {
      renderStarfield("twinkle");
      await waitFor(() => expect(getSky()).not.toBeNull());

      act(() => {
        // fitX=50, fitY=30, fitK=1, canvas center cx=400/cy=300 -- the
        // exact transform a REAL zoom-about-center gesture (the vendor's
        // __d3ZoomTo/scaleBy default anchor, a ctrl+wheel notch, or the
        // zoom-indicator's buttons) produces at k=2 with NO accompanying
        // world-space pan: x = cx - (cx-fitX)*(k/fitK) = 400 - 350*2 =
        // -300, y = cy - (cy-fitY)*(k/fitK) = 300 - 270*2 = -240. Before
        // fix review C1, the old formula ((x-fitX)*(fitK/k)) read this as
        // a -175px pan; the corrected formula must read zero.
        publishView({ x: -300, y: -240, k: 2, fitX: 50, fitY: 30, fitK: 1, cx: 400, cy: 300 });
      });

      expect(getMount().style.transform).toBe("translate3d(0px, 0px, 0)");
    });

    it("clears the transform on unmount", async () => {
      const { unmount } = renderStarfield("twinkle");
      await waitFor(() => expect(getSky()).not.toBeNull());

      act(() => {
        publishView({ x: 20, y: 20, k: 1, fitX: 0, fitY: 0, fitK: 1, cx: 0, cy: 0 });
      });
      expect(getMount().style.transform).not.toBe("");

      const mount = getMount();
      unmount();
      expect(mount.style.transform).toBe("");
    });

    it("stops applying published views once unmounted (unsubscribed)", async () => {
      const { unmount } = renderStarfield("twinkle");
      await waitFor(() => expect(getSky()).not.toBeNull());
      const mount = getMount();

      unmount();
      act(() => {
        publishView({ x: 999, y: 999, k: 1, fitX: 0, fitY: 0, fitK: 1, cx: 0, cy: 0 });
      });

      expect(mount.style.transform).toBe("");
    });

    // Fix review minor: apply lastView() on subscribe.
    it("applies the already-published view immediately on mount (late subscriber)", () => {
      act(() => {
        publishView({ x: 20, y: -10, k: 1, fitX: 0, fitY: 0, fitK: 1, cx: 0, cy: 0 });
      });

      renderStarfield("twinkle");
      // No further publishView call -- the parallax effect must apply
      // lastView() synchronously within its own mount commit, not wait for
      // the next tick.
      expect(getMount().style.transform).toBe("translate3d(10px, -5px, 0)");
    });
  });

  // Fix review I3: starry-sky.js's `count` option is a no-op for visible
  // density (percentage box-shadow offsets, see that file's own header
  // comment) -- twinkle/glint/stream count are the real density knobs, now
  // exposed as attributes and scaled 4x (STARFIELD_OVERSIZE_AREA_FACTOR)
  // for the mount's 4x-oversized area, at BOTH mount time and a later
  // variant switch.
  describe("density scaling (fix review I3)", () => {
    it("mounts with 4x the initial variant's own twinkle/glint counts", async () => {
      renderStarfield("twinkle");
      await waitFor(() => expect(getSky()).not.toBeNull());

      const sky = getSky()!;
      // lib/vendor/starry-sky.js buildTwinkle defaults: twinkleCount=60, glintCount=4.
      expect(sky.getAttribute("twinkle-count")).toBe(String(60 * 4));
      expect(sky.getAttribute("glint-count")).toBe(String(4 * 4));
    });

    it("mounts a pan variant with 4x its own glint count only (no twinkle-count)", async () => {
      renderStarfield("pan");
      await waitFor(() => expect(getSky()).not.toBeNull());

      const sky = getSky()!;
      // lib/vendor/starry-sky.js buildPan default: glintCount=5.
      expect(sky.getAttribute("glint-count")).toBe(String(5 * 4));
      expect(sky.getAttribute("twinkle-count")).toBeNull();
    });

    it("re-scales density for the NEW variant on a later switch", async () => {
      renderStarfield("twinkle");
      await waitFor(() => expect(getSky()).not.toBeNull());

      await act(async () => {
        screen.getByText("go-hyperspace").click();
      });

      const sky = getSky()!;
      // lib/vendor/starry-sky.js buildHyperspace default: streamCount=70.
      expect(sky.getAttribute("stream-count")).toBe(String(70 * 4));
    });
  });
});
