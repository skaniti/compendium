import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeShim, fetchQueue, spyWarn, silenceLog } from './helpers/chrome-shim.mjs';

const shim = installChromeShim();
silenceLog();

const { CONFIG } = await import('../modules/config.js');
const {
  flushPendingExports,
  retrySingleExport,
  exportPassiveCapture,
  exportActiveCapture,
  ensureFlushAlarm,
  clearFlushAlarm,
  writeExportCache,
  markDelivered,
  ensureCacheV2,
  readCacheIndex,
  readCacheEntry,
  readAllCacheEntries
} = await import('../modules/export.js');

function capture(id, overrides = {}) {
  return {
    captureId: id,
    startedAt: '2026-09-09T00:00:00.000Z',
    endedAt: '2026-09-09T00:01:00.000Z',
    pages: [{ url: 'https://example.test', title: 'Example' }],
    events: [],
    trivial: false,
    ...overrides
  };
}

function legacyCacheEntry(id, cachedAt, deliveredAt = null) {
  return { captureData: capture(id), cachedAt, deliveredAt };
}

const EMPTY_FLUSH = { attempted: 0, delivered: 0, remaining: 0, stop: null, lastError: null };

function items(n, prefix = 'c') {
  return Array.from({ length: n }, (_, i) => ({ captureId: `${prefix}${i}` }));
}

// ── ensureFlushAlarm / clearFlushAlarm ──────────────────────────────────────

test('ensureFlushAlarm / clearFlushAlarm: call through to chrome.alarms', () => {
  shim.reset();
  ensureFlushAlarm();
  assert.equal(shim.alarms.created.length, 1);
  assert.deepEqual(shim.alarms.created[0], {
    name: CONFIG.FLUSH_ALARM_NAME,
    info: { periodInMinutes: CONFIG.FLUSH_ALARM_PERIOD_MINUTES }
  });

  clearFlushAlarm();
  assert.deepEqual(shim.alarms.cleared, [CONFIG.FLUSH_ALARM_NAME]);
});

// ── Cache v2 (storage split) ─────────────────────────────────────────────────

test('writeExportCache: creates a full entry + a matching index summary', async () => {
  shim.reset();
  const captureData = capture('w1');

  await writeExportCache(captureData);

  const entry = shim.storage.get('cache:w1');
  assert.deepEqual(entry.captureData, captureData);
  assert.equal(entry.deliveredAt, null);
  assert.equal(typeof entry.cachedAt, 'number');

  const index = shim.storage.get('cacheIndex');
  assert.equal(index.length, 1);
  assert.deepEqual(index[0], {
    captureId: 'w1',
    kind: 'passive',
    cachedAt: entry.cachedAt,
    deliveredAt: null,
    startedAt: captureData.startedAt,
    endedAt: captureData.endedAt,
    pageCount: 1,
    trivial: false
  });
});

test('writeExportCache: index summary kind is "active" only when captureData.kind is "active"', async () => {
  shim.reset();
  await writeExportCache({ ...capture('w2'), kind: 'active' });

  const [summary] = shim.storage.get('cacheIndex');
  assert.equal(summary.kind, 'active');
});

test('writeExportCache: never rewrites entries that stay -- only appends + prunes', async () => {
  shim.reset();
  await writeExportCache(capture('w3'));
  const firstEntry = shim.storage.get('cache:w3');

  await writeExportCache(capture('w4'));

  assert.equal(shim.storage.get('cache:w3'), firstEntry); // same object identity: untouched
  assert.equal(shim.storage.get('cacheIndex').length, 2);
});

test('writeExportCache: TTL-expired entries are pruned -- entry key removed, summary dropped', async () => {
  shim.reset();
  const staleCachedAt = Date.now() - CONFIG.EXPORT_CACHE_TTL_MS - 1000;
  const staleCapture = capture('stale1');
  shim.storage.set('cache:stale1', { captureData: staleCapture, cachedAt: staleCachedAt, deliveredAt: null });
  shim.storage.set('cacheIndex', [{
    captureId: 'stale1',
    kind: 'passive',
    cachedAt: staleCachedAt,
    deliveredAt: null,
    startedAt: staleCapture.startedAt,
    endedAt: staleCapture.endedAt,
    pageCount: 1,
    trivial: false
  }]);

  await writeExportCache(capture('fresh1'));

  assert.equal(shim.storage.get('cache:stale1'), undefined);
  assert.deepEqual(shim.storage.get('cacheIndex').map(s => s.captureId), ['fresh1']);
});

test('writeExportCache: caps at EXPORT_CACHE_MAX_ENTRIES, dropping the oldest beyond the cap', async () => {
  shim.reset();
  const now = Date.now();
  const seedIndex = [];
  for (let i = 0; i < CONFIG.EXPORT_CACHE_MAX_ENTRIES; i++) {
    const id = `cap${i}`;
    const c = capture(id);
    const cachedAt = now - (CONFIG.EXPORT_CACHE_MAX_ENTRIES - i);
    shim.storage.set(`cache:${id}`, { captureData: c, cachedAt, deliveredAt: null });
    seedIndex.push({
      captureId: id,
      kind: 'passive',
      cachedAt,
      deliveredAt: null,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      pageCount: 1,
      trivial: false
    });
  }
  shim.storage.set('cacheIndex', seedIndex);

  await writeExportCache(capture('overflow'));

  const index = shim.storage.get('cacheIndex');
  assert.equal(index.length, CONFIG.EXPORT_CACHE_MAX_ENTRIES);
  assert.equal(index[index.length - 1].captureId, 'overflow');
  assert.equal(index[0].captureId, 'cap1'); // cap0 was the oldest -- dropped
  assert.equal(shim.storage.get('cache:cap0'), undefined);
  assert.ok(shim.storage.get('cache:cap1'));
});

test('markDelivered: sets deliveredAt on both the entry and its index summary', async () => {
  shim.reset();
  await writeExportCache(capture('m1'));

  await markDelivered('m1');

  const entry = shim.storage.get('cache:m1');
  assert.equal(typeof entry.deliveredAt, 'number');

  const [summary] = shim.storage.get('cacheIndex');
  assert.equal(summary.deliveredAt, entry.deliveredAt);
});

test('markDelivered: idempotent -- a second call does not overwrite an existing deliveredAt', async () => {
  shim.reset();
  await writeExportCache(capture('m2'));
  await markDelivered('m2');
  const firstDeliveredAt = shim.storage.get('cache:m2').deliveredAt;

  await markDelivered('m2');

  assert.equal(shim.storage.get('cache:m2').deliveredAt, firstDeliveredAt);
  assert.equal(shim.storage.get('cacheIndex')[0].deliveredAt, firstDeliveredAt);
});

test('markDelivered: no-op when the entry is missing (evicted or never cached)', async () => {
  shim.reset();
  await markDelivered('missing');
  assert.equal(shim.storage.get('cache:missing'), undefined);
  assert.equal(shim.storage.get('cacheIndex'), undefined);
});

// ── Serialization (writeExportCache / markDelivered race) ──────────────────

test('writeExportCache + markDelivered interleaved without awaiting still land both changes', async () => {
  shim.reset();
  // Kicked off back-to-back with no `await` in between -- without
  // serialization, markDelivered's read-modify-write of `cacheIndex` could
  // interleave with writeExportCache's own read-modify-write and one would
  // clobber the other's change on write-back.
  const p1 = writeExportCache(capture('race1'));
  const p2 = markDelivered('race1');
  await Promise.all([p1, p2]);

  const entry = shim.storage.get('cache:race1');
  assert.ok(entry, 'entry should exist');
  assert.equal(typeof entry.deliveredAt, 'number');

  const index = shim.storage.get('cacheIndex');
  const summary = index.find(s => s.captureId === 'race1');
  assert.ok(summary, 'index should contain the new summary');
  assert.equal(summary.deliveredAt, entry.deliveredAt);
});

test('readCacheIndex: empty when nothing is cached', async () => {
  shim.reset();
  assert.deepEqual(await readCacheIndex(), []);
});

test('readCacheEntry: returns the full entry, or null when missing', async () => {
  shim.reset();
  await writeExportCache(capture('r1'));

  const entry = await readCacheEntry('r1');
  assert.equal(entry.captureData.captureId, 'r1');
  assert.equal(await readCacheEntry('nope'), null);
});

test('readAllCacheEntries: returns one entry per index summary, skipping any missing', async () => {
  shim.reset();
  await writeExportCache(capture('a1'));
  await writeExportCache(capture('a2'));
  shim.storage.delete('cache:a1'); // simulate an entry evicted out from under the index

  const entries = await readAllCacheEntries();
  assert.deepEqual(entries.map(e => e.captureData.captureId), ['a2']);
});

test('ensureCacheV2 (via readCacheIndex): migrates a legacy exportCache array into entries + index, then removes it', async () => {
  shim.reset();
  const now = Date.now();
  shim.storage.set('exportCache', [
    legacyCacheEntry('leg1', now - 3000),
    legacyCacheEntry('leg2', now - 2000, now - 1000),
    legacyCacheEntry('leg3', now - 1000)
  ]);

  const index = await readCacheIndex();

  assert.equal(index.length, 3);
  assert.deepEqual(index.map(s => s.captureId), ['leg1', 'leg2', 'leg3']);
  assert.equal(shim.storage.get('exportCache'), undefined);

  const entry2 = shim.storage.get('cache:leg2');
  assert.equal(entry2.deliveredAt, now - 1000);
  assert.equal(index[1].deliveredAt, now - 1000);
});

test('ensureCacheV2: a second call is a no-op once migrated', async () => {
  shim.reset();
  shim.storage.set('exportCache', [legacyCacheEntry('once1', Date.now())]);

  await readCacheIndex();
  const afterFirst = shim.storage.get('cacheIndex');

  await ensureCacheV2();
  const afterSecond = shim.storage.get('cacheIndex');

  assert.equal(afterFirst, afterSecond); // untouched: same array reference
  assert.equal(afterSecond.length, 1);
});

test('ensureCacheV2: skips legacy ids already present in the index (no duplicates)', async () => {
  shim.reset();
  const now = Date.now();
  shim.storage.set('cacheIndex', [{
    captureId: 'dup1',
    kind: 'passive',
    cachedAt: now - 500,
    deliveredAt: null,
    startedAt: capture('dup1').startedAt,
    endedAt: capture('dup1').endedAt,
    pageCount: 1,
    trivial: false
  }]);
  shim.storage.set('exportCache', [
    legacyCacheEntry('dup1', now - 500),
    legacyCacheEntry('new1', now - 100)
  ]);

  const index = await readCacheIndex();

  assert.deepEqual(index.map(s => s.captureId), ['dup1', 'new1']);
});

test('ensureCacheV2: migrates a legacy element shaped { sessionData, cachedAt } (pre-captureData rename)', async () => {
  shim.reset();
  const now = Date.now();
  const legacyCapture = capture('sess1');
  shim.storage.set('exportCache', [
    { sessionData: legacyCapture, cachedAt: now - 5000 }
  ]);

  const index = await readCacheIndex();

  assert.equal(index.length, 1);
  assert.equal(index[0].captureId, 'sess1');
  assert.equal(shim.storage.get('exportCache'), undefined);

  const entry = shim.storage.get('cache:sess1');
  assert.deepEqual(entry.captureData, legacyCapture);
  assert.equal(entry.cachedAt, now - 5000);
  assert.equal(entry.deliveredAt, null);
});

// ── flushPendingExports ──────────────────────────────────────────────────────

test('flushPendingExports: empty queue at entry returns the zero object and clears the alarm', async () => {
  shim.reset();
  const result = await flushPendingExports();
  assert.deepEqual(result, EMPTY_FLUSH);
  assert.deepEqual(shim.alarms.cleared, [CONFIG.FLUSH_ALARM_NAME]);
});

test('flushPendingExports: caps at FLUSH_BATCH_MAX attempts per pass (batch_cap)', async () => {
  shim.reset();
  shim.storage.set('pendingExports', items(12));
  fetchQueue(Array.from({ length: 10 }, () => ({ status: 200, json: { status: 'saved' } })));

  const result = await flushPendingExports();

  assert.equal(result.attempted, 10);
  assert.equal(result.delivered, 10);
  assert.equal(result.remaining, 2);
  assert.equal(result.stop, 'batch_cap');
  assert.deepEqual(
    shim.storage.get('pendingExports').map(i => i.captureId),
    ['c10', 'c11']
  );
  assert.ok(shim.alarms.created.some(a => a.name === CONFIG.FLUSH_ALARM_NAME));
});

test('flushPendingExports: 429 stops the pass, keeps this item + remaining in order', async () => {
  shim.reset();
  shim.storage.set('pendingExports', items(3, 'x'));
  fetchQueue([
    { status: 200, json: {} },
    { status: 429, json: { detail: 'Rate limit exceeded: 20 per 1 minute' } }
  ]);
  const warn = spyWarn();

  const result = await flushPendingExports();
  warn.restore();

  assert.equal(result.attempted, 2);
  assert.equal(result.delivered, 1);
  assert.equal(result.remaining, 2);
  assert.equal(result.stop, 'rate_limited');
  assert.equal(result.lastError, 'HTTP 429');
  assert.deepEqual(
    shim.storage.get('pendingExports').map(i => i.captureId),
    ['x1', 'x2']
  );
  assert.ok(warn.calls.length > 0);
});

test('flushPendingExports: 401 stops the pass with stop "auth", keeps all remaining', async () => {
  shim.reset();
  shim.storage.set('pendingExports', items(3, 'y'));
  fetchQueue([{ status: 401, json: { detail: 'bad key' } }]);

  const result = await flushPendingExports();

  assert.equal(result.attempted, 1);
  assert.equal(result.delivered, 0);
  assert.equal(result.remaining, 3);
  assert.equal(result.stop, 'auth');
  assert.deepEqual(
    shim.storage.get('pendingExports').map(i => i.captureId),
    ['y0', 'y1', 'y2']
  );
});

test('flushPendingExports: 403 also stops the pass with stop "auth"', async () => {
  shim.reset();
  shim.storage.set('pendingExports', items(1, 'z'));
  fetchQueue([{ status: 403, json: {} }]);

  const result = await flushPendingExports();

  assert.equal(result.stop, 'auth');
  assert.equal(result.remaining, 1);
});

test('flushPendingExports: network throw stops with "offline", preserves un-iterated items in order', async () => {
  shim.reset();
  shim.storage.set('pendingExports', items(3, 'n'));
  fetchQueue([{ status: 200, json: {} }, { throw: 'fetch failed' }]);
  const warn = spyWarn();

  const result = await flushPendingExports();
  warn.restore();

  assert.equal(result.attempted, 2);
  assert.equal(result.delivered, 1);
  assert.equal(result.remaining, 2);
  assert.equal(result.stop, 'offline');
  assert.deepEqual(
    shim.storage.get('pendingExports').map(i => i.captureId),
    ['n1', 'n2']
  );
  // console.warn must have received the actual caught error object, not a
  // stringified message.
  assert.ok(warn.calls.some(args => args.some(a => a instanceof Error)));
});

test('flushPendingExports: other non-2xx (e.g. 422) keeps just that item and continues', async () => {
  shim.reset();
  shim.storage.set('pendingExports', items(2, 'm'));
  fetchQueue([
    { status: 422, json: { detail: 'bad payload' } },
    { status: 200, json: {} }
  ]);

  const result = await flushPendingExports();

  assert.equal(result.attempted, 2);
  assert.equal(result.delivered, 1);
  assert.equal(result.remaining, 1);
  assert.equal(result.stop, null);
  assert.deepEqual(shim.storage.get('pendingExports').map(i => i.captureId), ['m0']);
});

test('flushPendingExports: 409 counts as delivered', async () => {
  shim.reset();
  shim.storage.set('pendingExports', [{ captureId: 'dup' }]);
  fetchQueue([{ status: 409, json: { detail: 'already stored' } }]);

  const result = await flushPendingExports();

  assert.equal(result.delivered, 1);
  assert.equal(result.remaining, 0);
  assert.equal(result.stop, null);
  assert.deepEqual(shim.storage.get('pendingExports'), []);
});

test('flushPendingExports: alarm is cleared once the queue fully drains', async () => {
  shim.reset();
  shim.storage.set('pendingExports', items(1, 'd'));
  fetchQueue([{ status: 200, json: {} }]);

  const result = await flushPendingExports();

  assert.equal(result.remaining, 0);
  assert.deepEqual(shim.alarms.cleared, [CONFIG.FLUSH_ALARM_NAME]);
});

test('flushPendingExports: delivering a buffered item also marks its v2 cache entry + index summary delivered', async () => {
  shim.reset();
  await writeExportCache(capture('flush-mark'));
  shim.storage.set('pendingExports', [{ captureId: 'flush-mark' }]);
  fetchQueue([{ status: 200, json: {} }]);

  const result = await flushPendingExports();
  assert.equal(result.delivered, 1);

  const entry = await readCacheEntry('flush-mark');
  assert.equal(typeof entry.deliveredAt, 'number');
  const index = await readCacheIndex();
  assert.equal(index.find(s => s.captureId === 'flush-mark').deliveredAt, entry.deliveredAt);
});

test('flushPendingExports: stored invalid API key stops the pass as "auth" without ever calling fetch', async () => {
  shim.reset();
  const badKey = 'cmp_abc—def'; // em dash, U+2014
  shim.storage.set('apiKey', badKey);
  shim.storage.set('pendingExports', items(2, 'k'));
  const calls = fetchQueue([]); // any fetch call is a bug -- nothing queued
  const warn = spyWarn();

  const result = await flushPendingExports();
  warn.restore();

  assert.equal(calls.length, 0);
  assert.equal(result.attempted, 1);
  assert.equal(result.delivered, 0);
  assert.equal(result.remaining, 2);
  assert.equal(result.stop, 'auth');
  assert.match(result.lastError, /U\+2014/);
  assert.ok(!result.lastError.includes(badKey));
  assert.ok(!result.lastError.includes('cmp_abc'));
  assert.deepEqual(
    shim.storage.get('pendingExports').map(i => i.captureId),
    ['k0', 'k1']
  );
  assert.ok(warn.calls.some(args => args.some(a => a instanceof Error)));
});

// ── flushPendingExports: re-entrancy guard ──────────────────────────────────

test('flushPendingExports: concurrent calls share one in-flight pass', async () => {
  shim.reset();
  const n = 4;
  shim.storage.set('pendingExports', items(n, 'e'));
  const calls = fetchQueue(Array.from({ length: n }, () => ({ status: 200, json: {} })));

  const [r1, r2] = await Promise.all([flushPendingExports(), flushPendingExports()]);

  assert.equal(calls.length, n);
  assert.equal(r1, r2); // same result object, not just equal contents
  assert.equal(r1.delivered, n);
  assert.deepEqual(shim.storage.get('pendingExports'), []);
});

test('flushPendingExports: after an in-flight pass resolves, a fresh call starts a new pass', async () => {
  shim.reset();
  shim.storage.set('pendingExports', items(1, 'g'));
  fetchQueue([{ status: 200, json: {} }]);

  const first = await flushPendingExports();
  assert.equal(first.delivered, 1);

  shim.storage.set('pendingExports', items(1, 'h'));
  fetchQueue([{ status: 200, json: {} }]);

  const second = await flushPendingExports();
  assert.equal(second.delivered, 1);
  assert.notEqual(first, second);
});

// ── flushPendingExports: mid-pass buffering isn't clobbered ─────────────────

test('flushPendingExports: an item buffered mid-pass by a concurrent exportCapture survives the rewrite', async () => {
  shim.reset();
  shim.storage.set('pendingExports', items(2, 'f'));
  fetchQueue([
    { status: 200, json: {} },
    { status: 200, json: {} }
  ]);
  const stubbedFetch = globalThis.fetch;
  let first = true;
  globalThis.fetch = async (...args) => {
    if (first) {
      first = false;
      // Simulate exportCapture() pushing a brand-new capture into storage
      // while this pass is already running.
      const current = shim.storage.get('pendingExports') || [];
      shim.storage.set('pendingExports', [...current, { captureId: 'mid-pass' }]);
    }
    return stubbedFetch(...args);
  };

  const result = await flushPendingExports();

  assert.equal(result.attempted, 2);
  assert.equal(result.delivered, 2);
  assert.equal(result.remaining, 1);
  assert.deepEqual(
    shim.storage.get('pendingExports').map(i => i.captureId),
    ['mid-pass']
  );
});

// ── retrySingleExport ────────────────────────────────────────────────────────

test('retrySingleExport: 2xx delivers, removes the item, marks delivered', async () => {
  shim.reset();
  shim.storage.set('pendingExports', [{ captureId: 'r1' }]);
  fetchQueue([{ status: 200, json: {} }]);

  const result = await retrySingleExport('r1');

  assert.deepEqual(result, { success: true, delivery: 'delivered' });
  assert.deepEqual(shim.storage.get('pendingExports'), []);
});

test('retrySingleExport: 409 also delivers', async () => {
  shim.reset();
  shim.storage.set('pendingExports', [{ captureId: 'r2' }]);
  fetchQueue([{ status: 409, json: {} }]);

  const result = await retrySingleExport('r2');

  assert.deepEqual(result, { success: true, delivery: 'delivered' });
  assert.deepEqual(shim.storage.get('pendingExports'), []);
});

test('retrySingleExport: non-2xx returns the HTTP status and logs it', async () => {
  shim.reset();
  shim.storage.set('pendingExports', [{ captureId: 'r3' }]);
  fetchQueue([{ status: 401, json: {} }]);
  const warn = spyWarn();

  const result = await retrySingleExport('r3');
  warn.restore();

  assert.deepEqual(result, { success: false, delivery: 'backend_error', status: 401 });
  assert.ok(warn.calls.length > 0);
});

test('retrySingleExport: throw returns the error message and logs the error object', async () => {
  shim.reset();
  shim.storage.set('pendingExports', [{ captureId: 'r4' }]);
  fetchQueue([{ throw: 'boom' }]);
  const warn = spyWarn();

  const result = await retrySingleExport('r4');
  warn.restore();

  assert.equal(result.success, false);
  assert.equal(result.delivery, 'backend_offline');
  assert.equal(result.error, 'boom');
  assert.ok(warn.calls.some(args => args.some(a => a instanceof Error)));
});

test('retrySingleExport: unknown captureId returns not_found', async () => {
  shim.reset();
  shim.storage.set('pendingExports', []);

  const result = await retrySingleExport('missing');

  assert.deepEqual(result, { success: false, delivery: 'not_found' });
});

test('retrySingleExport: delivering also marks its v2 cache entry + index summary delivered', async () => {
  shim.reset();
  await writeExportCache(capture('retry-mark'));
  shim.storage.set('pendingExports', [{ captureId: 'retry-mark' }]);
  fetchQueue([{ status: 200, json: {} }]);

  const result = await retrySingleExport('retry-mark');
  assert.equal(result.success, true);

  const entry = await readCacheEntry('retry-mark');
  assert.equal(typeof entry.deliveredAt, 'number');
  const index = await readCacheIndex();
  assert.equal(index.find(s => s.captureId === 'retry-mark').deliveredAt, entry.deliveredAt);
});

test('retrySingleExport: stored invalid API key returns backend_error and never leaks the key', async () => {
  shim.reset();
  const badKey = 'cmp_abc—def'; // em dash, U+2014
  shim.storage.set('apiKey', badKey);
  shim.storage.set('pendingExports', [{ captureId: 'r5' }]);
  const calls = fetchQueue([]); // any fetch call is a bug -- nothing queued
  const warn = spyWarn();

  const result = await retrySingleExport('r5');
  warn.restore();

  assert.equal(calls.length, 0);
  assert.equal(result.success, false);
  assert.equal(result.delivery, 'backend_error');
  assert.match(result.error, /U\+2014/);
  assert.ok(!result.error.includes(badKey));
  assert.ok(!result.error.includes('cmp_abc'));
  assert.ok(warn.calls.some(args => args.some(a => a instanceof Error)));
});

// ── retrySingleExport: mid-request buffering isn't clobbered ───────────────

test('retrySingleExport: an item buffered mid-request by a concurrent exportCapture survives the rewrite', async () => {
  shim.reset();
  shim.storage.set('pendingExports', [{ captureId: 'A' }, { captureId: 'B' }]);
  fetchQueue([{ status: 200, json: {} }]);
  const stubbedFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    // Simulate exportCapture() pushing a brand-new capture into storage
    // while this retry request is in flight.
    const current = shim.storage.get('pendingExports') || [];
    shim.storage.set('pendingExports', [...current, { captureId: 'C' }]);
    return stubbedFetch(...args);
  };

  const result = await retrySingleExport('A');

  assert.deepEqual(result, { success: true, delivery: 'delivered' });
  assert.deepEqual(
    shim.storage.get('pendingExports').map(i => i.captureId),
    ['B', 'C']
  );
});

// ── exportPassiveCapture / exportActiveCapture (exportCapture core) ─────────

function passiveCapture(id, pages = 1) {
  return {
    captureId: id,
    startedAt: '2026-09-09T00:00:00.000Z',
    endedAt: '2026-09-09T00:01:00.000Z',
    pages: Array.from({ length: pages }, () => ({})),
    events: [],
    trivial: pages < 3
  };
}

test('exportPassiveCapture: delivered path returns { delivery, body, flush } with the post-pass flush', async () => {
  shim.reset();
  fetchQueue([{ status: 200, json: { status: 'saved', captureId: 'p1', pageCount: 2 } }]);

  const result = await exportPassiveCapture(passiveCapture('p1', 2));

  assert.equal(result.delivery, 'delivered');
  assert.deepEqual(result.body, { status: 'saved', captureId: 'p1', pageCount: 2 });
  // The item was already removed before the post-delivery flush pass runs,
  // so the queue is empty and flush returns the zero object (and clears
  // the alarm, since nothing is pending after this delivery).
  assert.deepEqual(result.flush, EMPTY_FLUSH);
});

test('exportPassiveCapture: delivered path also flushes older buffered items (delivered-with-older-items)', async () => {
  shim.reset();
  shim.storage.set('pendingExports', items(2, 'o'));
  fetchQueue([
    { status: 200, json: { status: 'saved', captureId: 'new1', pageCount: 1 } }, // the new capture
    { status: 200, json: {} }, // o0, flushed
    { status: 200, json: {} }  // o1, flushed
  ]);

  const result = await exportPassiveCapture(passiveCapture('new1', 1));

  assert.equal(result.delivery, 'delivered');
  assert.equal(result.flush.delivered, 2);
  assert.deepEqual(shim.storage.get('pendingExports'), []);
  assert.deepEqual(shim.alarms.cleared, [CONFIG.FLUSH_ALARM_NAME]);
});

test('exportPassiveCapture: 409 on first attempt is also delivered', async () => {
  shim.reset();
  fetchQueue([{ status: 409, json: {} }]);

  const result = await exportPassiveCapture(passiveCapture('p1dup', 1));

  assert.equal(result.delivery, 'delivered');
});

test('exportPassiveCapture: non-2xx buffers, logs the status, and ensures the alarm', async () => {
  shim.reset();
  fetchQueue([{ status: 500, json: {} }]);
  const warn = spyWarn();

  const result = await exportPassiveCapture(passiveCapture('p2', 1));
  warn.restore();

  assert.equal(result.delivery, 'buffered');
  assert.equal(result.body, null);
  assert.equal(result.flush, null);
  assert.ok(shim.alarms.created.some(a => a.name === CONFIG.FLUSH_ALARM_NAME));
  assert.ok(warn.calls.length > 0);
  assert.deepEqual(shim.storage.get('pendingExports').map(i => i.captureId), ['p2']);
});

test('exportPassiveCapture: network throw buffers, logs the caught error object, and ensures the alarm', async () => {
  shim.reset();
  fetchQueue([{ throw: 'network unreachable' }]);
  const warn = spyWarn();

  const result = await exportPassiveCapture(passiveCapture('p3', 1));
  warn.restore();

  assert.equal(result.delivery, 'buffered');
  assert.ok(shim.alarms.created.some(a => a.name === CONFIG.FLUSH_ALARM_NAME));
  assert.ok(warn.calls.some(args => args.some(a => a instanceof Error)));
});

test('exportPassiveCapture: records a completedCaptures entry regardless of delivery outcome', async () => {
  shim.reset();
  fetchQueue([{ status: 200, json: {} }]);

  await exportPassiveCapture(passiveCapture('p4', 1));

  const completed = shim.storage.get('completedCaptures');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].captureId, 'p4');
});

test('exportActiveCapture: delivered path returns body and the post-pass flush', async () => {
  shim.reset();
  const calls = fetchQueue([{ status: 200, json: { journeyUrl: 'https://x.test/j/1' } }]);

  const result = await exportActiveCapture({
    captureId: 'j1',
    startedAt: '2026-09-09T00:00:00.000Z',
    endedAt: '2026-09-09T00:05:00.000Z',
    pages: [{}],
    events: []
  });

  assert.equal(result.delivery, 'delivered');
  assert.equal(result.body.journeyUrl, 'https://x.test/j/1');
  assert.deepEqual(result.flush, EMPTY_FLUSH);
  assert.match(calls[0].url, /\/api\/captures$/);
});
