/*
 * Minimal TrueType writer — enough tables for a valid, installable .ttf:
 * OS/2, cmap (format 4), glyf, head, hhea, hmtx, kern (format 0), loca, maxp, name, post.
 *
 * Every contour is straight-line only (all points on-curve), which is all
 * Almagest needs: stars are polygons and sight-lines are rectangles.
 *
 * buildTTF({ glyphs, names, metrics, kern, timestamp }) -> Uint8Array
 *   glyphs:   [{ contours:[[[x,y],...]], advance, cps:[unicode,...] }]  (index 0 = .notdef)
 *   names:    { family, subfamily, version, psName }
 *   metrics:  { upem, ascender, descender, lineGap, capHeight }
 *   kern:     [[leftGid, rightGid, valueFontUnits], ...]
 *   timestamp: optional unix seconds for head.created/modified; falls back
 *              to Date.now() when omitted. Pass a fixed value for
 *              byte-identical rebuilds (build.cjs does).
 *
 * Runs in Node (module.exports) and in a browser (globalThis.AlmagestTTF).
 */
(function (root) {
  'use strict';

  function W() { this.b = []; }
  W.prototype.u8 = function (v) { this.b.push(v & 0xff); return this; };
  W.prototype.u16 = function (v) { this.b.push((v >> 8) & 0xff, v & 0xff); return this; };
  W.prototype.i16 = function (v) { if (v < 0) v += 0x10000; return this.u16(v); };
  W.prototype.u32 = function (v) { this.b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return this; };
  W.prototype.tag = function (s) { for (var i = 0; i < 4; i++) this.b.push(s.charCodeAt(i)); return this; };
  W.prototype.raw = function (a) { for (var i = 0; i < a.length; i++) this.b.push(a[i] & 0xff); return this; };
  W.prototype.str16 = function (s) { for (var i = 0; i < s.length; i++) this.u16(s.charCodeAt(i)); return this; };
  W.prototype.pad4 = function () { while (this.b.length % 4) this.b.push(0); return this; };
  W.prototype.out = function () { return new Uint8Array(this.b); };

  function checksum(bytes) {
    var sum = 0, i, n = bytes.length;
    for (i = 0; i + 3 < n; i += 4) {
      sum = (sum + ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3])) >>> 0;
    }
    var rest = [0, 0, 0, 0], k = 0;
    for (; i < n; i++) rest[k++] = bytes[i];
    sum = (sum + ((rest[0] << 24) | (rest[1] << 16) | (rest[2] << 8) | rest[3])) >>> 0;
    return sum >>> 0;
  }

  function glyfEntry(contours) {
    if (!contours.length) return new Uint8Array(0);
    var pts = [], ends = [], x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    contours.forEach(function (c) {
      c.forEach(function (p) {
        var x = Math.round(p[0]), y = Math.round(p[1]);
        pts.push([x, y]);
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      });
      ends.push(pts.length - 1);
    });
    var w = new W();
    w.i16(contours.length).i16(x0).i16(y0).i16(x1).i16(y1);
    ends.forEach(function (e) { w.u16(e); });
    w.u16(0);                                     // no instructions
    pts.forEach(function () { w.u8(0x01); });     // every point on-curve, int16 deltas
    var px = 0, py = 0;
    pts.forEach(function (p) { w.i16(p[0] - px); px = p[0]; });
    pts.forEach(function (p) { w.i16(p[1] - py); py = p[1]; });
    return w.pad4().out();
  }

  function cmap4(pairs) {                          // pairs: [[cp, gid], ...]
    pairs = pairs.slice().sort(function (a, b) { return a[0] - b[0]; });
    var segs = pairs.map(function (p) { return { start: p[0], end: p[0], delta: (p[1] - p[0]) & 0xffff }; });
    segs.push({ start: 0xffff, end: 0xffff, delta: 1 });
    var n = segs.length, x2 = n * 2;
    var sr = 2, es = 0;
    while (sr * 2 <= x2) { sr *= 2; es++; }
    var sub = new W();
    sub.u16(4).u16(16 + x2 * 4).u16(0).u16(x2).u16(sr).u16(es).u16(x2 - sr); // length: header + 4 arrays
    segs.forEach(function (s) { sub.u16(s.end); });
    sub.u16(0);
    segs.forEach(function (s) { sub.u16(s.start); });
    segs.forEach(function (s) { sub.u16(s.delta); });
    segs.forEach(function () { sub.u16(0); });
    var body = sub.out();
    var t = new W();
    t.u16(0).u16(2);                               // two encoding records, one subtable
    t.u16(0).u16(4).u32(4 + 2 * 8);                // (0,4) Unicode BMP
    t.u16(3).u16(1).u32(4 + 2 * 8);                // (3,1) Windows BMP
    t.raw(body);
    return t.out();
  }

  function nameTable(names) {
    var strings = [
      [1, names.family], [2, names.subfamily], [3, names.family + ' ' + names.subfamily + ' ' + names.version],
      [4, names.family + ' ' + names.subfamily], [5, 'Version ' + names.version], [6, names.psName],
      [8, names.designer || ''], [11, names.url || ''], [13, names.license || '']
    ].filter(function (r) { return r[1]; });
    var recs = [], data = [];
    function push(platform, enc, lang, id, str) {
      var bytes;
      if (platform === 3) { var w = new W(); w.str16(str); bytes = w.out(); }
      else { bytes = new Uint8Array(str.length); for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff; }
      recs.push({ platform: platform, enc: enc, lang: lang, id: id, len: bytes.length, off: data.length });
      for (var j = 0; j < bytes.length; j++) data.push(bytes[j]);
    }
    strings.forEach(function (r) { push(1, 0, 0, r[0], r[1]); });
    strings.forEach(function (r) { push(3, 1, 0x409, r[0], r[1]); });
    var t = new W();
    t.u16(0).u16(recs.length).u16(6 + recs.length * 12);
    recs.forEach(function (r) { t.u16(r.platform).u16(r.enc).u16(r.lang).u16(r.id).u16(r.len).u16(r.off); });
    t.raw(data);
    return t.out();
  }

  function kernTable(pairs) {
    if (!pairs || !pairs.length) return null;
    var p = pairs.slice().sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
    var n = p.length, sr = 6, es = 0;
    while (sr * 2 <= n * 6) { sr *= 2; es++; }
    var t = new W();
    t.u16(0).u16(1);                               // version, one subtable
    t.u16(0).u16(14 + n * 6).u16(0x0001);          // subtable version, length, coverage: horizontal
    t.u16(n).u16(sr).u16(es).u16(n * 6 - sr);
    p.forEach(function (k) { t.u16(k[0]).u16(k[1]).i16(k[2]); });
    return t.out();
  }

  function os2(m, glyphs, cps) {
    var avg = 0;
    glyphs.forEach(function (g) { avg += g.advance; });
    avg = Math.round(avg / glyphs.length);
    var lo = Math.min.apply(null, cps), hi = Math.max.apply(null, cps);
    var t = new W();
    t.u16(4).i16(avg).u16(400).u16(5).u16(0);                                  // v4, weight 400, width normal
    t.i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350);      // sub / superscript
    t.i16(50).i16(300).i16(0);                                                 // strikeout, family class
    t.raw([2, 0, 5, 3, 0, 0, 0, 0, 0, 0]);                                     // PANOSE: latin text, monoline-ish
    t.u32(0x00000003).u32(0x10000000).u32(0).u32(0);                           // unicode ranges: latin + punctuation
    t.tag('ALMG').u16(0x0040);                                                 // vendor, fsSelection: regular
    t.u16(lo).u16(hi);
    t.i16(800).i16(-200).i16(200);                                             // typo asc / desc / gap
    t.u16(m.winAscent).u16(m.winDescent);
    t.u32(1).u32(0);                                                           // codepage: latin1
    t.i16(m.capHeight).i16(m.capHeight);                                       // no lowercase: xHeight = capHeight
    t.u16(0x20).u16(0x20).u16(1);
    return t.out();
  }

  function buildTTF(o) {
    var glyphs = o.glyphs, m = o.metrics, num = glyphs.length;
    var entries = glyphs.map(function (g) { return glyfEntry(g.contours || []); });
    var glyf = new W(), loca = new W(), off = 0;
    entries.forEach(function (e) { loca.u32(off); glyf.raw(e); off += e.length; });
    loca.u32(off);

    var xMin = 0, yMin = 0, xMax = 0, yMax = 0, maxPts = 0, maxCon = 0, advMax = 0, minLsb = 32767, xExt = -32767;
    glyphs.forEach(function (g) {
      var np = 0;
      (g.contours || []).forEach(function (c) { np += c.length; });
      maxPts = Math.max(maxPts, np);
      maxCon = Math.max(maxCon, (g.contours || []).length);
      advMax = Math.max(advMax, Math.round(g.advance));
      if (g.contours && g.contours.length) {
        xMin = Math.min(xMin, Math.round(g.xMin)); yMin = Math.min(yMin, Math.round(g.yMin));
        xMax = Math.max(xMax, Math.round(g.xMax)); yMax = Math.max(yMax, Math.round(g.yMax));
        minLsb = Math.min(minLsb, Math.round(g.xMin));
        xExt = Math.max(xExt, Math.round(g.xMax));
      }
    });

    var hmtx = new W();
    glyphs.forEach(function (g) {
      hmtx.u16(Math.round(g.advance));
      hmtx.i16(g.contours && g.contours.length ? Math.round(g.xMin) : 0);
    });

    var head = new W();
    var epoch = -2082844800;   // 1904-01-01 in unix seconds
    // Deterministic when the caller passes a fixed timestamp (build.cjs
    // does, so rebuilds are byte-identical); falls back to the real clock
    // for any other caller that doesn't pass one.
    var now = (o.timestamp != null ? o.timestamp : Math.floor(Date.now() / 1000)) - epoch;
    head.u32(0x00010000).u32(0x00010000).u32(0).u32(0x5F0F3CF5);
    head.u16(0x0003).u16(m.upem);
    head.u32(0).u32(now).u32(0).u32(now);         // created / modified (high dword 0)
    head.i16(xMin).i16(yMin).i16(xMax).i16(yMax);
    head.u16(0).u16(8).i16(2).i16(1).i16(0);      // macStyle, lowestRecPPEM, dirHint, long loca, glyphDataFormat
    var headBytes = head.out();

    var hhea = new W();
    hhea.u32(0x00010000).i16(m.ascender).i16(m.descender).i16(m.lineGap);
    hhea.u16(advMax).i16(minLsb).i16(0).i16(xExt);
    hhea.i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(num);

    // maxp v1.0 is exactly 32 bytes: version + 14 uint16. One field too many and
    // the sanitiser rejects the whole font.
    var maxp = new W();
    maxp.u32(0x00010000).u16(num).u16(maxPts).u16(maxCon).u16(0).u16(0).u16(2);
    maxp.u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);

    var post = new W();
    post.u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);

    var cmapPairs = [], allCps = [];
    glyphs.forEach(function (g, gid) {
      (g.cps || []).forEach(function (cp) { cmapPairs.push([cp, gid]); allCps.push(cp); });
    });

    // Directory entries carry each table's TRUE length; the file itself pads every
    // table to a 4-byte boundary. head is 54 bytes, so without that padding every
    // table after it lands misaligned and the font is rejected.
    var tables = [
      ['OS/2', os2(m, glyphs, allCps)],
      ['cmap', cmap4(cmapPairs)],
      ['glyf', glyf.out()],
      ['head', headBytes],
      ['hhea', hhea.out()],
      ['hmtx', hmtx.out()],
      ['loca', loca.out()],
      ['maxp', maxp.out()],
      ['name', nameTable(o.names)],
      ['post', post.out()]
    ];
    var kern = kernTable(o.kern);
    if (kern) tables.push(['kern', kern]);
    tables.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });

    var numTables = tables.length, sr = 16, es = 0;
    while (sr * 2 <= numTables * 16) { sr *= 2; es++; }
    var head2 = new W();
    head2.u32(0x00010000).u16(numTables).u16(sr).u16(es).u16(numTables * 16 - sr);
    var align = function (n) { return (n + 3) & ~3; };
    var offset = 12 + numTables * 16;
    var dir = new W(), bodies = [];
    tables.forEach(function (t) {
      dir.tag(t[0]).u32(checksum(t[1])).u32(offset).u32(t[1].length);
      bodies.push(t[1]);
      offset += align(t[1].length);
    });

    var out = new Uint8Array(offset);
    var p = 0, hb = head2.out(), db = dir.out();
    out.set(hb, p); p += hb.length;
    out.set(db, p); p += db.length;
    var headOffset = 0, i;
    for (i = 0; i < tables.length; i++) {
      if (tables[i][0] === 'head') headOffset = p;
      out.set(bodies[i], p); p += align(bodies[i].length);
    }
    // head.checkSumAdjustment = 0xB1B0AFBA - checksum(whole font)
    var adj = (0xB1B0AFBA - checksum(out)) >>> 0;
    out[headOffset + 8] = (adj >>> 24) & 0xff;
    out[headOffset + 9] = (adj >>> 16) & 0xff;
    out[headOffset + 10] = (adj >>> 8) & 0xff;
    out[headOffset + 11] = adj & 0xff;
    return out;
  }

  var API = { buildTTF: buildTTF, checksum: checksum };
  root.AlmagestTTF = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
