#!/usr/bin/env node
/* Rewrites the FROZEN / TIERS table literals in almagest-glyphs.cjs from a
 * params JSON ({ frozen, tiers }). Only those two `var X = {...};` statements
 * change; the formatter reproduces the file's own layout so diffs stay
 * readable. Used by the dev-only bake route and `npm run fonts:set-params`. */
'use strict';
var fs = require('fs');

var FROZEN_KEYS = ['width', 'tracking', 'sidebearing', 'points', 'rot'];
var TIER_KEYS = ['min', 'star', 'contrast', 'trim', 'stroke', 'pointiness'];
var TIER_NAMES = ['Display', 'Mid', 'Text'];
var FROZEN_RE = /var FROZEN = \{[^}]*\};/;
var TIERS_RE = /var TIERS = \{[\s\S]*?\n  \};/;
// key: number pairs, matched per object (FROZEN) / per tier row (TIERS) --
// readParams never evals the source, only ever regex-extracts numeric
// literals from text it has already located with FROZEN_RE / TIERS_RE.
var PAIR_RE = /(\w+):\s*(-?\d+(?:\.\d+)?)/g;

function num(v, k) {
  if (typeof v !== 'number' || !isFinite(v)) throw new Error('set-params: ' + k + ' must be a finite number');
  return v;
}
function fmt(v) {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1000) / 1000);
}
function pad(s, n) { while (s.length < n) s += ' '; return s; }

function formatFrozen(f) {
  return 'var FROZEN = { ' + FROZEN_KEYS.map(function (k) { return k + ': ' + fmt(num(f[k], 'frozen.' + k)); }).join(', ') + ' };';
}
function formatTiers(tiers) {
  var rows = TIER_NAMES.map(function (name) {
    var t = tiers[name];
    if (!t) throw new Error('set-params: missing tier ' + name);
    var body = TIER_KEYS.map(function (k) { return k + ': ' + fmt(num(t[k], 'tiers.' + name + '.' + k)); }).join(', ');
    return '    ' + pad(name + ':', 9) + '{ ' + body + ' }';
  });
  return 'var TIERS = {\n' + rows.join(',\n') + '\n  };';
}

// Extracts every `key: number` pair from a literal fragment via PAIR_RE --
// no eval. Used both on a whole `var FROZEN = {...};` literal and on a single
// tier row's `{...}` body.
function extractPairs(str) {
  var out = {};
  var re = new RegExp(PAIR_RE.source, 'g');
  var m;
  while ((m = re.exec(str))) { out[m[1]] = Number(m[2]); }
  return out;
}

function readParams(text) {
  var fm = FROZEN_RE.exec(text), tm = TIERS_RE.exec(text);
  if (!fm) throw new Error('set-params: FROZEN literal not found');
  if (!tm) throw new Error('set-params: TIERS literal not found');
  var frozen = extractPairs(fm[0]);
  var tiers = {};
  TIER_NAMES.forEach(function (name) {
    var rowRe = new RegExp(name + ':\\s*\\{([^}]*)\\}');
    var rm = rowRe.exec(tm[0]);
    if (!rm) throw new Error('set-params: tiers.' + name + ' row not found');
    tiers[name] = extractPairs(rm[1]);
  });
  return { frozen: frozen, tiers: tiers };
}

function applyParams(text, params) {
  if (!FROZEN_RE.test(text)) throw new Error('set-params: FROZEN literal not found');
  if (!TIERS_RE.test(text)) throw new Error('set-params: TIERS literal not found');
  return text.replace(FROZEN_RE, formatFrozen(params.frozen)).replace(TIERS_RE, formatTiers(params.tiers));
}

function applyToFile(sourcePath, params) {
  var text = fs.readFileSync(sourcePath, 'utf8');
  var out = applyParams(text, params);
  var tmp = sourcePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, sourcePath);
  return text; // previous contents, for restore on build failure
}

module.exports = { applyParams: applyParams, readParams: readParams, applyToFile: applyToFile };

if (require.main === module) {
  var args = process.argv.slice(2);
  if (args.length !== 2) { process.stderr.write('usage: set-params.cjs <almagest-glyphs.cjs> <params.json>\n'); process.exit(2); }
  var params = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  applyToFile(args[0], params);
  process.stdout.write('set-params: wrote ' + args[0] + '\n');
}
