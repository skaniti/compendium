/**
 * Export module — delivery, buffering, retry, and cache.
 *
 * All captures (passive + active) go to the main backend.
 * Passive → POST /api/passive-captures
 * Active  → POST /api/captures
 *
 * Both kinds share the same durability machinery: exportCache ring first,
 * then a pendingExports queue flushed on every background wake. Queue items
 * carry `kind: 'active'` for journeys (absent/other = passive); the field
 * also rides along in the POST body, which the backend ignores
 * (models use extra="ignore").
 *
 * Capture payload shape is a three-way twin: the objects built here, the
 * PassiveCaptureInput model in apps/api/backend/models/capture.py, and
 * SessionData in
 * apps/android/app/src/main/java/dev/skaniti/compendium/model/SessionData.kt.
 */

import { CONFIG, getConfig, buildHeaders } from './config.js';

// ── Backend Transport ───────────────────────────────────────────────────────

function endpointFor(item) {
  return item && item.kind === 'active' ? '/api/captures' : '/api/passive-captures';
}

async function backendPost(captureData) {
  const config = await getConfig();
  return fetch(`${config.backendUrl}${endpointFor(captureData)}`, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(captureData)
  });
}

// ── Export Cache ─────────────────────────────────────────────────────────────

export async function writeExportCache(captureData) {
  const stored = await chrome.storage.local.get('exportCache');
  const cache = stored.exportCache || [];
  cache.push({ captureData, cachedAt: Date.now() });

  const now = Date.now();
  const pruned = cache
    .filter(entry => now - entry.cachedAt < CONFIG.EXPORT_CACHE_TTL_MS)
    .slice(-CONFIG.EXPORT_CACHE_MAX_ENTRIES);

  await chrome.storage.local.set({ exportCache: pruned });
}

// Stamp the matching exportCache entry with `deliveredAt` (epoch ms) so the
// History view can show "delivered Xm ago." Idempotent: only writes if the
// entry doesn't already have a deliveredAt. No-op if the entry has been
// evicted (TTL/cap) since finalize.
export async function markDelivered(captureId) {
  const stored = await chrome.storage.local.get('exportCache');
  const cache = stored.exportCache || [];
  let changed = false;
  for (const entry of cache) {
    const cd = entry.captureData || entry.sessionData;
    if (cd && cd.captureId === captureId && entry.deliveredAt == null) {
      entry.deliveredAt = Date.now();
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ exportCache: cache });
  }
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
 * @returns {Promise<{delivery: 'delivered'|'buffered', body: object|null}>}
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
    if (resp.ok) {
      deliveredOk = true;
      try {
        body = await resp.json();
      } catch {
        // Non-JSON 2xx body — delivery still counts
      }
      console.log(`[Export] Delivered to backend: ${captureData.captureId}`);
    }
  } catch {
    console.warn('[Export] Backend unavailable');
  }

  // Remove from pending on success, flush older buffered captures too
  if (deliveredOk) {
    const fresh = await chrome.storage.local.get('pendingExports');
    const updated = (fresh.pendingExports || []).filter(
      s => s.captureId !== captureData.captureId
    );
    await chrome.storage.local.set({ pendingExports: updated });
    await markDelivered(captureData.captureId);
    await flushPendingExports();
    return { delivery: 'delivered', body };
  }

  console.log(`[Export] Buffered capture for later: ${captureData.captureId}`);
  return { delivery: 'buffered', body: null };
}

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

  const { delivery } = await exportCapture(captureData);
  return delivery;
}

/**
 * Journey export — same ring + queue + flush durability as passive.
 * Returns the delivery verdict plus the parsed response body (the backend
 * returns journeyUrl on success).
 */
export async function exportActiveCapture(captureData) {
  return exportCapture({ ...captureData, kind: 'active' });
}

// ── Flush Buffered Exports ───────────────────────────────────────────────────

export async function flushPendingExports() {
  const pending = await chrome.storage.local.get('pendingExports');
  const pendingExports = pending.pendingExports || [];
  if (pendingExports.length === 0) return;

  const remaining = [];
  for (let i = 0; i < pendingExports.length; i++) {
    const item = pendingExports[i];
    try {
      const resp = await backendPost(item);
      if (resp.ok || resp.status === 409) {
        console.log(`[Export] Flushed buffered capture: ${item.captureId}`);
        await markDelivered(item.captureId);
      } else {
        remaining.push(item);
      }
    } catch {
      // Backend unreachable -- preserve the current item AND every
      // un-iterated item still in the queue, then stop trying. Without
      // the slice, the prior `break` would silently drop everything
      // after index i on the first network failure.
      remaining.push(...pendingExports.slice(i));
      break;
    }
  }
  await chrome.storage.local.set({ pendingExports: remaining });
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
    if (resp.ok) {
      pendingExports.splice(idx, 1);
      await chrome.storage.local.set({ pendingExports });
      await markDelivered(captureId);
      return { success: true, delivery: 'delivered' };
    }
    return { success: false, delivery: 'backend_error' };
  } catch {
    return { success: false, delivery: 'backend_offline' };
  }
}
