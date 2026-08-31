/**
 * Shared recording engine — parameterized by capture state object.
 *
 * Every function takes a capture state object as its first argument,
 * allowing both passive and active trackers to share this code with
 * independent capture instances.
 */

import { isTrackedDomain, normalizeUrlForDedup } from './utils.js';

/**
 * Finalize dwell time for the current page in this capture.
 */
export function recordCurrentPage(state) {
  if (state.currentPage && state.currentPageStartTime) {
    const dwellTime = Math.floor((Date.now() - state.currentPageStartTime) / 1000);
    const lastPage = state.pages[state.pages.length - 1];
    if (lastPage && lastPage.url === state.currentPage) {
      lastPage.dwellTimeSeconds = dwellTime;
    }
  }
}

/**
 * Record a non-navigation event.
 * @param {object} state - Capture state
 * @param {string} type - Event type
 * @param {object} details - Event details
 * @param {string} label - Log prefix (e.g. 'Passive', 'Journey')
 * @param {function} [onActivity] - Called after recording (e.g. to update last activity time)
 */
export function recordEvent(state, type, details = {}, label = '', onActivity = null) {
  if (!state.captureId) return;

  const event = {
    type,
    timestamp: new Date().toISOString(),
    ...details
  };
  state.events.push(event);

  if (onActivity) onActivity();

  console.log(`[${label}] Event: ${type}`, details);
}

/**
 * Request content extraction from the content script running in a tab.
 * @param {number} tabId
 * @param {string} label - Log prefix
 * @returns {Promise<string|null>}
 */
export async function requestContentExtraction(tabId, label = '') {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'extractContent' });
    if (response && response.text && response.charCount > 0) {
      console.log(`[${label}] Extracted ${response.charCount} chars (${response.source})`);
      return response.text;
    }
  } catch {
    // Content script may not be injected (chrome:// pages, PDF, etc.)
  }
  return null;
}

/**
 * Record a page visit into the given capture state.
 * @param {object} state - Capture state
 * @param {string} url
 * @param {string} title
 * @param {string|null} transitionType
 * @param {string[]|null} transitionQualifiers
 * @param {number|null} tabId
 * @param {string} label - Log prefix
 * @param {function} persistFn - Called to persist state after mutation
 * @param {function} [onActivity] - Called after recording (for passive gap tracking)
 */
export function recordPageVisit(
  state, url, title,
  transitionType = null, transitionQualifiers = null, tabId = null,
  label = '', persistFn = null, onActivity = null
) {
  recordCurrentPage(state);

  // Skip navigation types that don't represent new page visits.
  const SKIP_TRANSITIONS = new Set(['reload', 'back_forward']);
  if (transitionType && SKIP_TRANSITIONS.has(transitionType)) {
    return;
  }

  // Dedup — two rules, both firing within the same last-N window.
  //
  // state.pages is the in-memory capture buffer, so both rules are
  // per-capture only. Cross-capture dedup is the backend's job — see
  // backend/db/page_repo.py::_collapse_consecutive_duplicates, which
  // applies the same two rules as a safety net.
  //
  //
  // RULE 1 — Exact normalized URL match in the last 10 pages.
  //
  //   Catches SPA bouncing where the user returns to a previously-
  //   visited URL (Zillow listing → photos → calc → listing), tab
  //   cycling (A→B→A→B), and any near-consecutive re-visit. Normalizer
  //   strips fragments + tracking params + sorts query params, so
  //   Gmail #inbox/X variants, makerworld #profileId-X variants, etc.
  //   collapse.
  //
  //   N=10 was chosen based on the Phase 0 dedup audit — worst
  //   offenders cycled within 3-7 navigations, 10 provides headroom.
  //
  //
  // RULE 2 — Same host+path within 5 seconds, any transition type.
  //
  //   Catches the harder case: the page's own JavaScript rewriting its
  //   own URL via pushState/replaceState, producing a chain of visits
  //   where each has a different query string but all represent the
  //   same logical page. DuckDuckGo search (`?q=X&we_feature_name=...`
  //   → `?q=X` → `?q=X&ia=web`), Google results rewriting filter
  //   params, Zillow photo carousel cycling through ?mcid=X values.
  //
  //   Rule 1 doesn't catch these because the normalized URLs genuinely
  //   differ (the mutated params aren't in the tracking list).
  //
  //   The 5-second window is the safety rail: SPA self-rewrites
  //   happen in rapid succession (same second, typically), so 5s
  //   catches them without swallowing legitimate quick re-visits
  //   across unrelated pages.
  const DEDUP_WINDOW = 10;
  const SPA_MUTATION_WINDOW_MS = 5000;

  const normalizedUrl = normalizeUrlForDedup(url);
  const recent = state.pages.slice(-DEDUP_WINDOW);

  // RULE 1: exact normalized match
  if (recent.some(p => normalizeUrlForDedup(p.url) === normalizedUrl)) {
    return;
  }

  // RULE 2: same host+path within 5s (SPA param mutation)
  const nowMs = Date.now();
  let currentHostPath = null;
  try {
    const parsed = new URL(url);
    currentHostPath = `${parsed.host}${parsed.pathname}`;
  } catch {
    // Unparseable URL — fall through, treat as distinct
  }
  if (currentHostPath) {
    for (const p of recent) {
      let prevHostPath = null;
      try {
        const parsedPrev = new URL(p.url);
        prevHostPath = `${parsedPrev.host}${parsedPrev.pathname}`;
      } catch {
        continue;
      }
      if (prevHostPath !== currentHostPath) continue;
      const prevMs = p.timestamp ? Date.parse(p.timestamp) : NaN;
      if (!isNaN(prevMs) && nowMs - prevMs <= SPA_MUTATION_WINDOW_MS) {
        return;
      }
    }
  }

  const pageVisit = {
    url,
    title: title || 'Unknown',
    timestamp: new Date().toISOString(),
    dwellTimeSeconds: null,
    isTrackedDomain: isTrackedDomain(url),
    transitionType,
    transitionQualifiers,
    extractedText: null
  };

  state.pages.push(pageVisit);
  state.currentPage = url;
  state.currentPageStartTime = Date.now();

  if (onActivity) onActivity();

  // Request content extraction asynchronously
  if (tabId) {
    requestContentExtraction(tabId, label).then(text => {
      if (text) {
        pageVisit.extractedText = text;
        if (persistFn) persistFn();
      }
    });
  }

  // Notify popup
  chrome.runtime.sendMessage({
    action: 'pageVisited',
    pageCount: state.pages.length,
    source: label.toLowerCase() // 'passive' or 'journey'
  }).catch(() => {});

  console.log(`[${label}] Recorded: ${title} (${url})`);
}
