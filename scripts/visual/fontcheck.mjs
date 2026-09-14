// Almagest font verification: drives the demo app, screenshots the graph at
// several SC-name tier states and reads back computed font state.
//
// usage: node scripts/visual/fontcheck.mjs <baseURL> <outDir> <loginEmail>
// env:
//   PLAYWRIGHT_NODE_MODULES  node_modules dir containing playwright (optional;
//                            falls back to this repo's own resolution)
//   FC_PASSWORD              required only if the target shows a login form
//
// <baseURL> is normally the demo-stub harness described in
// scripts/visual/README.md, never the developer's live :3000 instance.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// Playwright is not a dependency of this repo. Resolve it from
// PLAYWRIGHT_NODE_MODULES (a node_modules directory that contains it) or,
// when unset, from this repo's own resolution.
const pwRoot = process.env.PLAYWRIGHT_NODE_MODULES;
const requirePw = pwRoot ? createRequire(path.join(pwRoot, '_.js')) : createRequire(import.meta.url);
let chromium;
try { ({ chromium } = requirePw('playwright')); }
catch { console.error('playwright not found: install it, or set PLAYWRIGHT_NODE_MODULES=<a node_modules dir that has it>'); process.exit(2); }

const [base, outDir, email] = process.argv.slice(2);
if (!base || !outDir || !email) { console.error('usage: fontcheck.mjs <baseURL> <outDir> <email>'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => console.log('[fontcheck]', ...a);
const readback = { base, states: {}, fontResponses: [] };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('response', (r) => { const u = r.url(); if (u.includes('/fonts/')) readback.fontResponses.push({ url: u, status: r.status(), type: r.headers()['content-type'] }); });
page.on('pageerror', (e) => log('PAGE ERROR', e.message));

log('open', base);
await page.goto(base + '/', { waitUntil: 'networkidle' }); await page.waitForTimeout(800);
if (new URL(page.url()).pathname.startsWith('/login')) {
  log('login form present, signing in');
  if (!process.env.FC_PASSWORD) { console.error('FC_PASSWORD is required when the target shows a login form'); process.exit(2); }
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', process.env.FC_PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), page.click('button[type="submit"]')]);
} else { log('no login needed (demo identity)'); }
log('at', page.url());
await page.waitForFunction(() => window.__compendiumGraphRendered === true, null, { timeout: 90000 });
log('graph rendered');
await page.evaluate(() => { try { window.__compendiumLoader && window.__compendiumLoader.dismiss && window.__compendiumLoader.dismiss(); } catch (e) {} });
await page.waitForTimeout(2500);
await page.evaluate(() => document.fonts.ready);

async function read(label) {
  const r = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('text.supercluster-label')].map((el) => {
      const cs = getComputedStyle(el); const b = el.getBoundingClientRect();
      return { text: el.textContent, inlineFamily: el.style.fontFamily, computedFamily: cs.fontFamily, fontSize: cs.fontSize, opacity: cs.opacity, tspans: el.querySelectorAll('tspan').length, w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) };
    });
    const chips = [...document.querySelectorAll('.sc-edge-chip')].map((el) => ({ text: el.textContent, family: getComputedStyle(el).fontFamily, fontSize: getComputedStyle(el).fontSize }));
    const zoom = document.querySelector('.d3-zoom-indicator')?.textContent?.trim() || null;
    const tf = document.querySelector('#d3-graph-container svg > g')?.getAttribute('transform') || ''; const km = /scale\(([-\d.e]+)/.exec(tf); const k = km ? parseFloat(km[1]) : null;
    labels.forEach((l) => { l.painted = k ? Math.round(parseFloat(l.fontSize) * k * 10) / 10 : null; });
    const faces = [...document.fonts].map((f) => `${f.family} ${f.status}`);
    const check = { display: document.fonts.check('60px "Almagest Display"'), mid: document.fonts.check('30px "Almagest Mid"'), text: document.fonts.check('14px "Almagest Text"') };
    return { labels, chips, zoom, k, faces, check };
  });
  readback.states[label] = r;
  log(label, 'k=' + r.k, 'labels=' + r.labels.length, 'chips=' + r.chips.length, JSON.stringify(r.labels.map((l) => [l.text, (l.inlineFamily || l.computedFamily).split(',')[0], l.fontSize, 'painted=' + l.painted, l.tspans + 'ln', l.w + 'x' + l.h])));
  return r;
}
async function waitLabels() { const t0 = Date.now(); await page.waitForTimeout(500); await page.waitForFunction(() => document.querySelectorAll('text.supercluster-label').length > 0, null, { timeout: 30000 }); await page.waitForTimeout(2500); log('labels back after', Date.now() - t0, 'ms'); }
async function snap(name) { const p = path.join(outDir, name + '.png'); await page.screenshot({ path: p }); log('saved', p); }
async function wheel(notches, delta) {
  const box = await page.locator('#d3-graph-container').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < notches; i++) { await page.mouse.wheel(0, delta); await page.waitForTimeout(90); }
  await page.waitForTimeout(1200);
}

await read('01-fit'); await snap('01-fit');
await wheel(14, -100); await read('02-zoomed-in'); await snap('02-zoomed-in');
await page.evaluate(() => window.__d3ApplyTunerOverrides({ BASE_SC_NAME_FONT_SIZE: 60 })); await waitLabels();
await read('03-display-tier-forced'); await snap('03-display-tier-forced');
await page.evaluate(() => window.__d3ApplyTunerOverrides({ BASE_SC_NAME_FONT_SIZE: 16 })); await waitLabels();
await read('04-text-tier-forced'); await snap('04-text-tier-forced');
await page.evaluate(() => window.__d3ResetTunerToDefaults()); await waitLabels();
await wheel(30, -100); await read('05-deep-zoom'); await snap('05-deep-zoom');
await page.keyboard.press('Escape');
fs.writeFileSync(path.join(outDir, 'readback.json'), JSON.stringify(readback, null, 2));
log('font responses:', JSON.stringify(readback.fontResponses));
await browser.close();
log('done');
