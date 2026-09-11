/*
 * npm run fonts:build                       -> rebuilds all three .ttf files + glyph SVGs + manifest
 *   (plain form works from apps/web, and from the repo root too -- root
 *   package.json delegates it to `npm run fonts:build -w apps/web`)
 * node fonts/almagest/tools/build.cjs Display   -> just one tier
 * node fonts/almagest/tools/build.cjs --out <dir>  -> TTFs only, into <dir>, no glyph export
 *   (used by the reproducibility test, almagest-build.test.ts)
 *
 * Everything downstream of the skeletons in almagest-glyphs.cjs is generated.
 * Edit skeletons or TIERS there, run this, done.
 */
var fs = require('fs');
var path = require('path');
var A = require('./almagest-glyphs.cjs');
var TTF = require('./build-ttf.cjs');

// Tracked build output (compiled TTFs) vs. generated design-time export
// (glyph SVGs + manifest.json, gitignored) live in different homes now that
// the workbench is inside the app tree.
var TTF_DIR = path.resolve(__dirname, '../../../public/fonts/almagest');
var GLYPH_DIR = path.resolve(__dirname, '../glyphs');
var VERSION = '1.000';

// Fixed on purpose so rebuilds are byte-identical (almagest-build.test.ts
// depends on it) -- bump together with VERSION when the design changes.
var BUILD_DATE_UNIX = Date.UTC(2026, 8, 11) / 1000;   // 2026-09-11, the 1.000 cut

function usageError() {
  process.stderr.write('usage: build.cjs [Display|Mid|Text] [--out <dir>]\n');
  process.exit(2);
}

var args = process.argv.slice(2);
var outDir = null;
var only = null;
for (var i = 0; i < args.length; i++) {
  if (args[i] === '--out') {
    if (i + 1 >= args.length) usageError();
    outDir = args[i + 1];
    i++;
  } else if (args[i].indexOf('--') === 0) {
    usageError();
  } else if (!only) {
    only = args[i];
  } else {
    usageError();  // a second positional (e.g. `Display Mid`) is not a tier list
  }
}
if (only && !Object.prototype.hasOwnProperty.call(A.TIERS, only)) usageError();
var tierNames = only ? [only] : ['Display', 'Mid', 'Text'];
var ttfOutDir = outDir || TTF_DIR;
var exportGlyphs = !outDir;

var METRICS = {
  upem: A.UPEM,
  capHeight: A.CAP,
  ascender: 1080,     // accents + display-tier star radius sit well above cap height
  descender: -260,
  lineGap: 0,
  winAscent: 1080,
  winDescent: 260
};

function buildTier(name) {
  var t = A.tier(name);
  var order = A.glyphOrder();
  var gidOf = {};
  var glyphs = order.map(function (entry, gid) {
    gidOf[entry.ch] = gid;
    if (entry.space) return { ch: ' ', cps: entry.cps, contours: [], advance: A.spaceAdvance(t), xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    var o = A.outline(entry.ch, t);
    o.cps = entry.cps;
    return o;
  });

  var kern = A.kernPairs(t)
    .filter(function (k) { return gidOf[k[0]] != null && gidOf[k[1]] != null && k[2]; })
    .map(function (k) { return [gidOf[k[0]], gidOf[k[1]], k[2]]; });

  var bytes = TTF.buildTTF({
    glyphs: glyphs,
    metrics: METRICS,
    kern: kern,
    timestamp: BUILD_DATE_UNIX,
    names: {
      family: 'Almagest ' + name,
      subfamily: 'Regular',
      version: VERSION,
      psName: 'Almagest' + name + '-Regular',
      license: 'Original design. Not affiliated with any existing typeface named Asterism.'
    }
  });

  var ttfPath = path.join(ttfOutDir, 'Almagest-' + name + '.ttf');
  fs.mkdirSync(path.dirname(ttfPath), { recursive: true });
  fs.writeFileSync(ttfPath, bytes);

  if (exportGlyphs) {
    var dir = path.join(GLYPH_DIR, name.toLowerCase());
    fs.mkdirSync(dir, { recursive: true });
    var manifest = [];
    glyphs.forEach(function (g, gid) {
      var slug = g.ch === '.notdef' ? 'notdef' : g.ch === ' ' ? 'space'
        : 'U-' + g.cps[0].toString(16).toUpperCase().padStart(4, '0');  // '+' is unsafe in some filesystems
      if (g.contours.length) fs.writeFileSync(path.join(dir, slug + '.svg'), A.svg(g, name));
      manifest.push({
        gid: gid, char: g.ch, slug: slug, unicode: (g.cps || []).map(function (c) { return 'U+' + c.toString(16).toUpperCase().padStart(4, '0'); }),
        advance: Math.round(g.advance), contours: g.contours.length
      });
    });

    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      family: 'Almagest ' + name, tier: t, metrics: METRICS, glyphs: manifest
    }, null, 2));
  }

  console.log('Almagest ' + name + ': ' + glyphs.length + ' glyphs, ' + bytes.length + ' bytes, ' + kern.length + ' kern pairs');
}

tierNames.forEach(buildTier);
