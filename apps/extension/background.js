/**
 * Unified Extension — Background Service Worker (Orchestrator)
 *
 * Wires Chrome event listeners to passive and active trackers.
 * Passive runs by default; when user starts a journey, passive is
 * finalized and pages go exclusively to the active tracker until
 * the journey ends, preventing duplicate captures.
 */

import { CONFIG } from './modules/config.js';
import { isInternalUrl } from './modules/utils.js';
import { recordPageVisit, recordCurrentPage, recordEvent } from './modules/tracker-core.js';
import * as passive from './modules/passive-tracker.js';
import * as active from './modules/active-tracker.js';
import { flushPendingExports, retrySingleExport } from './modules/export.js';

// =============================================================================
// Transition Metadata Bridge
// =============================================================================

const _pendingTransitions = new Map();

// =============================================================================
// Dual-dispatch helpers
// =============================================================================

/**
 * Record a page visit to the appropriate tracker.
 * Active and passive are mutually exclusive: when a journey is in progress,
 * pages go only to the active tracker to avoid duplicate captures.
 */
function dispatchPageVisit(url, title, transitionType, transitionQualifiers, tabId) {
  // Active journey in progress — record only to active tracker
  if (active.isTracking()) {
    recordPageVisit(
      active.getState(), url, title,
      transitionType, transitionQualifiers, tabId,
      'Journey', () => active.persist()
    );
    return;
  }

  // No active journey — record to passive tracker
  passive.ensureCapture();
  recordPageVisit(
    passive.getState(), url, title,
    transitionType, transitionQualifiers, tabId,
    'Passive', () => passive.persist(), () => passive.updateLastActivity()
  );

  // Cap: finalize passive capture if page count exceeds limit
  if (passive.getState().pages.length >= CONFIG.MAX_CAPTURE_SIZE) {
    passive.finalizeCapture();
  }
}

/**
 * Record a non-navigation event to the appropriate tracker.
 * Mutually exclusive: active journey takes priority over passive.
 */
function dispatchEvent(type, details = {}) {
  if (active.isTracking()) {
    recordEvent(active.getState(), type, details, 'Journey');
    active.persist();
    return;
  }

  recordEvent(
    passive.getState(), type, details,
    'Passive', () => passive.updateLastActivity()
  );
}

// =============================================================================
// Chrome Event Listeners
// =============================================================================

/**
 * Capture transition metadata when navigation commits.
 * transitionType/transitionQualifiers are ONLY available in onCommitted.
 */
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;

  const key = `${details.tabId}:${details.url}`;
  _pendingTransitions.set(key, {
    transitionType: details.transitionType || null,
    transitionQualifiers: details.transitionQualifiers || null,
  });

  setTimeout(() => _pendingTransitions.delete(key), 30000);
});

/**
 * Record page visit when navigation completes (page fully loaded).
 */
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const url = details.url;
  if (isInternalUrl(url)) return;

  const key = `${details.tabId}:${url}`;
  const transition = _pendingTransitions.get(key) || {};
  _pendingTransitions.delete(key);

  let title = 'Unknown';
  try {
    const tab = await chrome.tabs.get(details.tabId);
    title = tab.title || 'Unknown';
  } catch {
    // Tab may have closed
  }

  dispatchPageVisit(
    url, title,
    transition.transitionType || null,
    transition.transitionQualifiers || null,
    details.tabId
  );
});

/**
 * Handle tab activation (switching between tabs).
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && !isInternalUrl(tab.url)) {
      dispatchPageVisit(tab.url, tab.title, 'tab_switch', [], activeInfo.tabId);
    }
  } catch {
    // Tab may not exist
  }
});

/**
 * Handle tab close — finalize dwell time and record event.
 */
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  recordCurrentPage(passive.getState());
  if (active.isTracking()) recordCurrentPage(active.getState());

  dispatchEvent('tab_closed', { tabId, windowClosing: removeInfo.isWindowClosing });
});

/**
 * Handle new tab creation.
 */
chrome.tabs.onCreated.addListener((tab) => {
  dispatchEvent('tab_created', {
    tabId: tab.id,
    openerTabId: tab.openerTabId || null,
    url: tab.pendingUrl || tab.url || null,
  });
});

/**
 * Handle window focus changes.
 */
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    dispatchEvent('window_blur', {});
  } else {
    dispatchEvent('window_focus', { windowId });
  }
});

/**
 * Handle SPA navigations (pushState/replaceState).
 */
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const url = details.url;
  if (isInternalUrl(url)) return;

  const key = `${details.tabId}:${url}`;
  const transition = _pendingTransitions.get(key) || {};
  _pendingTransitions.delete(key);

  let title = 'Unknown';
  try {
    const tab = await chrome.tabs.get(details.tabId);
    title = tab.title || 'Unknown';
  } catch {
    // Tab may have closed
  }

  dispatchPageVisit(
    url, title,
    transition.transitionType || 'spa_navigation',
    transition.transitionQualifiers || [],
    details.tabId
  );
});

/**
 * Handle fragment/anchor navigations.
 */
chrome.webNavigation.onReferenceFragmentUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const url = details.url;
  if (isInternalUrl(url)) return;

  const key = `${details.tabId}:${url}`;
  const transition = _pendingTransitions.get(key) || {};
  _pendingTransitions.delete(key);

  let title = 'Unknown';
  try {
    const tab = await chrome.tabs.get(details.tabId);
    title = tab.title || 'Unknown';
  } catch {
    // Tab may have closed
  }

  dispatchEvent('fragment_navigation', {
    tabId: details.tabId,
    url,
    title,
    transitionType: transition.transitionType || null,
    transitionQualifiers: transition.transitionQualifiers || null,
  });
});

/**
 * Handle bookmarking.
 */
chrome.bookmarks.onCreated.addListener((id, bookmark) => {
  dispatchEvent('bookmark_created', {
    url: bookmark.url || null,
    title: bookmark.title || null,
  });
});

// =============================================================================
// Alarm — dispatches the passive-capture timeout backup and the
// pending-export flush (spec D7)
// =============================================================================

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CONFIG.ALARM_NAME) {
    const ps = passive.getState();
    const trivial = ps.pages.length < CONFIG.TRIVIAL_THRESHOLD;
    const aged = ps.startTime && (Date.now() - ps.startTime) >= CONFIG.MAX_CAPTURE_AGE_MS;

    if (trivial && !aged) {
      // Don't finalize — hold back trivial capture for accumulation
      console.log(`[Passive] Alarm: trivial capture held back (${ps.pages.length} pages)`);
      return;
    }
    passive.finalizeCapture();
  } else if (alarm.name === CONFIG.FLUSH_ALARM_NAME) {
    // Periodic drain of buffered exports (spec D7) -- self-manages whether
    // it needs to keep firing via ensureFlushAlarm()/clearFlushAlarm().
    flushPendingExports();
  }
});

// =============================================================================
// Message Handler
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Status (popup) ──────────────────────────────────────────────────────
  if (message.action === 'getStatus') {
    chrome.storage.local.get(['completedCaptures', 'pendingExports'], (data) => {
      const ps = passive.getState();
      sendResponse({
        // Passive
        passiveCaptureId: ps.captureId,
        passivePageCount: ps.pages.length,
        passiveStartTime: ps.startTime,
        passiveExtractedCount: ps.pages.filter(p => p.extractedText).length,
        completedCount: (data.completedCaptures || []).length,
        pendingExports: (data.pendingExports || []).length,
        // Active
        isTracking: active.isTracking(),
        activePageCount: active.getState().pages.length,
        activeStartTime: active.getState().startTime
      });
    });
    return true;
  }

  // ── Journey controls ────────────────────────────────────────────────────
  if (message.action === 'startCapture') {
    // Finalize the current passive capture so pre-journey pages aren't lost,
    // then start the active journey (passive won't record during the journey).
    passive.finalizeCapture();
    active.startCapture().then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === 'stopCapture') {
    active.stopCapture().then(() => sendResponse({ success: true }));
    return true;
  }

  // ── Passive force-finalize ──────────────────────────────────────────────
  // Always ends with a flush pass (spec D5/D6) so the popup can report
  // "Exported N, M buffered" -- reusing the active export's own pass when it
  // delivered (exportCapture already ran one), to avoid spending two passes'
  // worth of request budget on a single Force Export click.
  if (message.action === 'forceFinalize') {
    const result = passive.finalizeCapture();
    if (!result.exportPromise) {
      flushPendingExports()
        .then(flush => sendResponse({ success: true, delivery: 'no_capture', flush }))
        .catch((err) => {
          console.warn('[Export] Force finalize failed:', err);
          sendResponse({ success: false, delivery: 'failed', flush: null });
        });
    } else {
      result.exportPromise
        .then(async ({ delivery, flush }) => {
          const f = delivery === 'delivered' && flush ? flush : await flushPendingExports();
          sendResponse({ success: true, delivery, flush: f });
        })
        .catch((err) => {
          console.warn('[Export] Force finalize failed:', err);
          sendResponse({ success: false, delivery: 'failed', flush: null });
        });
    }
    return true;
  }

  // ── Cache viewer ────────────────────────────────────────────────────────
  if (message.action === 'getCacheData') {
    const ps = passive.getState();
    sendResponse({
      activeCapture: ps.captureId ? {
        captureId: ps.captureId,
        startTime: ps.startTime,
        lastActivityTime: ps.lastActivityTime,
        pages: ps.pages,
        currentPage: ps.currentPage,
        currentPageStartTime: ps.currentPageStartTime
      } : null
    });
    return;
  }

  if (message.action === 'retryPendingExport') {
    retrySingleExport(message.captureId)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ success: false, delivery: 'error' }));
    return true;
  }
});

// =============================================================================
// Initialize — restore both trackers, flush pending exports
// =============================================================================

async function initialize() {
  // One-time migration: session → capture storage keys
  const OLD_KEYS = ['passiveSession', 'activeSession', 'lastSession', 'completedSessions'];
  chrome.storage.local.get(OLD_KEYS, (old) => {
    const migrated = {};
    if (old.passiveSession) migrated.passiveCapture = old.passiveSession;
    if (old.activeSession) migrated.activeCapture = old.activeSession;
    if (old.lastSession) migrated.lastCapture = old.lastSession;
    if (old.completedSessions) migrated.completedCaptures = old.completedSessions;
    if (Object.keys(migrated).length > 0) {
      chrome.storage.local.set(migrated, () => {
        chrome.storage.local.remove(OLD_KEYS);
        console.log('[Compendium] Migrated storage keys: session → capture');
      });
    }
  });

  await Promise.all([
    passive.restoreState(),
    active.restoreState()
  ]);
  flushPendingExports();
  console.log('[Compendium] Unified extension initialized');
}

initialize();
