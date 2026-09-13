/*
 * Almagest — glyph source of truth.
 *
 * Every glyph is a SKELETON: polylines on a 5x7 lattice (x 0..4, y 0..6 where
 * y=0 is the baseline and y=6 the cap height), plus optional lone dots.
 * Nothing here is an outline. Outlines are generated per optical-size tier by
 * outline() below: sight-lines become stroked rectangles, vertices become star
 * polygons, and the tier decides how big the stars are and how thick the lines.
 *
 * Edit THIS file to change a letter. Then re-run tools/build.js.
 *
 * Runs in Node (module.exports) and in a browser (globalThis.Almagest).
 */
(function (root) {
  'use strict';

  var XU = 120;          // one lattice step in x, font units (before tier width)
  var YU = 700 / 6;      // one lattice step in y — cap height 700 over 6 steps
  var UPEM = 1000;
  var CAP = 700;

  // ---------------------------------------------------------------- skeletons
  var G = {
    A: { p: [[[0,0],[2,6],[4,0]], [[1,2],[3,2]]] },
    B: { p: [[[0,0],[0,3],[0,6],[3,6],[4,5],[3,3],[0,3]], [[3,3],[4,2],[3,0],[0,0]]] },
    C: { p: [[[4,5],[3,6],[1,6],[0,4.5],[0,1.5],[1,0],[3,0],[4,1]]] },
    D: { p: [[[0,0],[0,6],[2,6],[4,4],[4,2],[2,0],[0,0]]] },
    E: { p: [[[4,6],[0,6],[0,3],[0,0],[4,0]], [[0,3],[3,3]]] },
    F: { p: [[[4,6],[0,6],[0,3],[0,0]], [[0,3],[3,3]]] },
    G: { p: [[[4,6],[1,6],[0,4.5],[0,1.5],[1,0],[3,0],[4,1.5],[4,3],[2,3]]] },
    H: { p: [[[0,6],[0,3],[0,0]], [[4,6],[4,3],[4,0]], [[0,3],[4,3]]] },
    I: { p: [[[2,6],[2,0]], [[1,6],[3,6]], [[1,0],[3,0]]], w: 2.2 },
    J: { p: [[[3,6],[3,1],[2,0],[1,0],[0,1]]] },
    K: { p: [[[0,6],[0,2.6],[0,0]], [[4,6],[0,2.6],[4,0]]] },
    L: { p: [[[0,6],[0,0],[4,0]]] },
    M: { p: [[[0,0],[0,6],[2,3],[4,6],[4,0]]] },
    N: { p: [[[0,0],[0,6],[4,0],[4,6]]] },
    O: { p: [[[1,6],[3,6],[4,4.5],[4,1.5],[3,0],[1,0],[0,1.5],[0,4.5],[1,6]]], w: 4.3 },
    P: { p: [[[0,0],[0,3],[0,6],[3,6],[4,5],[3,3],[0,3]]] },
    Q: { p: [[[1,6],[3,6],[4,4.5],[4,1.5],[3,0],[1,0],[0,1.5],[0,4.5],[1,6]], [[2.9,1.1],[4.2,-0.5]]], w: 4.3 },
    R: { p: [[[0,0],[0,3],[0,6],[3,6],[4,5],[3,3],[0,3]], [[2,3],[4,0]]] },
    S: { p: [[[4,5],[3,6],[1,6],[0,5],[1,3.5],[3,2.5],[4,1],[3,0],[1,0],[0,1]]] },
    T: { p: [[[0,6],[2,6],[4,6]], [[2,6],[2,0]]] },
    U: { p: [[[0,6],[0,1.5],[1,0],[3,0],[4,1.5],[4,6]]] },
    V: { p: [[[0,6],[2,0],[4,6]]] },
    W: { p: [[[0,6],[1,0],[2,4],[3,0],[4,6]]] },
    X: { p: [[[0,6],[2,3],[4,0]], [[4,6],[2,3],[0,0]]] },
    Y: { p: [[[0,6],[2,3],[4,6]], [[2,3],[2,0]]] },
    Z: { p: [[[0,6],[4,6],[0,0],[4,0]]] },
    '0': { p: [[[1,6],[3,6],[4,4.5],[4,1.5],[3,0],[1,0],[0,1.5],[0,4.5],[1,6]], [[1.2,1.7],[2.8,4.3]]], w: 4.3 },
    '1': { p: [[[0,4.6],[2,6],[2,0]], [[0.8,0],[3.2,0]]] },
    '2': { p: [[[0,5],[1,6],[3,6],[4,5],[4,4],[0,0],[4,0]]] },
    '3': { p: [[[0,5.4],[1,6],[3,6],[4,4.8],[2,3.2],[4,1.4],[3,0],[1,0],[0,0.6]]] },
    '4': { p: [[[3,0],[3,6],[0,2],[4,2]]] },
    '5': { p: [[[4,6],[0,6],[0,3.4],[3,3.4],[4,2.2],[3,0],[1,0],[0,0.6]]] },
    '6': { p: [[[3,6],[1,4.6],[0,2],[1,0],[3,0],[4,1.5],[3,3],[1,3],[0,2]]] },
    '7': { p: [[[0,6],[4,6],[1.4,0]]] },
    '8': { p: [[[2,6],[3.6,4.9],[2,3],[3.8,1.4],[2,0],[0.2,1.4],[2,3],[0.4,4.9],[2,6]]] },
    '9': { p: [[[1,0],[3,1.4],[4,4],[3,6],[1,6],[0,4.5],[1,3],[3,3],[4,4]]] },
    '.': { d: [[2,0]], w: 1.4 },
    ',': { p: [[[2,0.7],[1.3,-0.7]]], w: 1.5 },
    ':': { d: [[2,0],[2,3.4]], w: 1.4 },
    ';': { d: [[2,3.4]], p: [[[2,0.7],[1.3,-0.7]]], w: 1.5 },
    '!': { p: [[[2,6],[2,1.7]]], d: [[2,0]], w: 1.4 },
    '?': { p: [[[0,5],[1,6],[3,6],[4,5],[2,3],[2,2]]], d: [[2,0]] },
    '-': { p: [[[0.7,3],[3.3,3]]], w: 2.8 },
    '\u2013': { p: [[[0,3],[3.8,3]]], w: 3.8 },
    '\u2014': { p: [[[0,3],[4.8,3]]], w: 4.8 },
    '\u2212': { p: [[[0.2,3],[3.8,3]]], w: 3.8 },
    '+': { p: [[[0.3,3],[2,3],[3.7,3]], [[2,1.3],[2,3],[2,4.7]]], w: 4 },
    '=': { p: [[[0.3,3.9],[3.7,3.9]], [[0.3,2.1],[3.7,2.1]]], w: 4 },
    '*': { p: [[[2,3],[2,5.8]], [[0.6,3.6],[3.4,5.2]], [[3.4,3.6],[0.6,5.2]]], w: 4 },
    '%': { p: [[[1.05,5.9],[2.1,4.85],[1.05,3.8],[0,4.85],[1.05,5.9]], [[0.2,0.4],[3.9,5.6]], [[2.95,2.2],[4,1.15],[2.95,0.1],[1.9,1.15],[2.95,2.2]]], w: 4.2 },
    '$': { p: [[[3.6,4.9],[2.8,5.6],[1.2,5.6],[0.4,4.8],[1.2,3.5],[2.8,2.8],[3.6,1.5],[2.8,0.6],[1.2,0.6],[0.4,1.3]], [[2,6.4],[2,5.5]], [[2,0.5],[2,-0.4]]], w: 4 },
    '\u20ac': { p: [[[3.7,5.1],[2.7,6],[1,6],[0.2,4.4],[0.2,1.6],[1,0],[2.7,0],[3.7,0.9]], [[0,3.7],[3,3.7]], [[0,2.3],[3,2.3]]], w: 4 },
    "'": { p: [[[2,6],[2,4.6]]], w: 1.4 },
    '"': { p: [[[1.2,6],[1.2,4.6]], [[2.8,6],[2.8,4.6]]], w: 2.8 },
    '\u2018': { p: [[[1.6,6],[2.4,4.9]]], w: 1.6 },
    '\u2019': { p: [[[2.4,6],[1.6,4.9]]], w: 1.6 },
    '\u201c': { p: [[[0.8,6],[1.6,4.9]], [[2.4,6],[3.2,4.9]]], w: 3.2 },
    '\u201d': { p: [[[1.6,6],[0.8,4.9]], [[3.2,6],[2.4,4.9]]], w: 3.2 },
    '(': { p: [[[3,6],[1,4],[1,2],[3,0]]], w: 2.8 },
    ')': { p: [[[1,6],[3,4],[3,2],[1,0]]], w: 2.8 },
    '/': { p: [[[0,0],[3.6,6]]], w: 3.6 },
    '&': { p: [[[4,0],[1,4],[1,5],[2,6],[3,5],[3,4],[0,1.6],[1,0],[3,0],[4,1.4]]] },
    '\u2192': { p: [[[0,3],[4.2,3]], [[2.8,4.4],[4.2,3],[2.8,1.6]]], w: 4.4 },
    '\u2190': { p: [[[4.4,3],[0.2,3]], [[1.6,4.4],[0.2,3],[1.6,1.6]]], w: 4.4 },
    '\u2191': { p: [[[2,0],[2,6.2]], [[0.6,4.8],[2,6.2],[3.4,4.8]]], w: 4 },
    '\u2193': { p: [[[2,6],[2,-0.2]], [[0.6,1.2],[2,-0.2],[3.4,1.2]]], w: 4 }
  };

  var NOTDEF = { p: [[[0.4,0],[0.4,6],[3.6,6],[3.6,0],[0.4,0]]], w: 4, allPlain: true };

  // Diacritics live above cap height. They are always starless (see PLAIN note).
  var ACCENT = {
    acute:   { p: [[[1.5,6.6],[2.6,7.4]]] },
    grave:   { p: [[[2.6,6.6],[1.5,7.4]]] },
    tilde:   { p: [[[0.9,6.85],[1.6,7.35],[2.4,6.85],[3.1,7.35]]] },
    dia:     { d: [[1.2,7.0],[2.8,7.0]] },
    ring:    { p: [[[2,7.7],[2.6,7.1],[2,6.5],[1.4,7.1],[2,7.7]]] },
    cedilla: { p: [[[2,0],[2,-0.6],[1.2,-1.1]]] },
    circ:    { p: [[[1.1,6.8],[2,7.5],[2.9,6.8]]] }
  };

  // base letter + accent, cmapped at BOTH cases (the face is caps-only)
  var COMPOSITE = {
    '\u00e1': ['A','acute'], '\u00e4': ['A','dia'], '\u00e5': ['A','ring'], '\u00e7': ['C','cedilla'],
    '\u00e9': ['E','acute'], '\u00e8': ['E','grave'], '\u00ea': ['E','circ'], '\u00ed': ['I','acute'],
    '\u00f1': ['N','tilde'], '\u00f3': ['O','acute'], '\u00f6': ['O','dia'], '\u00fc': ['U','dia']
  };

  // Starless glyphs. Stars made these read as debris rather than as marks, so
  // punctuation / math / currency / arrows stay monoline at every tier — and
  // carry PLAIN_STROKE x the stroke weight to replace the brightness the stars
  // were contributing. Figures and base letters keep their stars.
  var PLAIN = ['.', ',', ':', ';', '!', '?', '-', '\u2013', '\u2014', '\u2212', '+', '=', '*', '%', '$',
    '\u20ac', "'", '"', '\u2018', '\u2019', '\u201c', '\u201d', '(', ')', '/', '&',
    '\u2192', '\u2190', '\u2191', '\u2193'];
  var PLAIN_STROKE = 1.24;
  var DOT_SIZE = 1.45;   // plain dot diameter = plain stroke * this

  // Pair kerning, in lattice units (multiplied by XU * width at build time).
  var KERN = { AV:-0.55, VA:-0.55, AT:-0.6, TA:-0.6, AW:-0.45, WA:-0.45, AY:-0.5, YA:-0.5, LT:-0.6,
    LY:-0.6, LV:-0.5, LW:-0.45, TO:-0.25, OT:-0.2, PA:-0.4, FA:-0.4, 'F.':-0.7, 'P.':-0.55, 'L.':-0.45,
    'T.':-0.75, 'Y.':-0.7, 'V.':-0.6, 'W.':-0.5, RT:-0.25, TY:-0.25, YT:-0.25, VY:-0.3, XY:-0.2,
    TW:-0.3, WT:-0.3, OA:-0.2, AO:-0.2, JA:-0.3, 'T,':-0.75, 'Y,':-0.7, 'V,':-0.6, AJ:-0.2, LO:-0.15,
    KO:-0.2, OX:-0.15 };

  // ------------------------------------------------------------------- tiers
  // FROZEN is what makes the LOD swap invisible: anything that moves a vertex
  // is identical in all three faces, so advance widths are byte-identical and a
  // tier change can never reflow, shift or re-break a line.
  var FROZEN = { width: 0.9, tracking: 100, sidebearing: 50, points: 5, rot: 50 };

  var TIERS = {
    Display: { min: 52, star: 190, contrast: 1.7, trim: 1, stroke: 27, pointiness: 0.61 },
    Mid:     { min: 10, star: 170, contrast: 1.5, trim: 1.1, stroke: 32, pointiness: 0.65 },
    Text:    { min: 0, star: 62, contrast: 1.06, trim: 0, stroke: 62, pointiness: 0.18 }
  };
  function tier(name) {
    var t = TIERS[name];
    if (!t) throw new Error('unknown tier: ' + name);
    var o = {}; for (var k in FROZEN) o[k] = FROZEN[k];
    for (var j in t) o[j] = t[j];
    return o;
  }

  // ------------------------------------------------------ normalised glyph set
  function spec(ch) {
    var g, accent = null;
    if (ch === '.notdef') { g = NOTDEF; }
    else if (COMPOSITE[ch]) { g = G[COMPOSITE[ch][0]]; accent = ACCENT[COMPOSITE[ch][1]]; }
    else { g = G[ch]; }
    if (!g) throw new Error('no skeleton for ' + ch);
    var allPlain = !!g.allPlain || PLAIN.indexOf(ch) >= 0;
    var lines = (g.p || []).map(function (pl) { return { pts: pl, plain: allPlain }; })
      .concat(accent ? (accent.p || []).map(function (pl) { return { pts: pl, plain: true }; }) : []);
    var dots = (g.d || []).map(function (p) { return { pt: p, plain: allPlain }; })
      .concat(accent ? (accent.d || []).map(function (p) { return { pt: p, plain: true }; }) : []);
    return { ch: ch, lines: lines, dots: dots, w: g.w };
  }

  // The glyph order of the compiled fonts. gid 0 .notdef, gid 1 space, then this.
  function glyphOrder() {
    var out = [{ ch: '.notdef', cps: [] }, { ch: ' ', cps: [0x20], space: true }];
    var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    letters.split('').forEach(function (c) {
      out.push({ ch: c, cps: [c.charCodeAt(0), c.toLowerCase().charCodeAt(0)] });
    });
    '0123456789'.split('').forEach(function (c) { out.push({ ch: c, cps: [c.charCodeAt(0)] }); });
    PLAIN.forEach(function (c) { out.push({ ch: c, cps: [c.codePointAt(0)] }); });
    Object.keys(COMPOSITE).forEach(function (c) {
      out.push({ ch: c, cps: [c.codePointAt(0), c.toUpperCase().codePointAt(0)] });
    });
    return out;
  }

  // --------------------------------------------------------------- geometry
  function starPolygon(cx, cy, dia, pts, pointiness, rotDeg) {
    var R = dia / 2, ri = R * Math.cos(Math.PI / pts) * (1 - pointiness * 0.74), out = [];
    for (var i = 0; i < pts * 2; i++) {
      var a = (-90 + rotDeg + i * 180 / pts) * Math.PI / 180, rad = (i % 2) ? ri : R;
      out.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
    }
    return out;
  }
  // round caps/joins are approximated by an octagon — TrueType has no caps
  function disc(cx, cy, dia) { return starPolygon(cx, cy, dia, 8, 0, 22.5); }

  function signedArea(c) {
    var a = 0;
    for (var i = 0; i < c.length; i++) { var p = c[i], q = c[(i + 1) % c.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return a / 2;
  }
  // TrueType fills with non-zero winding and wants filled contours clockwise
  // in y-up space, i.e. negative signed area.
  function cw(c) { return signedArea(c) > 0 ? c.slice().reverse() : c; }

  /*
   * outline(ch, t) -> { contours, advance, ... }
   *
   * 1. place the skeleton in font units (y-up, baseline 0)
   * 2. count how many lines meet at each vertex -> star magnitude
   *    (>=3 junction = brightest, 2 corner = mid, 1 terminal = faint)
   * 3. pull each sight-line back from its stars by trim x star radius
   * 4. emit: one rectangle per line segment, one octagon per segment end
   *    (round join), one star polygon per starred vertex, one dot per plain dot
   */
  function outline(ch, t) {
    var s = spec(ch);
    var pts = [];
    s.lines.forEach(function (l) { l.pts.forEach(function (p) { pts.push(p); }); });
    s.dots.forEach(function (d) { pts.push(d.pt); });
    var minX = Infinity, maxX = -Infinity;
    pts.forEach(function (p) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; });
    var bw = maxX - minX, w = (s.w != null) ? s.w : bw, xoff = -minX + (w - bw) / 2;
    var sb = t.sidebearing * t.width;
    var FX = function (gx) { return sb + (gx + xoff) * XU * t.width; };
    var FY = function (gy) { return gy * YU; };

    var nodes = {}, key = function (x, y) { return Math.round(x) + ',' + Math.round(y); };
    function touch(x, y, n, plain) {
      var k = key(x, y), e = nodes[k] || (nodes[k] = { x: x, y: y, deg: 0, plain: false });
      e.deg += n; if (plain) e.plain = true;
    }
    var lines = s.lines.map(function (l) {
      var o = l.pts.map(function (p) { return [FX(p[0]), FY(p[1])]; });
      o.forEach(function (p, j) { touch(p[0], p[1], (j === 0 || j === o.length - 1) ? 1 : 2, l.plain); });
      return { pts: o, plain: l.plain };
    });

    var swPlain = t.stroke * PLAIN_STROKE;
    var radius = {};
    Object.keys(nodes).forEach(function (k) {
      var n = nodes[k];
      if (n.plain) { radius[k] = 0; return; }
      var d = n.deg >= 3 ? t.star * t.contrast : n.deg === 2 ? t.star : t.star / Math.pow(t.contrast, 0.7);
      radius[k] = d / 2;
    });

    var contours = [], caps = {};
    lines.forEach(function (l) {
      var half = (l.plain ? swPlain : t.stroke) / 2;
      for (var j = 0; j < l.pts.length - 1; j++) {
        var a = l.pts[j], b = l.pts[j + 1];
        var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
        var ta = t.trim * (radius[key(a[0], a[1])] || 0), tb = t.trim * (radius[key(b[0], b[1])] || 0);
        if (ta + tb >= len - 4) continue;           // segment swallowed by its stars
        var ax = a[0] + dx / len * ta, ay = a[1] + dy / len * ta;
        var bx = b[0] - dx / len * tb, by = b[1] - dy / len * tb;
        var nx = -dy / len * half, ny = dx / len * half;
        contours.push(cw([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]));
        caps[key(ax, ay) + '|' + half] = [ax, ay, half];
        caps[key(bx, by) + '|' + half] = [bx, by, half];
      }
    });
    Object.keys(caps).forEach(function (k) {
      var c = caps[k]; contours.push(cw(disc(c[0], c[1], c[2] * 2)));
    });
    Object.keys(nodes).forEach(function (k) {
      var n = nodes[k];
      if (n.plain || !radius[k]) return;
      contours.push(cw(starPolygon(n.x, n.y, radius[k] * 2, t.points, t.pointiness, t.rot)));
    });
    s.dots.forEach(function (d) {
      var x = FX(d.pt[0]), y = FY(d.pt[1]);
      if (d.plain) contours.push(cw(disc(x, y, swPlain * DOT_SIZE)));
      else contours.push(cw(starPolygon(x, y, t.star * t.contrast, t.points, t.pointiness, t.rot)));
    });

    var advance = sb * 2 + w * XU * t.width + t.tracking;
    var bb = bbox(contours);
    return { ch: ch, contours: contours, advance: advance, xMin: bb[0], yMin: bb[1], xMax: bb[2], yMax: bb[3] };
  }

  function bbox(contours) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    contours.forEach(function (c) {
      c.forEach(function (p) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      });
    });
    if (!contours.length) return [0, 0, 0, 0];
    return [x0, y0, x1, y1];
  }

  function spaceAdvance(t) { return 300 * t.width + t.tracking; }

  function kernPairs(t) {
    var out = [];
    Object.keys(KERN).forEach(function (pair) {
      out.push([pair[0], pair[1], Math.round(KERN[pair] * XU * t.width)]);
    });
    return out;
  }

  // --------------------------------------------------------------------- svg
  function pathData(o) {
    return o.contours.map(function (c) {
      return 'M' + c.map(function (p, i) {
        return (i ? 'L' : '') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
      }).join(' ') + 'Z';
    }).join(' ');
  }
  // y-up font units flipped into SVG space; box shows the full advance width
  function svg(o, tierName) {
    var W = Math.round(o.advance);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -900 ' + W + ' 1200" width="' + W + '" height="1200">\n' +
      '  <!-- Almagest ' + tierName + ' | ' + o.ch + ' | advance ' + W + ' | upem ' + UPEM + ' | cap ' + CAP + ' | baseline y=0 -->\n' +
      '  <g transform="scale(1,-1)">\n    <path fill="#000" fill-rule="nonzero" d="' + pathData(o) + '"/>\n  </g>\n</svg>\n';
  }

  var API = { XU: XU, YU: YU, UPEM: UPEM, CAP: CAP, G: G, ACCENT: ACCENT, COMPOSITE: COMPOSITE,
    PLAIN: PLAIN, PLAIN_STROKE: PLAIN_STROKE, KERN: KERN, FROZEN: FROZEN, TIERS: TIERS,
    tier: tier, spec: spec, glyphOrder: glyphOrder, outline: outline, bbox: bbox,
    spaceAdvance: spaceAdvance, kernPairs: kernPairs, pathData: pathData, svg: svg,
    starPolygon: starPolygon, disc: disc };

  root.Almagest = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
