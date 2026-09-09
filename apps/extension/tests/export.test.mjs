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
  clearFlushAlarm
} = await import('../modules/export.js');

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
