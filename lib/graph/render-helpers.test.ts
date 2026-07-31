import { afterEach, describe, expect, it } from "vitest";
import type { GraphCluster, GraphSuperCluster } from "@/lib/types";
import { GRAPH_DEFAULTS } from "./constants";
import {
  buildClusterColorMap,
  clampedScale,
  computeClusterPositionCentroids,
  computeHullLabelLayout,
  getGalaxyStops,
  hashId,
  hullLabelLineOffsets,
  hullLabelLodOpacity,
  labelColor,
  lerpHex,
  mulberry32,
  pageDotRadius,
  sampleMirrored,
  starGlyphOpacity,
  starVariant,
  wrapClusterLabel,
} from "./render-helpers";

// Batch 03 (graph canvas port) Task S3 -- pin the A2 sandbox's vendor-
// derived math against known-good outputs (mostly hand-checked against
// the vendor's own formulas, see this module's header comment for line
// refs), plus determinism, since useForceLayout.ts's whole reproducible-
// layout story depends on these PRNGs being stable across refactors.

afterEach(() => {
  // Tests that stamp --galaxy-N / --bg onto :root must not leak into
  // later tests (getGalaxyStops/bgLuminance both read live from
  // document.documentElement).
  const root = document.documentElement;
  [...root.style].forEach((prop) => {
    if (prop.startsWith("--")) root.style.removeProperty(prop);
  });
});

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces values in [0, 1)", () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 20; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("different seeds diverge", () => {
    const a = mulberry32(1)();
    const b = mulberry32(2)();
    expect(a).not.toBe(b);
  });
});

describe("hashId", () => {
  it("is deterministic and non-negative", () => {
    expect(hashId("cluster-1")).toBe(hashId("cluster-1"));
    expect(hashId("cluster-1")).toBeGreaterThanOrEqual(0);
  });

  it("differs across ids (no trivial collisions on small inputs)", () => {
    expect(hashId("a")).not.toBe(hashId("b"));
  });
});

describe("clampedScale", () => {
  // GRAPH_DEFAULTS.SCALE_THRESHOLDS.pageDot
  const thresholds = { k_min: 0.9, k_max: 2.1 };

  // Review finding 1 (critical): the vendor divides by the ABSOLUTE zoomK
  // (:537 `return effRatio / zoomK;`), not by the ratio -- these cases were
  // previously written against the wrong (effRatio/ratio) formula, which
  // this test file itself pinned as "correct." Re-derived against the
  // vendor's actual :528-538 line-by-line.

  it("at fit (zoomK === fitZoom), returns effRatio/zoomK -- 1 inside the band", () => {
    // ratio = 2/2 = 1, inside [0.9, 2.1] -> effRatio = 1 -> 1/zoomK(2) = 0.5
    expect(clampedScale(2, 2, thresholds)).toBeCloseTo(0.5, 10);
    // ratio = 1/1 = 1 -> effRatio = 1 -> 1/zoomK(1) = 1
    expect(clampedScale(1, 1, thresholds)).toBeCloseTo(1, 10);
  });

  it("floors below k_min, then divides by the absolute zoomK", () => {
    // zoomK=0.3, fitZoom=1 -> ratio 0.3 -> effRatio clamps to 0.9 -> 0.9 / zoomK(0.3) = 3
    expect(clampedScale(0.3, 1, thresholds)).toBeCloseTo(3, 10);
  });

  it("caps above k_max, then divides by the absolute zoomK", () => {
    // zoomK=4.2, fitZoom=1 -> ratio 4.2 -> effRatio clamps to 2.1 -> 2.1 / zoomK(4.2) = 0.5
    expect(clampedScale(4.2, 1, thresholds)).toBeCloseTo(0.5, 10);
  });

  it("dividing by absolute zoomK (not ratio) means equal ratios at different zoom levels diverge", () => {
    // Both have ratio 1 (inside the band, effRatio=1), but different zoomK
    // -> the CRITICAL bug this finding fixes: these must NOT be equal.
    const atZoomK1 = clampedScale(1, 1, thresholds);
    const atZoomK2 = clampedScale(2, 2, thresholds);
    expect(atZoomK1).not.toBeCloseTo(atZoomK2, 5);
    expect(atZoomK1).toBeCloseTo(1, 10);
    expect(atZoomK2).toBeCloseTo(0.5, 10);
  });

  it("returns 1.0 when fitZoom<=0 or zoomK<=0 (vendor's :529 guard)", () => {
    expect(clampedScale(1, 0, thresholds)).toBe(1.0);
    expect(clampedScale(1, -1, thresholds)).toBe(1.0);
    expect(clampedScale(0, 1, thresholds)).toBe(1.0);
    expect(clampedScale(-1, 1, thresholds)).toBe(1.0);
  });
});

describe("pageDotRadius", () => {
  it("shrinks singleton dots to 0.85x a regular dot at the same zoomK/fitZoom", () => {
    const regular = pageDotRadius("cluster", 1, 1);
    const singleton = pageDotRadius("singleton", 1, 1);
    expect(singleton).toBeCloseTo(regular * 0.85, 10);
  });

  it("is BASE_PAGE_DOT_SIZE at zoomK===fitZoom===1 (inside the pageDot band)", () => {
    expect(pageDotRadius("cluster", 1, 1)).toBeCloseTo(1.5, 10); // GRAPH_DEFAULTS.BASE_PAGE_DOT_SIZE
  });

  it("screen-clamps to BASE_PAGE_DOT_SIZE/fitZoom at fit zoom (critical fix: not BASE_PAGE_DOT_SIZE flat)", () => {
    // At fit, zoomK === fitZoom, ratio 1 is inside the pageDot band
    // [0.9, 2.1] -> effRatio=1 -> world radius = BASE * (1/zoomK) = BASE/fitZoom.
    // This is what actually paints on screen: world_radius * fitZoom = BASE
    // screen px, regardless of what fitZoom itself is -- the whole point
    // of screen-clamping. The pre-fix formula (effRatio/ratio) instead
    // returned a CONSTANT BASE_PAGE_DOT_SIZE world radius regardless of
    // fitZoom, which paints at BASE*fitZoom screen px -- wrong by a factor
    // of fitZoom (e.g. ~2.4x too small at this app's live fit scale ~0.41).
    const fitZoom = 0.4097;
    const worldRadius = pageDotRadius("cluster", fitZoom, fitZoom);
    expect(worldRadius).toBeCloseTo(1.5 / fitZoom, 10);
    const screenPx = worldRadius * fitZoom;
    expect(screenPx).toBeCloseTo(1.5, 10);
  });
});

describe("starVariant", () => {
  it("is deterministic and in [0, 3]", () => {
    for (const id of ["page-1", "page-2", "some-long-page-id-abc"]) {
      const v = starVariant(id);
      expect(v).toBe(starVariant(id));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(3);
    }
  });
});

describe("starGlyphOpacity", () => {
  it("is the base multiplier at visit_count 1 (or undefined)", () => {
    // STAR_GLYPH_OPACITY_MULT * min(1, 0.78 + 0.08*min(3, 0)) = 0.35 * 0.78
    expect(starGlyphOpacity(1)).toBeCloseTo(0.35 * 0.78, 10);
    expect(starGlyphOpacity(undefined)).toBeCloseTo(0.35 * 0.78, 10);
  });

  it("caps out at visit_count 4+ (min(3, v-1) saturates)", () => {
    expect(starGlyphOpacity(4)).toBeCloseTo(starGlyphOpacity(10), 10);
    expect(starGlyphOpacity(4)).toBeCloseTo(0.35, 10); // 0.78 + 0.08*3 = 1.02 -> min(1, ...) = 1
  });
});

describe("wrapClusterLabel", () => {
  it("keeps a short name on one line", () => {
    expect(wrapClusterLabel("Short Name")).toEqual(["Short Name"]);
  });

  it("wraps at the 18-char limit on word boundaries", () => {
    const lines = wrapClusterLabel("Electronics And Arduino Projects");
    expect(lines.length).toBeGreaterThan(1);
    lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(24)); // one long word can still exceed 18
    expect(lines.join(" ")).toBe("Electronics And Arduino Projects");
  });
});

describe("computeHullLabelLayout", () => {
  const cluster: GraphCluster = { id: "c1", name: "Test Cluster", page_ids: ["p1", "p2", "p3"] };

  it("returns null for fewer than 2 member points (vendor's hullData gate)", () => {
    expect(computeHullLabelLayout(cluster, [])).toBeNull();
    expect(computeHullLabelLayout(cluster, [[0, 0]])).toBeNull();
  });

  it("anchors x at the member centroid and y above the 10th-percentile top", () => {
    const points: Array<[number, number]> = [
      [0, 100],
      [10, 80],
      [-10, 90],
    ];
    const layout = computeHullLabelLayout(cluster, points);
    expect(layout).not.toBeNull();
    expect(layout!.x).toBeCloseTo(0, 10); // (0+10-10)/3
    // ys sorted: [80,90,100]; 10th percentile index = floor(3*0.1) = 0 -> 80
    // anchorY = 80 - 16 - 2 - 0 = 62 (single line, lines.length-1 == 0)
    expect(layout!.y).toBeCloseTo(62, 10);
    expect(layout!.lines).toEqual(["Test Cluster"]);
    expect(layout!.pageCount).toBe(3);
    expect(layout!.isSuperClusterLike).toBe(false);
    // vendor :4456 `clusterTopY: effectiveTop` -- the RAW 10th-percentile
    // top, before the gap/line-count adjustment baked into `y` above.
    // Consumed by Zoom.tsx's applyLabelStyles (review finding 2).
    expect(layout!.clusterTopY).toBeCloseTo(80, 10);
  });

  it("flags super-cluster members", () => {
    const scCluster: GraphCluster = { ...cluster, super_cluster: "space" };
    const layout = computeHullLabelLayout(scCluster, [
      [0, 0],
      [1, 1],
    ]);
    expect(layout!.isSuperClusterLike).toBe(true);
  });
});

// Review round 2, finding 1: this pins hullLabelLineOffsets against a
// hand-derived reproduction of the vendor's updateLabelScale formula
// (:1319-1357), independent of the function under test, at a NON-1 fitZoom
// -- round 1's coverage only ever exercised the font-size half of this
// geometry (never the tspan y offsets specifically, and never off the
// ratio=1 "at fit" case), which is exactly how the write-fight regression
// slipped through review.
describe("hullLabelLineOffsets", () => {
  it("matches the vendor's newCenterY/startY formula (clLabel, non-SC) at a non-1 ratio", () => {
    const zoomK = 1.7;
    const fitZoom = 1.0; // ratio 1.7 -- inside clLabel's [1.25, 2.0] band, so effRatio = ratio (no clamp)
    const lineCount = 3;

    const offsets = hullLabelLineOffsets(lineCount, zoomK, fitZoom, false);

    // Hand-reproduced vendor arithmetic (:1332-1350), with clusterTopY=0
    // substituted in directly (not via clampedScale/the function under
    // test) so this is an independent check, not a tautology.
    const { k_min, k_max } = GRAPH_DEFAULTS.SCALE_THRESHOLDS.clLabel;
    const ratio = zoomK / fitZoom;
    const effRatio = Math.min(k_max, Math.max(k_min, ratio));
    const scale = effRatio / zoomK; // vendor clampedScale, :537
    const baseSize = GRAPH_DEFAULTS.BASE_LABEL_FONT_SIZE;
    const lineH = baseSize * 1.2 * scale; // vendor :1336
    const gap = 16 * scale; // vendor :1337 (LABEL_TO_CLUSTER_GAP)
    const newCenterY = 0 - gap - 2 - (lineCount - 1) * (lineH / 2); // vendor :1349
    const startY = newCenterY - ((lineCount - 1) * lineH) / 2;
    const expected = [0, 1, 2].map((i) => startY + i * lineH);

    offsets.forEach((y, i) => expect(y).toBeCloseTo(expected[i], 10));
  });

  it("matches the vendor's formula (scLabel, SC-like) at the k_max clamp ceiling", () => {
    const zoomK = 10; // far past scLabel's k_max=2.0 -- exercises the clamp
    const fitZoom = 1.0;
    const lineCount = 2;

    const offsets = hullLabelLineOffsets(lineCount, zoomK, fitZoom, true);

    const { k_max } = GRAPH_DEFAULTS.SCALE_THRESHOLDS.scLabel;
    const scale = k_max / zoomK; // ratio (10) exceeds k_max, so effRatio saturates at k_max
    const baseSize = GRAPH_DEFAULTS.BASE_SC_LABEL_FONT_SIZE;
    const lineH = baseSize * 1.2 * scale;
    const gap = 16 * scale;
    const newCenterY = 0 - gap - 2 - (lineCount - 1) * (lineH / 2);
    const startY = newCenterY - ((lineCount - 1) * lineH) / 2;
    const expected = [0, 1].map((i) => startY + i * lineH);

    offsets.forEach((y, i) => expect(y).toBeCloseTo(expected[i], 10));
  });

  it("is independent of clusterTopY by construction -- callers add clusterTopY separately via a transform", () => {
    // The whole point of factoring this out (see the function's own
    // doc comment): its return value must NOT depend on the cluster's
    // live position, only on lineCount/isSC/zoomK/fitZoom -- calling it
    // twice with the same scale inputs must be byte-identical regardless
    // of how many times a caller has re-rendered in between (this is what
    // lets React own clusterTopY exclusively without a write-fight).
    const a = hullLabelLineOffsets(2, 1.6, 1.0, false);
    const b = hullLabelLineOffsets(2, 1.6, 1.0, false);
    expect(a).toEqual(b);
  });
});

describe("hullLabelLodOpacity", () => {
  it("is fully opaque when page count clears the threshold", () => {
    // ratio 1 -> threshold = 2.5 / 1^2 = 2.5; a 5-page cluster clears it
    expect(hullLabelLodOpacity(5, 1)).toBe(1);
  });

  it("fades out entirely once below threshold - LOD_FADE_RANGE", () => {
    // threshold 2.5, fade range 1.3 -> anything <= 2.5-1.3=1.2 pages is 0
    expect(hullLabelLodOpacity(1, 1)).toBe(0);
  });

  it("interpolates in the fade band", () => {
    // 2-page cluster: below = 2.5 - 2 = 0.5; op = 1 - 0.5/1.3
    expect(hullLabelLodOpacity(2, 1)).toBeCloseTo(1 - 0.5 / 1.3, 10);
  });
});

describe("color helpers", () => {
  it("lerpHex interpolates channel-wise", () => {
    expect(lerpHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(lerpHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(lerpHex("#000000", "#ffffff", 1)).toBe("#ffffff");
  });

  it("sampleMirrored wraps seamlessly at the 0/1 boundary", () => {
    const stops = ["#000000", "#ffffff"];
    expect(sampleMirrored(stops, 0)).toBe(lerpHex(stops[0], stops[1], 0));
    // At t=1 the mirrored pass has folded all the way back to the start.
    expect(sampleMirrored(stops, 1)).toBe(sampleMirrored(stops, 0));
  });

  it("getGalaxyStops falls back to a single neutral when no CSS vars are set", () => {
    const stops = getGalaxyStops();
    expect(stops.length).toBe(1);
    expect(stops[0]).toMatch(/^#[0-9a-f]{3,6}$/i);
  });

  it("getGalaxyStops reads --galaxy-N in order until one is missing", () => {
    document.documentElement.style.setProperty("--galaxy-0", "#111111");
    document.documentElement.style.setProperty("--galaxy-1", "#222222");
    // --galaxy-2 intentionally absent.
    expect(getGalaxyStops()).toEqual(["#111111", "#222222"]);
  });

  it("labelColor relights dark-bg text lighter than light-bg text for the same hue", () => {
    document.documentElement.style.setProperty("--bg", "#000000"); // dark
    const darkResult = labelColor("#4488ff");
    document.documentElement.style.setProperty("--bg", "#ffffff"); // light
    const lightResult = labelColor("#4488ff");
    // Dark-bg labels are relit lighter (l=0.8) than light-bg labels (l=0.25).
    const luminanceOf = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return (r + g + b) / 3;
    };
    expect(luminanceOf(darkResult)).toBeGreaterThan(luminanceOf(lightResult));
  });
});

describe("buildClusterColorMap", () => {
  it("gives every super-cluster member the same color as its siblings", () => {
    const clusters: GraphCluster[] = [
      { id: "c1", name: "A", page_ids: ["p1"], super_cluster: "space" },
      { id: "c2", name: "B", page_ids: ["p2"], super_cluster: "space" },
      { id: "c3", name: "C", page_ids: ["p3"] },
    ];
    const superClusters: GraphSuperCluster[] = [{ keyword: "space", icon_id: null }];
    const centroids = new Map([
      ["c1", { x: 0, y: 0 }],
      ["c2", { x: 100, y: 0 }],
      ["c3", { x: -100, y: 0 }],
    ]);
    const colorMap = buildClusterColorMap(clusters, superClusters, centroids);
    expect(colorMap.get("c1")).toBe(colorMap.get("c2"));
    expect(colorMap.size).toBe(3);
  });

  it("falls back to a mid-gradient sample when a cluster has no centroid", () => {
    const clusters: GraphCluster[] = [{ id: "c1", name: "A", page_ids: [] }];
    const colorMap = buildClusterColorMap(clusters, [], new Map());
    expect(colorMap.get("c1")).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("computeClusterPositionCentroids", () => {
  it("averages member node positions", () => {
    const clusters: GraphCluster[] = [{ id: "c1", name: "A", page_ids: ["p1", "p2"] }];
    const positions = new Map([
      ["p1", { x: 0, y: 0 }],
      ["p2", { x: 10, y: 20 }],
    ]);
    const centroids = computeClusterPositionCentroids(clusters, positions);
    expect(centroids.get("c1")).toEqual({ x: 5, y: 10 });
  });

  it("omits clusters with no positioned members", () => {
    const clusters: GraphCluster[] = [{ id: "c1", name: "A", page_ids: ["missing"] }];
    const centroids = computeClusterPositionCentroids(clusters, new Map());
    expect(centroids.has("c1")).toBe(false);
  });
});
