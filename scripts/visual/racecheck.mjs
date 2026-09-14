// Almagest font-arrival vs graph-render timing check: measures when font
// files land relative to first graph render, then checks whether SC-name
// labels overlap supercluster caption text once things settle.
//
// usage: node scripts/visual/racecheck.mjs <baseURL> <outDir>
// env:
//   PLAYWRIGHT_NODE_MODULES  node_modules dir containing playwright (optional;
//                            falls back to this repo's own resolution)
//
// <baseURL> is normally the demo-stub harness described in
// scripts/visual/README.md, never the developer's live :3000 instance.
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path';

// Playwright is not a dependency of this repo. Resolve it from
// PLAYWRIGHT_NODE_MODULES (a node_modules directory that contains it) or,
// when unset, from this repo's own resolution.
const pwRoot = process.env.PLAYWRIGHT_NODE_MODULES;
const requirePw = pwRoot ? createRequire(path.join(pwRoot, '_.js')) : createRequire(import.meta.url);
let chromium;
try { ({ chromium } = requirePw('playwright')); }
catch { console.error('playwright not found: install it, or set PLAYWRIGHT_NODE_MODULES=<a node_modules dir that has it>'); process.exit(2); }

const [base, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => console.log('[race]', ...a);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const fontT = {}; const t0 = Date.now();
page.on('response', (r) => { if (r.url().includes('/fonts/almagest/')) fontT[path.basename(r.url())] = Date.now() - t0; });
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__compendiumGraphRendered === true, null, { timeout: 90000 });
const tRender = Date.now() - t0; log('graph rendered at', tRender, 'ms; font responses so far', JSON.stringify(fontT));
await page.evaluate(() => { try { window.__compendiumLoader?.dismiss?.(); } catch (e) {} });
async function read(label) {
  const r = await page.evaluate(() => {
    const rect = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
    const names = [...document.querySelectorAll('text.supercluster-label')].map((el) => ({ t: el.textContent, r: rect(el) }));
    const caps = [...document.querySelectorAll('text.group-label')].filter((el) => getComputedStyle(el).opacity > 0.05).map((el) => ({ t: el.textContent.slice(0, 28), r: rect(el) }));
    const overlaps = [];
    names.forEach((n) => caps.forEach((c) => { if (n.r[0] < c.r[2] && c.r[0] < n.r[2] && n.r[1] < c.r[3] && c.r[1] < n.r[3]) overlaps.push(n.t + ' x ' + c.t); }));
    const faces = [...document.fonts].filter((f) => f.family.startsWith('Almagest')).map((f) => f.family + ':' + f.status);
    return { overlaps, faces, nNames: names.length, nCaps: caps.length };
  });
  log(label, JSON.stringify(r));
  return r;
}
async function snap(n) { await page.screenshot({ path: path.join(outDir, n + '.png') }); }
await page.waitForTimeout(2500); await read('a-2.5s'); await snap('a-2.5s');
await page.waitForTimeout(6000); await read('b-8.5s'); await snap('b-8.5s');
const box = await page.locator('#d3-graph-container').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, -100); await page.waitForTimeout(400); await page.mouse.wheel(0, 100); await page.waitForTimeout(2500);
await read('c-after-nudge'); await snap('c-after-nudge');
log('font response times ms:', JSON.stringify(fontT), 'render at', tRender);
await browser.close();
