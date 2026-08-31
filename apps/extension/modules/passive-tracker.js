/**
 * Passive Tracker — always-on capture lifecycle.
 *
 * Auto-creates captures on first activity, auto-finalizes after
 * 60 minutes of inactivity. Trivial captures (< 3 pages) are held
 * back to accumulate into the next browsing burst. Uses Chrome
 * alarms as a backup timer.
 */

import { CONFIG } from './config.js';
import { generateCaptureId, createEmptyCapture } from './utils.js';
import { recordCurrentPage } from './tracker-core.js';
import { exportPassiveCapture, writeExportCache } from './export.js';

let state = createEmptyCapture();

export function getState() {
  return state;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function persistState() {
  chrome.storage.local.set({
    passiveCapture: {
      captureId: state.captureId,
      startTime: state.startTime,
      lastActivityTime: state.lastActivityTime,
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

// ── Gap Detection ────────────────────────────────────────────────────────────

export function updateLastActivity() {
  state.lastActivityTime = Date.now();
  persistState();

  // Reset the backup alarm — fires 61 min from now if no further activity
  chrome.alarms.create(CONFIG.ALARM_NAME, {
    delayInMinutes: CONFIG.ALARM_DELAY_MINUTES
  });
}

function checkCaptureGap() {
  if (!state.captureId || !state.lastActivityTime) return false;
  return (Date.now() - state.lastActivityTime) >= CONFIG.INACTIVITY_TIMEOUT_MS;
}

function isCaptureAged() {
  if (!state.captureId || !state.startTime) return false;
  return (Date.now() - state.startTime) >= CONFIG.MAX_CAPTURE_AGE_MS;
}

// ── Capture Lifecycle ────────────────────────────────────────────────────────

export function ensureCapture() {
  // If gap detected, decide whether to finalize or hold back
  if (state.captureId && checkCaptureGap()) {
    const trivial = state.pages.length < CONFIG.TRIVIAL_THRESHOLD;
    const aged = isCaptureAged();

    if (trivial && !aged) {
      // Hold back trivial capture — keep it open for accumulation
      console.log(`[Passive] Trivial capture held back (${state.pages.length} pages, waiting for more)`);
    } else {
      finalizeCapture();
    }
  }

  // Create new capture if none active
  if (!state.captureId) {
    state = {
      captureId: generateCaptureId(),
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      pages: [],
      events: [],
      currentPage: null,
      currentPageStartTime: null
    };
    persistState();
    console.log(`[Passive] New capture started: ${state.captureId}`);
  }
}

export function finalizeCapture(force = false) {
  if (!state.captureId || state.pages.length === 0) {
    state = createEmptyCapture();
    persistState();
    return { status: 'no_capture' };
  }

  recordCurrentPage(state);

  const captureData = {
    captureId: state.captureId,
    startedAt: new Date(state.startTime).toISOString(),
    endedAt: new Date(state.lastActivityTime).toISOString(),
    pages: state.pages,
    events: state.events,
    trivial: state.pages.length < CONFIG.TRIVIAL_THRESHOLD
  };

  // Write to retention cache BEFORE wiping state
  writeExportCache(captureData);

  // Reset state immediately to prevent re-entry
  state = createEmptyCapture();
  persistState();

  console.log(`[Passive] Capture finalized: ${captureData.captureId} (${captureData.pages.length} pages)`);

  return { status: 'finalizing', exportPromise: exportPassiveCapture(captureData) };
}

// ── Restore ──────────────────────────────────────────────────────────────────

export async function restoreState() {
  const data = await chrome.storage.local.get('passiveCapture');
  const saved = data.passiveCapture;

  if (saved && saved.captureId) {
    const gap = Date.now() - (saved.lastActivityTime || 0);
    const aged = (Date.now() - (saved.startTime || 0)) >= CONFIG.MAX_CAPTURE_AGE_MS;

    if (gap >= CONFIG.INACTIVITY_TIMEOUT_MS) {
      // Restore briefly to check if we should finalize or hold back
      state = {
        captureId: saved.captureId,
        startTime: saved.startTime,
        lastActivityTime: saved.lastActivityTime,
        pages: saved.pages || [],
        events: saved.events || [],
        currentPage: saved.currentPage,
        currentPageStartTime: saved.currentPageStartTime
      };

      const trivial = state.pages.length < CONFIG.TRIVIAL_THRESHOLD;
      if (trivial && !aged) {
        // Hold back — keep capture open for accumulation
        console.log(`[Passive] Restored trivial capture (held back): ${state.captureId} (${state.pages.length} pages)`);
      } else {
        finalizeCapture();
      }
    } else {
      state = {
        captureId: saved.captureId,
        startTime: saved.startTime,
        lastActivityTime: saved.lastActivityTime,
        pages: saved.pages || [],
        events: saved.events || [],
        currentPage: saved.currentPage,
        currentPageStartTime: saved.currentPageStartTime
      };
      console.log(`[Passive] Restored capture: ${state.captureId} (${state.pages.length} pages)`);
    }
  }
}
