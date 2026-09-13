/**
 * Export module — delivery, buffering, retry, and cache.
 *
 * All captures (passive + active) go to the main backend.
 * Passive → POST /api/passive-captures
 * Active  → POST /api/captures
 *
 * Both kinds share the same durability machinery: the retention cache
 * (writeExportCache, see "Cache storage (v2)" below) first, then a
 * pendingExports queue flushed by flushPendingExports(). A flush pass
 * self-paces (spec D4): at most CONFIG.FLUSH_BATCH_MAX requests, stopping
 * early on 429 ('rate_limited'), 401/403 ('auth'), or a network/TypeError
 * ('offline') so the remaining queue stays intact and in order. There is no
 * Retry-After from the server, so draining a large backlog relies on the
 * periodic CONFIG.FLUSH_ALARM_NAME alarm (spec D7, background.js) rather
 * than retrying in a tight loop — ensureFlushAlarm()/clearFlushAlarm() keep
 * that alarm present iff the queue is non-empty. Queue items carry
 * `kind: 'active'` for journeys (absent/other = passive); the field also
 * rides along in the POST body, which the backend ignores
 * (models use extra="ignore").
 *
 * Capture payload shape is a three-way twin: the objects built here, the
 * PassiveCaptureInput model in apps/api/backend/models/capture.py, and
 * SessionData in
 * apps/android/app/src/main/java/dev/skaniti/compendium/model/SessionData.kt.
 *
 * ── Cache storage (v2) ───────────────────────────────────────────────────────
 * Retention storage is split so a finalize never rewrites one big array, and
 * listing the History view never loads any capture's page text:
 *   - `cacheIndex`: an array of lightweight summaries, oldest-first --
 *     { captureId, kind: 'active'|'passive', cachedAt, deliveredAt,
 *       startedAt, endedAt, pageCount, trivial }. This is what cache.js
 *     lists, sorts, and groups by month; it never carries `pages`/`events`.
 *   - One full entry per capture under key `'cache:' + captureId` --
 *     { captureData, cachedAt, deliveredAt }. Read individually
 *     (readCacheEntry) when a History card is expanded, or in bulk
 *     (readAllCacheEntries) for "Download all as ZIP".
 * Retention (CONFIG.EXPORT_CACHE_TTL_MS, CONFIG.EXPORT_CACHE_MAX_ENTRIES) is
 * enforced against the index on every writeExportCache() call: entries that
 * age/cap out have their `cache:<id>` key removed; entries that stay are
 * never rewritten.
 * Migration: v1 stored a single `exportCache` array (one element per
 * capture: `{ captureData, cachedAt, deliveredAt }`, or `{ sessionData,
 * ... }` for older-still entries). ensureCacheV2() migrates it lazily and
 * idempotently -- called at the top of writeExportCache/markDelivered/
 * readCacheIndex/readCacheEntry -- splitting each legacy element into an
 * entry + summary (skipping ids already in the index), then removing the
 * legacy key. Cheap when there is nothing to migrate: one
 * get(['exportCache']) and return.
 */

import { CONFIG, getConfig, buildHeaders, validateApiKey } from './config.js';

// ── Backend Transport ───────────────────────────────────────────────────────

function endpointFor(item) {
  return item && item.kind === 'active' ? '/api/captures' : '/api/passive-captures';
}

/**
 * A stored API key that fails validateApiKey (spec D1) must never reach
 * fetch() -- that's exactly the ByteString TypeError this batch exists to
 * fix, and it would otherwise masquerade as "backend unavailable" (offline)
 * instead of the real "auth" problem. Checked here, before the network
 * call, so every caller (flush pass, retry, live export) gets the same
 * distinguishable failure. The thrown message is validateApiKey's sanitized
 * text (names only the offending code point + position) -- never the key
 * itself; callers must log the error object, not config.apiKey.
 */
async function backendPost(captureData) {
  const config = await getConfig();
  const keyError = validateApiKey(config.apiKey);
  if (keyError) {
    const err = new Error(keyError);
    err.name = 'InvalidApiKeyError';
    throw err;
  }
  return fetch(`${config.backendUrl}${endpointFor(captureData)}`, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(captureData)
  });
}

// ── Flush Alarm (spec D7) ────────────────────────────────────────────────────

/**
 * Schedule the periodic flush alarm. Idempotent -- re-creating replaces it,
 * which restarts the 1-minute countdown from now rather than preserving
 * the original fire time. Every flush pass or buffered export that calls
 * this pushes the next fire out to "+1 min from now" instead of "+1 min
 * from the first buffer" -- acceptable: the alarm's job is just to
 * guarantee *some* periodic drain attempt while the queue is non-empty,
 * not to hit a precise cadence.
 */
export function ensureFlushAlarm() {
  chrome.alarms.create(CONFIG.FLUSH_ALARM_NAME, {
    periodInMinutes: CONFIG.FLUSH_ALARM_PERIOD_MINUTES
  });
}

/** Cancel the periodic flush alarm (queue is empty; nothing to drain). */
export function clearFlushAlarm() {
  chrome.alarms.clear(CONFIG.FLUSH_ALARM_NAME);
}

// ── Export Cache ─────────────────────────────────────────────────────────────

const CACHE_KEY_PREFIX = 'cache:';

function cacheKey(captureId) {
  return CACHE_KEY_PREFIX + captureId;
}

// Every writeExportCache/markDelivered/ensureCacheV2 call below does a
// read-modify-write against `cacheIndex` (and, for ensureCacheV2, the legacy
// `exportCache` key too). Without serialization, two such calls kicked off
// in the same tick without an `await` between them (e.g. a finalize's
// writeExportCache racing a delivery's markDelivered) would each read the
// same pre-write snapshot, and the later write-back clobbers the earlier
// call's change. `cacheChain` forces every public entry point through in
// FIFO call order, one at a time -- `fn`'s rejection is swallowed on the
// chain itself (not on the promise returned to the caller) so one failed
// mutation never permanently blocks every mutation queued after it.
//
// The public functions below call the "_...Unlocked" variant of
// ensureCacheV2 directly (never the serialized `ensureCacheV2()` export)
// while their own body is already running on the chain -- calling the
// serialized wrapper from inside would deadlock, waiting on the very link
// that's still executing.
let cacheChain = Promise.resolve();
function serialized(fn) {
  const p = cacheChain.then(fn, fn);
  cacheChain = p.catch(() => {});
  return p;
}

// The lightweight record kept in `cacheIndex` -- everything the History list
// needs to render, sort, and group WITHOUT loading the full entry (pages,
// events). kind is read off captureData.kind, the same field exportCapture()
// stamps for backend routing (absent/other = passive).
function summaryOf(captureData, cachedAt, deliveredAt) {
  return {
    captureId: captureData.captureId,
    kind: captureData.kind === 'active' ? 'active' : 'passive',
    cachedAt,
    deliveredAt: deliveredAt ?? null,
    startedAt: captureData.startedAt,
    endedAt: captureData.endedAt,
    pageCount: captureData.pages ? captureData.pages.length : 0,
    trivial: captureData.trivial
  };
}

/**
 * Lazily, idempotently migrate the legacy v1 `exportCache` array (see the
 * header comment) into the v2 layout: one `cache:<id>` entry + one
 * `cacheIndex` summary per legacy element. Ids already present in the index
 * are skipped (so a partially-migrated or re-run pass never duplicates).
 * Cheap when there's nothing to do -- a single get(['exportCache']) and
 * return, no index read, no write.
 *
 * Called at the top of writeExportCache/markDelivered/readCacheIndex/
 * readCacheEntry so every entry point sees the v2 layout regardless of
 * which one runs first after an upgrade.
 *
 * Unlocked: writeExportCache/markDelivered call this directly, since their
 * own bodies already hold the `cacheChain` slot (see `serialized` above).
 * `ensureCacheV2()` below is the serialized entry point for everyone else
 * (readCacheIndex/readCacheEntry, or a caller migrating on its own).
 */
async function _ensureCacheV2Unlocked() {
  const legacyStored = await chrome.storage.local.get('exportCache');
  const legacy = legacyStored.exportCache;
  if (!legacy || legacy.length === 0) return;

  const idxStored = await chrome.storage.local.get('cacheIndex');
  const index = idxStored.cacheIndex || [];
  const existingIds = new Set(index.map(s => s.captureId));

  const writes = {};
  const newSummaries = [];
  for (const legacyEntry of legacy) {
    const captureData = legacyEntry.captureData || legacyEntry.sessionData;
    if (!captureData || existingIds.has(captureData.captureId)) continue;

    const cachedAt = legacyEntry.cachedAt;
    const deliveredAt = legacyEntry.deliveredAt ?? null;
    writes[cacheKey(captureData.captureId)] = { captureData, cachedAt, deliveredAt };
    newSummaries.push(summaryOf(captureData, cachedAt, deliveredAt));
  }

  writes.cacheIndex = [...index, ...newSummaries];
  await chrome.storage.local.set(writes);
  await chrome.storage.local.remove('exportCache');
}

export function ensureCacheV2() {
  return serialized(_ensureCacheV2Unlocked);
}

/**
 * Write a capture's full entry + index summary, then prune the index by TTL
 * and count cap (spec: 52 weeks / CONFIG.EXPORT_CACHE_MAX_ENTRIES). Entries
 * that stay are never rewritten -- only the new entry is set, and only
 * dropped entries' `cache:<id>` keys are removed. The new entry and the
 * pruned index land in one `chrome.storage.local.set()` call so a reader
 * can never observe one without the other.
 *
 * Serialized against every other cache mutation -- see `serialized` above.
 */
export function writeExportCache(captureData) {
  return serialized(() => _writeExportCacheUnlocked(captureData));
}

async function _writeExportCacheUnlocked(captureData) {
  await _ensureCacheV2Unlocked();

  const cachedAt = Date.now();
  const idxStored = await chrome.storage.local.get('cacheIndex');
  const index = idxStored.cacheIndex || [];
  index.push(summaryOf(captureData, cachedAt, null));

  const now = Date.now();
  const notExpired = [];
  const expired = [];
  for (const summary of index) {
    if (now - summary.cachedAt < CONFIG.EXPORT_CACHE_TTL_MS) {
      notExpired.push(summary);
    } else {
      expired.push(summary);
    }
  }

  let kept = notExpired;
  let overCap = [];
  if (notExpired.length > CONFIG.EXPORT_CACHE_MAX_ENTRIES) {
    const cut = notExpired.length - CONFIG.EXPORT_CACHE_MAX_ENTRIES;
    overCap = notExpired.slice(0, cut);
    kept = notExpired.slice(cut);
  }

  await chrome.storage.local.set({
    [cacheKey(captureData.captureId)]: { captureData, cachedAt, deliveredAt: null },
    cacheIndex: kept
  });

  const dropped = [...expired, ...overCap];
  if (dropped.length > 0) {
    await chrome.storage.local.remove(dropped.map(s => cacheKey(s.captureId)));
  }
}

// Stamp the matching cache entry (and its index summary) with `deliveredAt`
// (epoch ms) so the History view can show "delivered Xm ago." Idempotent:
// only writes if the entry doesn't already have a deliveredAt. No-op if the
// entry has been evicted (TTL/cap) since finalize.
//
// Serialized against every other cache mutation -- see `serialized` above.
export function markDelivered(captureId) {
  return serialized(() => _markDeliveredUnlocked(captureId));
}

async function _markDeliveredUnlocked(captureId) {
  await _ensureCacheV2Unlocked();

  const key = cacheKey(captureId);
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry || entry.deliveredAt != null) return;

  const deliveredAt = Date.now();
  entry.deliveredAt = deliveredAt;
  await chrome.storage.local.set({ [key]: entry });

  const idxStored = await chrome.storage.local.get('cacheIndex');
  const index = idxStored.cacheIndex || [];
  const summary = index.find(s => s.captureId === captureId);
  if (summary && summary.deliveredAt == null) {
    summary.deliveredAt = deliveredAt;
    await chrome.storage.local.set({ cacheIndex: index });
  }
}

/** All history summaries, oldest-first (after lazily migrating v1 if needed). */
export async function readCacheIndex() {
  await ensureCacheV2();
  const stored = await chrome.storage.local.get('cacheIndex');
  return stored.cacheIndex || [];
}

/** One capture's full entry ({ captureData, cachedAt, deliveredAt }), or null. */
export async function readCacheEntry(captureId) {
  await ensureCacheV2();
  const key = cacheKey(captureId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

/**
 * Every full entry for every summary currently in the index (used by
 * "Download all as ZIP"). Entries missing from storage (evicted between the
 * index read and this call) are silently skipped rather than surfaced as
 * null holes.
 */
export async function readAllCacheEntries() {
  const index = await readCacheIndex();
  if (index.length === 0) return [];

  const keys = index.map(s => cacheKey(s.captureId));
  const stored = await chrome.storage.local.get(keys);
  return index.map(s => stored[cacheKey(s.captureId)]).filter(Boolean);
}

// ── Capture Export (shared passive/active core) ─────────────────────────────

/**
 * Queue a capture in pendingExports, attempt delivery, and on success
 * remove it, stamp deliveredAt, and flush any older buffered captures.
 *
 * pendingExports is the delivery-failure overlay. NOT the durability
 * store: callers write writeExportCache(captureData) BEFORE this, so the
 * full-history retention ring already has a copy. This overlay tracks
 * "what hasn't been ack'd by the server yet" so flushes can retry it;
 * items get removed on a 2xx/409.
 *
 * 409 counts as delivered (spec D3: capture_id already stored is an
 * idempotent replay, not a failure). On success, runs a flushPendingExports()
 * pass so older buffered captures ride along; that pass result is returned
 * as `flush` so callers (background.js forceFinalize) don't need a second
 * pass to report accurate counts. The buffered path (network throw OR
 * non-2xx) logs the failure and ensures the flush alarm so the periodic
 * alarm (D7) picks the item up later; it does NOT run its own flush pass
 * here (nothing new to gain — the item that just failed is the newest one).
 *
 * @returns {Promise<{delivery: 'delivered'|'buffered', body: object|null, flush: object|null}>}
 */
async function exportCapture(captureData) {
  // Provenance stamp (spec: docs/project-plans/2026-06-10-185556-capture-provenance/).
  // Applied at queue time so flushed retries carry it too; the backend drops
  // these fields harmlessly until migration 033 is deployed.
  const config = await getConfig();
  if (config.deviceLabel) captureData.deviceLabel = config.deviceLabel;
  captureData.clientMeta = { ua: navigator.userAgent };

  const pending = await chrome.storage.local.get('pendingExports');
  const pendingExports = pending.pendingExports || [];
  pendingExports.push(captureData);
  await chrome.storage.local.set({ pendingExports });

  // Attempt backend delivery
  let deliveredOk = false;
  let body = null;
  try {
    const resp = await backendPost(captureData);
    if (resp.ok || resp.status === 409) {
      deliveredOk = true;
      try {
        body = await resp.json();
      } catch {
        // Non-JSON 2xx body — delivery still counts
      }
      console.log(`[Export] Delivered to backend: ${captureData.captureId}`);
    } else {
      console.warn(`[Export] Backend rejected capture: ${captureData.captureId}`, resp.status);
    }
  } catch (err) {
    console.warn(`[Export] Backend unavailable: ${captureData.captureId}`, err);
  }

  // Remove from pending on success, flush older buffered captures too
  if (deliveredOk) {
    const fresh = await chrome.storage.local.get('pendingExports');
    const updated = (fresh.pendingExports || []).filter(
      s => s.captureId !== captureData.captureId
    );
    await chrome.storage.local.set({ pendingExports: updated });
    await markDelivered(captureData.captureId);
    const flush = await flushPendingExports();
    return { delivery: 'delivered', body, flush };
  }

  console.log(`[Export] Buffered capture for later: ${captureData.captureId}`);
  ensureFlushAlarm();
  return { delivery: 'buffered', body: null, flush: null };
}

/**
 * @returns {Promise<{delivery: 'delivered'|'buffered', body: object|null, flush: object|null}>}
 */
export async function exportPassiveCapture(captureData) {
  // Track in completedCaptures for popup display
  const stored = await chrome.storage.local.get('completedCaptures');
  const completedCaptures = stored.completedCaptures || [];
  completedCaptures.push({
    captureId: captureData.captureId,
    startedAt: captureData.startedAt,
    endedAt: captureData.endedAt,
    pageCount: captureData.pages.length,
    trivial: captureData.trivial
  });
  await chrome.storage.local.set({ completedCaptures });

  return exportCapture(captureData);
}

/**
 * Journey export — same ring + queue + flush durability as passive.
 * Returns the delivery verdict, the parsed response body (the backend
 * returns journeyUrl on success), and the post-delivery flush result.
 *
 * @returns {Promise<{delivery: 'delivered'|'buffered', body: object|null, flush: object|null}>}
 */
export async function exportActiveCapture(captureData) {
  return exportCapture({ ...captureData, kind: 'active' });
}

// ── Flush Buffered Exports ───────────────────────────────────────────────────

// Guards against overlapping passes: the periodic alarm, a live export's
// post-delivery flush, and a user-triggered Force Export can all call
// flushPendingExports() within the same tick. Without this, two passes
// would both read the same pre-pass queue snapshot and race to write
// pendingExports, and the backend would see up to 2x the intended
// requests-per-pass. A single in-flight pass is shared by every caller;
// they all resolve to the same result object.
let flushInFlight = null;

/**
 * Attempt delivery of buffered captures, oldest first, up to
 * CONFIG.FLUSH_BATCH_MAX requests per pass (spec D4 -- self-pacing since the
 * server sends no Retry-After). Stops the pass early -- preserving the
 * current item and every un-iterated item, in order -- on:
 *   - 429                     -> stop:'rate_limited'
 *   - 401/403                 -> stop:'auth' (retrying others is pointless with a bad key)
 *   - stored key invalid (InvalidApiKeyError) -> stop:'auth' (never reaches fetch)
 *   - network/TypeError throw -> stop:'offline'
 * Any other non-2xx keeps just that item and continues. 409 counts as
 * delivered (spec D3). ensures/clears CONFIG.FLUSH_ALARM_NAME by whether
 * anything remains after the pass. Concurrent callers share one in-flight
 * pass (see flushInFlight above) and get the same result object back.
 *
 * @returns {Promise<{attempted: number, delivered: number, remaining: number, stop: string|null, lastError: string|null}>}
 */
export function flushPendingExports() {
  if (flushInFlight) return flushInFlight;
  flushInFlight = runFlushPass().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

async function runFlushPass() {
  const pending = await chrome.storage.local.get('pendingExports');
  const pendingExports = pending.pendingExports || [];
  if (pendingExports.length === 0) {
    clearFlushAlarm();
    return { attempted: 0, delivered: 0, remaining: 0, stop: null, lastError: null };
  }

  let attempted = 0;
  let delivered = 0;
  let stop = null;
  let lastError = null;
  // captureIds delivered this pass. The pass does NOT write pendingExports
  // as it goes -- it only tracks who succeeded, then reconciles against a
  // fresh read of storage at the end (mirrors exportCapture's own
  // success-path pattern below). That fresh read picks up anything a
  // concurrent exportCapture() buffered mid-pass, so a capture that lands
  // while this pass is running is never clobbered by writing back a stale
  // pre-pass snapshot.
  const deliveredIds = new Set();

  for (let i = 0; i < pendingExports.length; i++) {
    if (attempted >= CONFIG.FLUSH_BATCH_MAX) {
      stop = 'batch_cap';
      break;
    }

    const item = pendingExports[i];
    attempted++;

    try {
      const resp = await backendPost(item);
      if (resp.ok || resp.status === 409) {
        console.log(`[Export] Flushed buffered capture: ${item.captureId}`);
        await markDelivered(item.captureId);
        deliveredIds.add(item.captureId);
        delivered++;
      } else if (resp.status === 429) {
        console.warn(`[Export] Flush rate limited: ${item.captureId}`, resp.status);
        lastError = `HTTP ${resp.status}`;
        stop = 'rate_limited';
        break;
      } else if (resp.status === 401 || resp.status === 403) {
        console.warn(`[Export] Flush auth failure: ${item.captureId}`, resp.status);
        lastError = `HTTP ${resp.status}`;
        stop = 'auth';
        break;
      } else {
        console.warn(`[Export] Flush failed: ${item.captureId}`, resp.status);
        lastError = `HTTP ${resp.status}`;
      }
    } catch (err) {
      if (err && err.name === 'InvalidApiKeyError') {
        // Stored key never reached fetch() -- don't let it masquerade as
        // 'offline'. Log the error object only (its message is already
        // sanitized by validateApiKey); never interpolate the key itself.
        console.warn('[Export] Flush rejected: stored API key is invalid', err);
        lastError = err.message;
        stop = 'auth';
        break;
      }
      // Backend unreachable -- stop trying; every un-iterated item (plus
      // the current one) simply stays in storage since we never removed
      // it, so no explicit re-push is needed here.
      console.warn(`[Export] Flush offline: ${item.captureId}`, err);
      lastError = err.message;
      stop = 'offline';
      break;
    }
  }

  const fresh = await chrome.storage.local.get('pendingExports');
  const freshItems = fresh.pendingExports || [];
  const remaining = freshItems.filter(i => !deliveredIds.has(i.captureId));
  await chrome.storage.local.set({ pendingExports: remaining });

  if (remaining.length > 0) {
    ensureFlushAlarm();
  } else {
    clearFlushAlarm();
  }

  return { attempted, delivered, remaining: remaining.length, stop, lastError };
}

// ── Retry Single Export (used by cache.js) ───────────────────────────────────

export async function retrySingleExport(captureId) {
  const data = await chrome.storage.local.get('pendingExports');
  const pendingExports = data.pendingExports || [];
  const idx = pendingExports.findIndex(s => s.captureId === captureId);
  if (idx === -1) return { success: false, delivery: 'not_found' };

  const item = pendingExports[idx];
  try {
    const resp = await backendPost(item);
    if (resp.ok || resp.status === 409) {
      // Re-read storage rather than writing back the pre-request snapshot
      // (mirrors runFlushPass's post-loop reconcile above) -- an
      // item pushed by a concurrent exportCapture() while this request was
      // in flight must survive the write, not get clobbered by it.
      const fresh = await chrome.storage.local.get('pendingExports');
      const updated = (fresh.pendingExports || []).filter(
        s => s.captureId !== captureId
      );
      await chrome.storage.local.set({ pendingExports: updated });
      await markDelivered(captureId);
      return { success: true, delivery: 'delivered' };
    }
    console.warn(`[Export] Retry failed: ${captureId}`, resp.status);
    return { success: false, delivery: 'backend_error', status: resp.status };
  } catch (err) {
    if (err && err.name === 'InvalidApiKeyError') {
      // Stored key never reached fetch() -- this is an auth problem, not
      // 'backend_offline'. Log the error object only (message is already
      // sanitized); never interpolate the key itself.
      console.warn(`[Export] Retry rejected: stored API key is invalid for ${captureId}`, err);
      return { success: false, delivery: 'backend_error', error: err.message };
    }
    console.warn(`[Export] Retry offline: ${captureId}`, err);
    return { success: false, delivery: 'backend_offline', error: err.message };
  }
}
