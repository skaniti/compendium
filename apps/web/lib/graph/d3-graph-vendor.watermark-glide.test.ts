import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphPayload, GraphCluster, GraphSuperCluster } from "@/lib/types";
import type { IconEntry } from "@/lib/icons";
import { createSimEngine } from "@/lib/graph/sim-layout";
import type { MainToWorkerMessage, SimStartPayload, WorkerToMainMessage } from "@/lib/graph/sim-protocol";

// Delta #29 (vendor header comment) -- exercises the REAL vendor render()
// pipeline in jsdom, same overall strategy as
// d3-graph-vendor.remount.test.ts (see that file's own header comment for
// why: GraphCanvas.test.tsx mocks this module entirely, so it can never
// observe internal state like the R6 nameplate-deconfliction resolver or
// the glide this delta adds on top of it).
//
// jsdom implements no SVG geometry methods at all -- not `getScreenCTM`,
// not `getBBox` (verified by every other stub in this suite; see the
// remount test's own comment). The R6 resolver (drawWatermarks, vendor
// :3673-3797) and this delta's glide both live and die by those two
// methods, so this file stubs them more thoroughly than the other test
// files in this repo, which only ever needed a fixed identity matrix.
//
// Design choice: rather than trying to fake a *realistic* SVG geometry
// pipeline (ancestor CTM composition, real icon+text measurement), the
// stubs below are deliberately literal and self-consistent:
//   - getScreenCTM treats an element's OWN `translate(tx,ty)` attribute as
//     the entire screen transform (unit scale, ancestor zoom/pan ignored).
//     This keeps `currentZoomK`'s effect confined to where the vendor code
//     already applies it explicitly (its own screen<->world conversions)
//     instead of layering a second, competing scale factor into the fake
//     geometry.
//   - getBBox returns a shared, test-controlled LOCAL box size for every
//     `g.watermark` element (identified by its `data-sc` attribute) --
//     not a realistic icon+label footprint. Because both nameplates use
//     the SAME box size, making that size large relative to the real
//     (small, force-layout-derived) gap between the two super-cluster
//     centroids GUARANTEES the resolver finds a genuine overlap to
//     resolve on every draw, regardless of exactly where the tiny test
//     payload's simulation happens to settle -- no need to predict or
//     control exact centroid coordinates.
// Every OTHER call site that reaches getBBox in the vendor (cluster hull
// labels, group captions, the label-cull obstacle collector) is wrapped in
// its own try/catch and degrades gracefully on an unstubbed jsdom
// element -- confirmed by reading each site before writing this stub, so
// scoping it to `data-sc` elements only is deliberate, not an oversight.
class SyncFakeSimWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(_scriptURL?: unknown, _options?: unknown) {}
  postMessage(message: MainToWorkerMessage): void {
    if (message.type !== "start") return;
    const engine = createSimEngine(message as SimStartPayload);
    this.emit({ type: "tick", positions: engine.snapshot() });
    if (engine.done) {
      this.emit({ type: "end", positions: engine.snapshot() });
      return;
    }
    let done = false;
    while (!done) {
      done = engine.step();
      this.emit(done ? { type: "end", positions: engine.snapshot() } : { type: "tick", positions: engine.snapshot() });
    }
  }
  terminate(): void {
    this.onmessage = null;
  }
  private emit(message: WorkerToMainMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

// Same drain helper as d3-graph-vendor.remount.test.ts -- synchronously
// fast-forwards finishRenderAfterSettle's chunked tail (colors+hulls,
// nebula+watermarks, fit+Delaunay) instead of waiting on real/fake timers.
// This is what actually reaches drawWatermarks() after each render() call.
function flushSettleChunks(): void {
  const w = window as unknown as { __d3FlushSettleChunk?: () => boolean };
  for (let i = 0; i < 10 && w.__d3FlushSettleChunk?.(); i++) {
    // keep draining until nothing is left pending
  }
}

// Shared, test-controlled LOCAL box size every `g.watermark` element's
// getBBox() stub returns (see the file header comment above for why this
// is deliberately unrealistic and shared across every SC). Mutated
// between draws within a test to force the resolver's target to change --
// see installWatermarkGeometryStubs' own comment for the exact mechanism.
let watermarkBoxSize = { width: 5000, height: 250 };

function installWatermarkGeometryStubs(): void {
  (SVGElement.prototype as unknown as { getScreenCTM: () => DOMMatrix }).getScreenCTM = function (
    this: Element,
  ): DOMMatrix {
    const m = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(this.getAttribute("transform") || "");
    const tx = m ? parseFloat(m[1]) : 0;
    const ty = m ? parseFloat(m[2]) : 0;
    return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty } as DOMMatrix;
  };
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = function (this: Element): DOMRect {
    if (this.getAttribute("data-sc")) {
      return { x: 0, y: 0, width: watermarkBoxSize.width, height: watermarkBoxSize.height } as DOMRect;
    }
    // Matches real (unstubbed) jsdom: every other caller of getBBox in the
    // vendor wraps this in its own try/catch and degrades gracefully.
    throw new Error("getBBox not stubbed for this element (test scope)");
  };
}

function uninstallWatermarkGeometryStubs(): void {
  delete (SVGElement.prototype as unknown as { getScreenCTM?: unknown }).getScreenCTM;
  delete (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox;
}

function watermarkTransform(container: HTMLElement, keyword: string): string | null {
  const el = Array.from(container.querySelectorAll("g.watermark")).find(
    (n) => n.getAttribute("data-sc") === keyword,
  );
  return el ? el.getAttribute("transform") : null;
}

function parseTranslate(transform: string | null): { x: number; y: number } {
  const m = transform ? /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(transform) : null;
  return { x: m ? parseFloat(m[1]) : NaN, y: m ? parseFloat(m[2]) : NaN };
}

// Final fix wave (delta #32 companion fix, necessitated by wmGlideReset()
// now running per-settle -- see the "cliff" test's own comment below for
// why): reads the REAL current zoom scale off `.graph-root`'s own
// "translate(x,y) scale(k)" transform, set by genuine (unstubbed) d3-zoom
// machinery regardless of this file's getScreenCTM/getBBox stubs.
function currentZoomScale(container: HTMLElement): number {
  const root = container.querySelector(".graph-root");
  const t = (root && root.getAttribute("transform")) || "";
  const m = /scale\(([-\d.eE]+)\)/.exec(t);
  return m ? parseFloat(m[1]) : 1;
}

// One two-page cluster ("alpha") and one one-page cluster ("beta") per
// super-cluster -- drawWatermarks' own resolver sorts by member page count
// DESCENDING, so "alpha" is always placed first (kept at its anchored
// spot) and "beta" is always the one nudged off it. `keywordPrefix` keeps
// every test's data-sc keywords globally unique across this file: the
// vendor module is a singleton (imported once, module state persists for
// the life of the test run -- same class of shared-state concern
// d3-graph-vendor.remount.test.ts's own header comments document for
// selection/filter/expandedGroups), and delta #29's `__wmGlide` state map
// is keyed by keyword with no exposed reset -- unique keywords per test is
// what keeps one test's glide state from leaking into the next's, rather
// than needing to reach into unexported module internals to clear it.
function twoSuperClusterPayload(
  keywordPrefix: string,
  opts?: { includeBeta?: boolean; includeAlpha?: boolean },
): GraphPayload {
  const includeBeta = opts?.includeBeta ?? true;
  const includeAlpha = opts?.includeAlpha ?? true;
  const alphaKw = keywordPrefix + "-alpha";
  const betaKw = keywordPrefix + "-beta";

  const nodes: GraphPayload["nodes"] = [
    {
      id: keywordPrefix + "-page-a1",
      label: "Alpha One",
      level: 0,
      kind: "cluster",
      visit_count: 1,
      parent_id: keywordPrefix + "-ca",
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/a1"],
      first_visited_at: null,
    },
    {
      id: keywordPrefix + "-page-a2",
      label: "Alpha Two",
      level: 0,
      kind: "cluster",
      visit_count: 1,
      parent_id: keywordPrefix + "-ca",
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/a2"],
      first_visited_at: null,
    },
    {
      id: keywordPrefix + "-page-b1",
      label: "Beta One",
      level: 0,
      kind: "cluster",
      visit_count: 1,
      parent_id: keywordPrefix + "-cb",
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/b1"],
      first_visited_at: null,
    },
  ];

  const clusters: GraphCluster[] = [
    {
      id: keywordPrefix + "-ca",
      name: "Cluster Alpha",
      page_ids: [keywordPrefix + "-page-a1", keywordPrefix + "-page-a2"],
      super_cluster: alphaKw,
    },
    {
      id: keywordPrefix + "-cb",
      name: "Cluster Beta",
      page_ids: [keywordPrefix + "-page-b1"],
      super_cluster: betaKw,
    },
  ];

  const superClusters: GraphSuperCluster[] = [];
  if (includeAlpha) {
    superClusters.push({ keyword: alphaKw, icon_id: "icon-" + alphaKw });
  }
  if (includeBeta) {
    superClusters.push({ keyword: betaKw, icon_id: "icon-" + betaKw });
  }

  return { nodes, links: [], clusters, super_clusters: superClusters, groups: [] };
}

function iconsFor(keywordPrefix: string): Record<string, IconEntry> {
  const icon: IconEntry = { label: "Test Icon", category: "Test", viewBox: "0 0 24 24", paths: ["M0 0 L1 1"] };
  return {
    ["icon-" + keywordPrefix + "-alpha"]: icon,
    ["icon-" + keywordPrefix + "-beta"]: icon,
  };
}

describe("d3-graph-vendor SC watermark nameplate glide (delta #29, logs/visual-debug/sc-watermark-zoom-jump)", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", SyncFakeSimWorker);
    // Pre-seeds a real --galaxy-0 custom property so render()'s own
    // retryColors() self-scheduling setTimeout loop finds one immediately
    // and never schedules a timer -- same rationale as the remount test's
    // own beforeEach, load-bearing here too since fake timers are active
    // for this whole suite (see below) and a stray retryColors timer would
    // otherwise sit in the fake queue and confuse the glide-draining loop.
    document.documentElement.style.setProperty("--galaxy-0", "#4e79a7");
    installWatermarkGeometryStubs();
    watermarkBoxSize = { width: 5000, height: 250 };
    // Final fix wave: "requestAnimationFrame" joins the fake set (same fix
    // d3-graph-vendor.sc-separation.test.ts's own beforeEach already
    // applies, see that file's comment). jsdom (this project's vitest
    // environment) DOES define a real requestAnimationFrame -- contrary to
    // this describe block's original comment here, which assumed
    // __wmRafSchedule always fell back to its own `setTimeout(cb, 16)` --
    // but that real rAF is wired to genuine wall-clock time, independent of
    // vi's fake setTimeout/performance. Every EXISTING test in this file
    // happened to never need more than one or two SYNCHRONOUS
    // drawWatermarks application-pass steps to land within
    // WM_GLIDE_SNAP_PX (each full `render()` cycle reaches drawWatermarks
    // 2-3 times synchronously on its own), so the untamed real rAF
    // continuation never got a chance to matter -- until the final fix
    // wave's "cliff" test rewrite (below) needed a SINGLE same-settle
    // zoom-triggered redraw to glide across multiple animation frames:
    // without faking requestAnimationFrame too, `wmGlideStep`'s
    // continuation depends on real wall-clock rAF ticks that
    // `vi.advanceTimersByTimeAsync` cannot drive, so the polling loop
    // below would observe a stale, non-converged reading as "converged"
    // (two consecutive fake-time reads happening to land between real rAF
    // ticks). Faking `performance` too makes the glide's own
    // `performance.now()` dt computation advance in lockstep with fake
    // time, which is what makes "advance N ms, read the DOM" deterministic
    // instead of racing real wall-clock time (contrast with the V2 describe
    // block in the remount test file, which waits on a REAL d3 transition
    // timer via real elapsed time -- this delta's glide has no such
    // external timer to wait on, so faking is both possible and simpler).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "requestAnimationFrame"] });
  });

  afterEach(() => {
    flushSettleChunks();
    vi.useRealTimers();
    uninstallWatermarkGeometryStubs();
    document.documentElement.style.removeProperty("--galaxy-0");
    vi.unstubAllGlobals();
  });

  it("first-ever draw snaps the pushed plate directly to the resolver's target (nothing to glide from yet)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const kw = "snap-test";

    render(container, twoSuperClusterPayload(kw), { icons: iconsFor(kw) });
    flushSettleChunks();

    // "beta" (fewer pages) is always the one the resolver nudges off
    // "alpha"'s anchored spot (see twoSuperClusterPayload's own comment).
    // A generously large, shared getBBox box size guarantees a genuine,
    // large (thousands-of-units) overlap resolution here regardless of the
    // real (tiny) simulated centroid gap.
    const betaTransform = watermarkTransform(container, kw + "-beta");
    expect(betaTransform).not.toBeNull();
    const applied = parseTranslate(betaTransform);
    expect(Number.isFinite(applied.x) && Number.isFinite(applied.y)).toBe(true);
    // The displacement is large -- confirms a real overlap was actually
    // resolved, not a coincidental near-zero push.
    expect(Math.abs(applied.x) + Math.abs(applied.y)).toBeGreaterThan(500);

    // Advancing time further must not move it by anything CLOSE to the
    // magnitude of the displacement itself: a first-ever draw has no
    // previous offset to glide FROM, so wmGlideStepOffset's `!prevOffset`
    // branch snaps unconditionally on the very first call for this
    // keyword. (Exact byte-for-byte equality doesn't hold here: one
    // render() call reaches drawWatermarks twice internally -- once from
    // finishRenderAfterSettle's own chunk 2, and again from the zoom
    // transform fitToContent applies during chunk 3, which lands on a
    // slightly different `currentZoomK` and so a slightly different
    // world<->screen conversion -- so the SECOND of those two calls sees
    // a real, if tiny, `prevOffset` and takes one small bounded glide
    // step. The bound below (50 units, on a displacement of 500+) is
    // sized to catch the bug this test guards against -- gliding the
    // FULL distance up from an assumed-zero starting offset -- while
    // tolerating that unrelated sub-pixel-scale settling.)
    await vi.advanceTimersByTimeAsync(1000);
    const afterSettle = parseTranslate(watermarkTransform(container, kw + "-beta"));
    const drift = Math.abs(afterSettle.x - applied.x) + Math.abs(afterSettle.y - applied.y);
    expect(drift).toBeLessThan(50);
  });

  it("a target cliff glides instead of teleporting, then converges to exactly the new stateless target and stops", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const kw = "cliff-test";
    const icons = iconsFor(kw);

    // Draw 1: wide/short box -- forces the resolver's minimum-penetration
    // axis to be VERTICAL (dDown/dUp), since the box's vertical extent
    // (height) is far smaller than its horizontal extent regardless of the
    // real (small, uncontrolled) anchor gap -- see the resolver's own
    // dDown/dUp/dRight/dLeft formulas (vendor :3762-3765): each pair's SUM
    // is a constant (~2*height or ~2*width), so whichever pair has the
    // smaller box dimension wins the Math.min, independent of exactly
    // where the tiny simulated payload settled.
    // height 250 -> 400 (delta #32): applyScLayoutSeparation now runs
    // BEFORE this resolver and, for this exact two-cluster payload,
    // deterministically widens alpha/beta's vertical anchor gap from ~198
    // to ~344 world units (its own estimated-footprint budget, unrelated
    // to this stub's box) -- at height 250 the two plates no longer
    // overlap at all post-correction, so the resolver found nothing to
    // resolve and this test's whole premise (a genuine push to diff
    // against) went silently vacuous. 400 restores real vertical overlap
    // with headroom while keeping the box far wider than tall.
    watermarkBoxSize = { width: 5000, height: 400 };
    render(container, twoSuperClusterPayload(kw), { icons });
    flushSettleChunks();
    const target1 = parseTranslate(watermarkTransform(container, kw + "-beta"));
    // Fully converged already (first-ever draw always snaps, see the
    // sibling test above) -- this IS the resolver's raw target 1, read
    // empirically rather than hand-computed.
    const applied1 = target1;

    // Draw 2: tall/narrow box -- flips the winning axis to HORIZONTAL
    // (dRight/dLeft), the same "axis flip" shape the real bug's temporal
    // CDP capture measured (a pinch-cycle cliff or an icon-fade footprint
    // cliff both manifest as the resolver's target jumping by a large,
    // structurally different displacement between one tick and the next).
    // Final fix wave: forced via a same-settle zoom-triggered redraw
    // (__d3ZoomTo at the CURRENT k -- d3-zoom's imperative `.transform()`
    // setter dispatches 'zoom' [and therefore drawWatermarks] regardless
    // of whether the value changed, same technique
    // d3-graph-vendor.sc-separation.test.ts's exile-clamp test uses), NOT
    // a second `render()` call. delta #32's final fix wave added
    // wmGlideReset() to the top of applyScLayoutSeparation (a NEW layout
    // -- i.e. a new settle -- must snap, not glide, from the PREVIOUS
    // layout's positions): a second `render()` is itself a new settle, so
    // it now wipes the very glide state this assertion needs to still be
    // present. A zoom-triggered redraw matches what this file's own
    // header names as the real bug (logs/visual-debug/sc-watermark-zoom-
    // jump) and never touches applyScLayoutSeparation/wmGlideReset() at
    // all, so draw 1's glide state survives into this cliff exactly as
    // this assertion requires. The anchors themselves are untouched (no
    // re-simulation), isolating the resolver's box-orientation flip as
    // the only thing that changed.
    watermarkBoxSize = { width: 200, height: 5000 };
    const kNow = currentZoomScale(container);
    expect((window as unknown as { __d3ZoomTo?: (k: number) => boolean }).__d3ZoomTo!(kNow)).toBe(true);

    // Immediately after draw 2 (before any glide rAF frame has run), the
    // painted transform must NOT already be at the new target -- it must
    // be a single bounded exponential step away from applied1, i.e.
    // strictly between applied1 and wherever draw 2's target actually is.
    const appliedRightAfterDraw2 = parseTranslate(watermarkTransform(container, kw + "-beta"));

    // Drive the glide to completion: advance fake time in a bounded loop
    // until the painted transform stops changing (WM_GLIDE_TAU_MS is 90ms
    // and WM_GLIDE_SNAP_PX is sub-pixel, so this converges in well under
    // the 3.2s ceiling below for any realistic zoom k).
    let converged = parseTranslate(watermarkTransform(container, kw + "-beta"));
    let prevRead = converged;
    for (let i = 0; i < 200; i++) {
      await vi.advanceTimersByTimeAsync(16);
      const now = parseTranslate(watermarkTransform(container, kw + "-beta"));
      if (now.x === prevRead.x && now.y === prevRead.y) {
        converged = now;
        break;
      }
      prevRead = now;
      converged = now;
    }

    // Assertion 2 (the discriminating one): the reading taken right after
    // draw 2 was strictly between the pre-cliff applied position and the
    // eventual converged position -- proof the glide actually ran a
    // bounded step instead of either staying frozen at applied1 (no glide
    // at all) or already sitting at the fully-converged target (no bound
    // applied -- i.e. the pre-fix teleport).
    // The per-axis gate is 1.0 world unit, NOT a float epsilon: the
    // non-cliff axis can drift by a tiny amount between draws (the force
    // sim re-runs with unseeded Math.random), and for a drift in the
    // window just above a float epsilon the single bounded step rounds to
    // one of the bounds in the transform-attribute string round-trip --
    // strictly-between then fails with exact boundary equality (observed
    // as a rare full-suite flake, 2026-08-10). The forced cliff axis
    // moves thousands of units, so a 1.0 gate keeps the discriminating
    // assertion while never asserting on round-trip noise.
    const changedX = Math.abs(converged.x - applied1.x) > 1.0;
    const changedY = Math.abs(converged.y - applied1.y) > 1.0;
    expect(changedX || changedY).toBe(true); // the cliff produced a genuinely different target

    if (changedX) {
      const lo = Math.min(applied1.x, converged.x);
      const hi = Math.max(applied1.x, converged.x);
      expect(appliedRightAfterDraw2.x).toBeGreaterThan(lo);
      expect(appliedRightAfterDraw2.x).toBeLessThan(hi);
    }
    if (changedY) {
      const lo = Math.min(applied1.y, converged.y);
      const hi = Math.max(applied1.y, converged.y);
      expect(appliedRightAfterDraw2.y).toBeGreaterThan(lo);
      expect(appliedRightAfterDraw2.y).toBeLessThan(hi);
    }

    // Assertion 3a: `converged` really is the resolver's stateless TARGET
    // for draw 2's configuration, not merely "wherever the glide happened
    // to stop moving" (which stability alone, checked in 3b below, cannot
    // distinguish from a bug that snaps prematurely for an unrelated
    // reason). Independently re-derive the target by redrawing with the
    // IDENTICAL box size again (draw 3) -- the resolver is a stateless
    // function of the current geometry, so this recomputes the same target
    // from scratch, with no dependency on the glide's own history: if the
    // recomputed target and the prior offset are already within
    // WM_GLIDE_SNAP_PX, this draw snaps straight to it (see
    // wmGlideStepOffset's own `!prevOffset` / snap-epsilon branches), so
    // draw 3's OWN painted transform right after this flush IS that
    // independently recomputed target. A generous absolute bound (well
    // under 1% of the ~5000-unit cliff magnitude this test forces) is used
    // rather than a tight decimal-place comparison -- draw 3 re-runs the
    // force simulation from scratch, so a few-unit difference from
    // re-simulating (not from the glide) is expected and not the thing
    // being tested here.
    render(container, twoSuperClusterPayload(kw), { icons }); // same width/height as draw 2
    flushSettleChunks();
    const independentTarget = parseTranslate(watermarkTransform(container, kw + "-beta"));
    const targetDrift =
      Math.abs(independentTarget.x - converged.x) + Math.abs(independentTarget.y - converged.y);
    expect(targetDrift).toBeLessThan(25);

    // Assertion 3b: the rAF loop terminates. NOT asserted as equality to
    // `independentTarget`: when the re-simulation drift between draw 2 and
    // draw 3 exceeds the SCREEN-space snap epsilon (0.5px / k), draw 3
    // legitimately GLIDES to its slightly-shifted target instead of
    // snapping, so the post-flush read above is a mid-glide position --
    // exact equality against it flakes with the size of the unseeded
    // Math.random sim drift (observed 2026-08-10, ~25% of full-suite
    // runs). Assert the two things 3b actually means: (1) after generous
    // extra time the plate is EXACTLY stationary across a further
    // advancement -- the loop stopped scheduling; (2) where it rests is
    // still the stateless target, within the same re-sim tolerance 3a
    // already uses.
    // Quiescence POLL, not fixed windows: d3-timer keeps an unfaked
    // wake-up backstop (`setInterval(poke, 1000)` -- setInterval is
    // deliberately absent from this file's toFake list), so late
    // pipeline redraws (draw 3's fitToContent zoom transition) can be
    // pumped on REAL wall-clock time under full-suite load, landing
    // nondeterministically relative to any fixed fake-time read window
    // (observed as the residual full-suite flake, 2026-08-10: the plate
    // moved between a t+1000ms and a t+1500ms read -- impossible for the
    // glide itself, whose motion decays below the snap epsilon within
    // ~40 frames). Both endpoint states are deterministic and within
    // 3a's re-sim tolerance of the independently re-derived target; only
    // their ORDER vs the reads varies. So: advance fake time in 500ms
    // slabs until two consecutive reads are identical (true rest -- a
    // crawling glide cannot hold string-identical transforms across a
    // 500ms slab, it snaps below the epsilon first), bounded at 5s of
    // fake time. Termination of the rAF loop is asserted by quiescence
    // being reachable at all; where the plate rests is asserted against
    // the stateless target under the same tolerance 3a uses.
    let prevRest = parseTranslate(watermarkTransform(container, kw + "-beta"));
    let quiescent = false;
    for (let i = 0; i < 10 && !quiescent; i++) {
      await vi.advanceTimersByTimeAsync(500);
      const cur = parseTranslate(watermarkTransform(container, kw + "-beta"));
      quiescent = cur.x === prevRest.x && cur.y === prevRest.y;
      prevRest = cur;
    }
    expect(quiescent).toBe(true);
    const restDrift =
      Math.abs(prevRest.x - independentTarget.x) + Math.abs(prevRest.y - independentTarget.y);
    expect(restDrift).toBeLessThan(25);
  });

  it("a keyword absent from a later draw is pruned -- reappearing later snaps instead of gliding from the stale offset", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const kw = "prune-test";
    const icons = iconsFor(kw);

    // Draw 1: both SCs present, wide/short box -- seeds real prior glide
    // state for "beta" (same shape as the cliff test's draw 1; see that
    // test's own comment for why height is 400, not the original 250 --
    // delta #32's applyScLayoutSeparation widens this payload's vertical
    // anchor gap past 250 before the resolver ever runs).
    watermarkBoxSize = { width: 5000, height: 400 };
    render(container, twoSuperClusterPayload(kw), { icons });
    flushSettleChunks();
    const seeded = parseTranslate(watermarkTransform(container, kw + "-beta"));
    expect(watermarkTransform(container, kw + "-beta")).not.toBeNull();

    // Draw 2: "beta"'s super-cluster entry is dropped entirely (its
    // cluster keeps a super_cluster field pointing at a keyword that no
    // longer resolves to any super_clusters[] entry -- drawWatermarks'
    // own `if (!sc || !sc.icon_id) continue;` guard skips it, so no
    // g.watermark element is created for it this draw at all) -- this is
    // what the application pass's pruning loop (delta #29) must react to.
    render(container, twoSuperClusterPayload(kw, { includeBeta: false }), { icons });
    flushSettleChunks();
    expect(watermarkTransform(container, kw + "-beta")).toBeNull();

    // Draw 3: "beta" reappears, with a tall/narrow box -- the SAME
    // magnitude of axis-flip cliff the sibling "cliff" test proved DOES
    // produce a multi-frame glide when there's real prior state to glide
    // from. If pruning failed to clear "beta"'s entry during draw 2, this
    // draw would glide from the stale `seeded` offset toward this new
    // target instead of snapping -- i.e. this reading would still be
    // changing on the next several time-advances, exactly like the cliff
    // test's `appliedRightAfterDraw2`.
    watermarkBoxSize = { width: 200, height: 5000 };
    render(container, twoSuperClusterPayload(kw), { icons });
    flushSettleChunks();
    const reappeared = parseTranslate(watermarkTransform(container, kw + "-beta"));
    expect(Number.isFinite(reappeared.x) && Number.isFinite(reappeared.y)).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    const afterExtraTime = parseTranslate(watermarkTransform(container, kw + "-beta"));
    expect(afterExtraTime.x).toBe(reappeared.x);
    expect(afterExtraTime.y).toBe(reappeared.y);

    // Belt-and-suspenders: prove the reappearance target is NOT close to
    // wherever draw 1 left it (otherwise "it never moved" would be a
    // vacuous pass rather than a real snap-vs-glide discrimination).
    const movedFromSeeded = Math.abs(reappeared.x - seeded.x) > 1 || Math.abs(reappeared.y - seeded.y) > 1;
    expect(movedFromSeeded).toBe(true);
  });

  // Companion to the single-keyword pruning test above: that one exercises
  // the application pass's own per-keyword pruning loop, which never runs
  // at all when EVERY super-cluster disappears at once -- drawWatermarks'
  // `if (!superClusters.length) return;` early-return bails before ever
  // reaching that loop. wmGlideReset() (delta #29) is what clears state on
  // THIS path instead. The sibling `if (!__mountedIcons) return;` early
  // return (icons not mounted yet) calls the exact same wmGlideReset()
  // helper -- not separately covered here, since it would be a byte-
  // identical assertion against a different trigger.
  it("all super_clusters disappearing at once resets glide state (not just a single pruned keyword)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const kw = "reset-test";
    const icons = iconsFor(kw);

    // Draw 1: both SCs present, wide/short box -- seeds real prior glide
    // state for "beta" (height 400, not 250 -- see the cliff test's own
    // comment: delta #32's applyScLayoutSeparation widens this payload's
    // vertical anchor gap past 250 before the resolver ever runs).
    watermarkBoxSize = { width: 5000, height: 400 };
    render(container, twoSuperClusterPayload(kw), { icons });
    flushSettleChunks();
    const seeded = parseTranslate(watermarkTransform(container, kw + "-beta"));
    expect(watermarkTransform(container, kw + "-beta")).not.toBeNull();

    // Draw 2: zero super_clusters at all -- hits drawWatermarks' own
    // `if (!superClusters.length) return;` early return, which must call
    // wmGlideReset() before bailing.
    render(container, twoSuperClusterPayload(kw, { includeAlpha: false, includeBeta: false }), { icons });
    flushSettleChunks();
    expect(watermarkTransform(container, kw + "-alpha")).toBeNull();
    expect(watermarkTransform(container, kw + "-beta")).toBeNull();

    // Draw 3: both reappear, with a tall/narrow box -- same axis-flip
    // cliff shape as the sibling tests. If wmGlideReset() failed to run
    // on draw 2, "beta" would glide from the stale `seeded` offset toward
    // this new target instead of snapping.
    watermarkBoxSize = { width: 200, height: 5000 };
    render(container, twoSuperClusterPayload(kw), { icons });
    flushSettleChunks();
    const reappeared = parseTranslate(watermarkTransform(container, kw + "-beta"));
    expect(Number.isFinite(reappeared.x) && Number.isFinite(reappeared.y)).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    const afterExtraTime = parseTranslate(watermarkTransform(container, kw + "-beta"));
    expect(afterExtraTime.x).toBe(reappeared.x);
    expect(afterExtraTime.y).toBe(reappeared.y);

    const movedFromSeeded = Math.abs(reappeared.x - seeded.x) > 1 || Math.abs(reappeared.y - seeded.y) > 1;
    expect(movedFromSeeded).toBe(true);
  });
});
