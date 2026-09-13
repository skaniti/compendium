/**
 * Active Tracker — user-initiated journey lifecycle.
 *
 * Start/stop controlled by the user via popup. Runs concurrently
 * alongside the passive tracker — both receive the same page events.
 * Exports to main backend only (default port 8001; configurable via popup).
 */

import { generateCaptureId, createEmptyCapture } from './utils.js';
import { recordCurrentPage, recordPageVisit } from './tracker-core.js';
import { writeExportCache, exportActiveCapture } from './export.js';

let state = createEmptyCapture();
state.isTracking = false;

export function getState() {
  return state;
}

export function isTracking() {
  return state.isTracking;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function persistState() {
  chrome.storage.local.set({
    activeCapture: {
      isTracking: state.isTracking,
      captureId: state.captureId,
      startTime: state.startTime,
      pages: state.pages,
      events: state.events,
      currentPage: state.currentPage,
      currentPageStartTime: state.currentPageStartTime
    }
  });
}

/** Exposed for tracker-core callbacks. */
export function persist() {
  persistState();
}

// ── Capture Lifecycle ────────────────────────────────────────────────────────

export async function startCapture() {
  state = {
    isTracking: true,
    captureId: generateCaptureId(),
    startTime: Date.now(),
    lastActivityTime: null,
    pages: [],
    events: [],
    currentPage: null,
    currentPageStartTime: null
  };

  persistState();

  // Record the current tab as the first page
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && activeTab.url) {
    recordPageVisit(
      state, activeTab.url, activeTab.title,
      null, null, activeTab.id,
      'Journey', () => persistState()
    );
  }

  console.log(`[Journey] Capture started: ${state.captureId}`);
}

export async function stopCapture() {
  if (!state.isTracking) return;

  // Flip guard immediately to prevent re-entry
  state.isTracking = false;

  recordCurrentPage(state);

  const captureData = {
    captureId: state.captureId,
    startedAt: new Date(state.startTime).toISOString(),
    endedAt: new Date().toISOString(),
    pages: state.pages,
    events: state.events,
    // Stamped here (not only in exportActiveCapture) so the cache entry and
    // its index summary know this was a journey; the backend ignores it.
    kind: 'active'
  };

  // Write to retention cache BEFORE wiping state (parity with passive)
  writeExportCache(captureData);

  // Reset state before export
  state = createEmptyCapture();
  state.isTracking = false;

  // Save as last capture for viewing, and clear active storage
  await chrome.storage.local.set({
    lastCapture: captureData,
    activeCapture: null
  });

  console.log(`[Journey] Capture stopped: ${captureData.captureId} (${captureData.pages.length} pages)`);

  // Deliver via the shared ring + pending-queue machinery (0.4.1: journeys
  // are no longer fire-and-forget — an unreachable backend buffers them and
  // the wake-time flush retries against /api/captures).
  const { delivery, body } = await exportActiveCapture(captureData);
  if (delivery === 'delivered' && body && body.journeyUrl) {
    await chrome.storage.local.set({ lastJourneyUrl: body.journeyUrl });
  }
}

// ── Restore ──────────────────────────────────────────────────────────────────

export async function restoreState() {
  const data = await chrome.storage.local.get('activeCapture');
  const saved = data.activeCapture;

  if (saved && saved.isTracking && saved.captureId) {
    state = {
      isTracking: true,
      captureId: saved.captureId,
      startTime: saved.startTime,
      lastActivityTime: null,
      pages: saved.pages || [],
      events: saved.events || [],
      currentPage: saved.currentPage || null,
      currentPageStartTime: saved.currentPageStartTime || null
    };
    console.log(`[Journey] Restored capture: ${state.captureId} (${state.pages.length} pages)`);
  }
}
