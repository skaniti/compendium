import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeShim, spyWarn } from './helpers/chrome-shim.mjs';

const shim = installChromeShim();

const {
  SITE_ACCESS_REQUEST,
  backendOriginPattern,
  hasSiteAccess,
  setSiteAccessBadge,
  refreshSiteAccessBadge,
  startSiteAccessMonitor,
  composeSiteAccessBanner
} = await import('../modules/site-access.js');
const { initSiteAccessBanner } = await import('../modules/site-access-ui.js');

// ── backendOriginPattern ─────────────────────────────────────────────────────

test('backendOriginPattern: http origin with a port drops the port (match patterns ignore ports)', () => {
  assert.equal(backendOriginPattern('http://localhost:8001'), 'http://localhost/*');
});

test('backendOriginPattern: https origin with a path and trailing slash', () => {
  assert.equal(backendOriginPattern('https://api.example.test/some/path/'), 'https://api.example.test/*');
});

test('backendOriginPattern: unparseable or non-http(s) URLs yield null', () => {
  assert.equal(backendOriginPattern('not a url'), null);
  assert.equal(backendOriginPattern(''), null);
  assert.equal(backendOriginPattern('ftp://files.example.test'), null);
  assert.equal(backendOriginPattern('file:///tmp/x'), null);
});

// ── hasSiteAccess ────────────────────────────────────────────────────────────

test('hasSiteAccess: asks permissions.contains for the configured backend origin', async () => {
  shim.reset();
  shim.storage.set('backendUrl', 'https://api.example.test:8443/');

  assert.equal(await hasSiteAccess(), true);
  assert.deepEqual(shim.permissions.containsCalls, [{ origins: ['https://api.example.test/*'] }]);
});

test('hasSiteAccess: default backend (localhost) is checked when none is configured', async () => {
  shim.reset();
  await hasSiteAccess();
  assert.deepEqual(shim.permissions.containsCalls, [{ origins: ['http://localhost/*'] }]);
});

test('hasSiteAccess: false when the browser says the origin is not granted', async () => {
  shim.reset();
  shim.permissions.granted = false;
  assert.equal(await hasSiteAccess(), false);
});

test('hasSiteAccess: an unusable backend URL counts as granted and never calls contains', async () => {
  shim.reset();
  shim.storage.set('backendUrl', 'ftp://files.example.test');
  shim.permissions.granted = false;

  assert.equal(await hasSiteAccess(), true);
  assert.equal(shim.permissions.containsCalls.length, 0);
});

test('hasSiteAccess: no permissions API means unknown, so granted (no false alarm)', async () => {
  shim.reset();
  const saved = chrome.permissions;
  delete chrome.permissions;
  try {
    assert.equal(await hasSiteAccess(), true);
  } finally {
    chrome.permissions = saved;
  }
});

test('hasSiteAccess: contains() throwing counts as granted and logs the error object', async () => {
  shim.reset();
  const saved = chrome.permissions.contains;
  chrome.permissions.contains = async () => {
    throw new Error('boom');
  };
  const warn = spyWarn();
  try {
    assert.equal(await hasSiteAccess(), true);
  } finally {
    warn.restore();
    chrome.permissions.contains = saved;
  }
  assert.ok(warn.calls.some(args => args.some(a => a instanceof Error)));
});

// ── badge ────────────────────────────────────────────────────────────────────

test('setSiteAccessBadge(true): "!" badge in the warn colour with an explanatory title', async () => {
  shim.reset();
  await setSiteAccessBadge(true);
  assert.equal(shim.action.badgeText, '!');
  assert.equal(shim.action.badgeColor, '#C9A66B');
  assert.match(shim.action.title, /site access is off/i);
});

test('setSiteAccessBadge(false): clears the badge and restores the default title', async () => {
  shim.reset();
  await setSiteAccessBadge(true);
  await setSiteAccessBadge(false);
  assert.equal(shim.action.badgeText, '');
  assert.equal(shim.action.title, 'Compendium Capture');
});

test('setSiteAccessBadge: tolerates a missing chrome.action', async () => {
  shim.reset();
  const saved = chrome.action;
  delete chrome.action;
  try {
    await setSiteAccessBadge(true);
  } finally {
    chrome.action = saved;
  }
});

test('refreshSiteAccessBadge: reflects the current permission state and returns it', async () => {
  shim.reset();
  shim.permissions.granted = false;
  assert.equal(await refreshSiteAccessBadge(), false);
  assert.equal(shim.action.badgeText, '!');

  shim.permissions.granted = true;
  assert.equal(await refreshSiteAccessBadge(), true);
  assert.equal(shim.action.badgeText, '');
});

// ── monitor ──────────────────────────────────────────────────────────────────

test('startSiteAccessMonitor: initial refresh sets the badge when access is missing', async () => {
  shim.reset();
  shim.permissions.granted = false;
  await startSiteAccessMonitor();
  assert.equal(shim.action.badgeText, '!');
});

test('startSiteAccessMonitor: permissions.onRemoved / onAdded flip the badge', async () => {
  shim.reset();
  await startSiteAccessMonitor();
  assert.equal(shim.action.badgeText, '');

  shim.permissions.granted = false;
  shim.permissions.fireRemoved();
  await new Promise(r => setImmediate(r));
  assert.equal(shim.action.badgeText, '!');

  shim.permissions.granted = true;
  shim.permissions.fireAdded();
  await new Promise(r => setImmediate(r));
  assert.equal(shim.action.badgeText, '');
});

test('startSiteAccessMonitor: a backendUrl change re-checks against the new origin', async () => {
  shim.reset();
  await startSiteAccessMonitor();
  shim.permissions.containsCalls.length = 0;
  shim.permissions.granted = false;

  await chrome.storage.local.set({ backendUrl: 'https://other.example.test' });
  await new Promise(r => setImmediate(r));

  assert.deepEqual(shim.permissions.containsCalls, [{ origins: ['https://other.example.test/*'] }]);
  assert.equal(shim.action.badgeText, '!');
});

test('startSiteAccessMonitor: unrelated storage changes do not trigger a check', async () => {
  shim.reset();
  await startSiteAccessMonitor();
  shim.permissions.containsCalls.length = 0;

  await chrome.storage.local.set({ passiveEnabled: false });
  await new Promise(r => setImmediate(r));

  assert.equal(shim.permissions.containsCalls.length, 0);
});

// ── composeSiteAccessBanner (DOM-free) ───────────────────────────────────────

test('composeSiteAccessBanner: hidden when access is present', () => {
  const banner = composeSiteAccessBanner({ missing: false });
  assert.equal(banner.visible, false);
});

test('composeSiteAccessBanner: missing access names the consequence and offers the grant', () => {
  const banner = composeSiteAccessBanner({ missing: true });
  assert.equal(banner.visible, true);
  assert.equal(banner.text, "Site access is off, so captures can't be uploaded.");
  assert.equal(banner.buttonLabel, 'Grant access');
});

test('composeSiteAccessBanner: after a denied or failed request, points at the browser settings', () => {
  const banner = composeSiteAccessBanner({ missing: true, denied: true });
  assert.equal(banner.visible, true);
  assert.match(banner.text, /not granted/i);
  assert.match(banner.text, /about:addons/);
  assert.equal(banner.buttonLabel, 'Grant access');
});

// ── initSiteAccessBanner (shared popup / cache page wiring) ──────────────────

function fakeEl() {
  const classes = new Set(['hidden']);
  return {
    textContent: '',
    disabled: false,
    listeners: {},
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
      contains: c => classes.has(c)
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
  };
}

function bannerEls() {
  return { banner: fakeEl(), text: fakeEl(), button: fakeEl() };
}

test('initSiteAccessBanner: stays hidden when access is granted', async () => {
  shim.reset();
  const els = bannerEls();
  await initSiteAccessBanner(els);
  assert.equal(els.banner.classList.contains('hidden'), true);
});

test('initSiteAccessBanner: shows the banner text and grant label when access is missing', async () => {
  shim.reset();
  shim.permissions.granted = false;
  const els = bannerEls();
  await initSiteAccessBanner(els);

  assert.equal(els.banner.classList.contains('hidden'), false);
  assert.equal(els.text.textContent, "Site access is off, so captures can't be uploaded.");
  assert.equal(els.button.textContent, 'Grant access');
});

test('initSiteAccessBanner: Grant click calls permissions.request synchronously with <all_urls>', async () => {
  shim.reset();
  shim.permissions.granted = false;
  const els = bannerEls();
  await initSiteAccessBanner(els);

  const pending = els.button.listeners.click();
  // No await between the click and the request: Firefox drops the user
  // gesture otherwise, and the prompt never appears.
  assert.deepEqual(shim.permissions.requests, [SITE_ACCESS_REQUEST]);
  assert.deepEqual(SITE_ACCESS_REQUEST, { origins: ['<all_urls>'] });
  await pending;
});

test('initSiteAccessBanner: a successful grant hides the banner and clears the badge', async () => {
  shim.reset();
  shim.permissions.granted = false;
  await setSiteAccessBadge(true);
  const els = bannerEls();
  await initSiteAccessBanner(els);

  await els.button.listeners.click();

  assert.equal(els.banner.classList.contains('hidden'), true);
  assert.equal(els.button.disabled, false);
  assert.equal(shim.action.badgeText, '');
});

test('initSiteAccessBanner: a denied request keeps the banner and shows the settings hint', async () => {
  shim.reset();
  shim.permissions.granted = false;
  shim.permissions.requestResult = false;
  const els = bannerEls();
  await initSiteAccessBanner(els);

  await els.button.listeners.click();

  assert.equal(els.banner.classList.contains('hidden'), false);
  assert.match(els.text.textContent, /not granted/i);
  assert.equal(els.button.disabled, false);
});

test('initSiteAccessBanner: a rejected request (no user gesture) is handled like a denial', async () => {
  shim.reset();
  shim.permissions.granted = false;
  shim.permissions.requestResult = 'throw';
  const els = bannerEls();
  await initSiteAccessBanner(els);
  const warn = spyWarn();

  await els.button.listeners.click();
  warn.restore();

  assert.equal(els.banner.classList.contains('hidden'), false);
  assert.match(els.text.textContent, /not granted/i);
  assert.ok(warn.calls.some(args => args.some(a => a instanceof Error)));
});

test('initSiteAccessBanner: permissions.onAdded / onRemoved update a live banner', async () => {
  shim.reset();
  const els = bannerEls();
  await initSiteAccessBanner(els);
  assert.equal(els.banner.classList.contains('hidden'), true);

  shim.permissions.granted = false;
  shim.permissions.fireRemoved();
  await new Promise(r => setImmediate(r));
  assert.equal(els.banner.classList.contains('hidden'), false);

  shim.permissions.granted = true;
  shim.permissions.fireAdded();
  await new Promise(r => setImmediate(r));
  assert.equal(els.banner.classList.contains('hidden'), true);
});
