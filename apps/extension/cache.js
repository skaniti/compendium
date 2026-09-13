/**
 * Compendium Capture - Capture Cache Viewer
 *
 * Reads active capture (via message), pending exports and export cache
 * (via chrome.storage.local) and renders them for inspection and recovery.
 *
 * Security: All dynamic values are escaped via escapeHtml/escapeAttr before
 * innerHTML insertion. Data source is user's own chrome.storage.local.
 */

import { formatRange } from './modules/format.js';
import { readCacheIndex, readCacheEntry, readAllCacheEntries } from './modules/export.js';

// =============================================================================
// DOM refs
// =============================================================================

const summaryEl = document.getElementById('summary');
const refreshBtn = document.getElementById('refreshBtn');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const activeContainer = document.getElementById('activeContainer');
const historyContainer = document.getElementById('historyContainer');

// =============================================================================
// HTML Escaping — applied to ALL dynamic values before innerHTML insertion
// =============================================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =============================================================================
// Data Loading
// =============================================================================

async function loadAllData() {
  // Fetch active capture from service worker
  let activeCapture = null;
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getCacheData' });
    activeCapture = resp?.activeCapture || null;
  } catch {
    // Service worker may not be running
  }

  // pendingExports still lives directly in storage.local; the finalized
  // history is the lightweight cacheIndex -- readCacheIndex() migrates the
  // legacy exportCache array lazily if this is the first read since upgrade.
  const stored = await chrome.storage.local.get('pendingExports');
  const pendingExports = stored.pendingExports || [];
  const index = await readCacheIndex();

  return { activeCapture, pendingExports, index };
}

// =============================================================================
// Rendering
// =============================================================================

function formatDwell(ms) {
  if (!ms && ms !== 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function renderPageTable(pages) {
  if (!pages || pages.length === 0) {
    return '<p class="empty-state">No pages recorded</p>';
  }

  const rows = pages.map((p, i) => {
    const title = escapeHtml(p.title || p.url || 'Untitled');
    const url = p.url ? escapeAttr(p.url) : '';
    const href = url ? `<a href="${url}" target="_blank" rel="noopener">${title}</a>` : title;
    // tracker-core.js stores finished pages' dwell time as `dwellTimeSeconds`
    // (seconds); the live-capture path above computes `dwellTime` (ms) for
    // the current page only. Route both through the same ms-based helper.
    const dwellMs = p.dwellTimeSeconds != null ? p.dwellTimeSeconds * 1000 : (p.dwellTime ?? null);
    const dwell = escapeHtml(formatDwell(dwellMs));
    const transition = escapeHtml(p.transitionType || p.transition || '-');
    const contentLen = p.extractedText ? p.extractedText.length : 0;
    const content = contentLen > 0
      ? `<span class="content-ok">${(contentLen / 1000).toFixed(1)}k</span>`
      : '<span class="content-missing">\u2014</span>';
    return `<tr>
      <td>${i + 1}</td>
      <td>${href}</td>
      <td class="dwell">${dwell}</td>
      <td class="transition">${transition}</td>
      <td class="content-col">${content}</td>
    </tr>`;
  }).join('');

  return `<table class="page-table">
    <thead><tr>
      <th title="Order the page was visited in">#</th>
      <th title="Page title -- links to the page">Title</th>
      <th title="Time spent on the page before leaving it">Dwell</th>
      <th title="How the page was reached">Transition</th>
      <th title="Extracted text length in characters (thousands)">Text</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

const BADGE_TITLES = {
  active: 'Still recording',
  delivered: 'Confirmed saved by the server',
  failed: 'Not delivered yet; retries every minute while the backend is reachable'
};

/**
 * Renders the <details class="session-card"> shell shared by the active
 * capture card and every History card.
 *
 * `info` is a plain bag -- { captureId, kind, startedAt, endedAt, pageCount }
 * -- NOT the full captureData; History cards are built from cacheIndex
 * summaries and never carry pages/events. `bodyHtml` is the already-known
 * page table (active capture: rendered synchronously from the live session)
 * or `null` for a History card, whose body is loaded lazily on first open
 * (see loadHistoryBody) -- in that case a "Loading…" placeholder renders now
 * and `data-body-state="empty"` marks it for the accordion listener to fill.
 */
function renderCaptureCard(info, source, extra = {}, bodyHtml = null) {
  const badgeClass = { active: 'badge-live', failed: 'badge-failed', delivered: 'badge-delivered' }[source];
  const badgeLabel = { active: 'LIVE', failed: 'FAILED', delivered: 'DELIVERED' }[source];
  const badgeTitle = BADGE_TITLES[source];
  const cardClass = `source-${source}`;

  const captureId = info.captureId || 'unknown';
  const pageCount = info.pageCount || 0;
  const lazy = bodyHtml === null;

  // Second summary line: "<range> · <cache-time>". Range comes from the
  // ISO startedAt/endedAt (finalized captures); the still-live capture only
  // has startTime (epoch ms, resolved by the caller) and no end yet, which
  // formatRange renders with a trailing "…". Cache-time label dispatch:
  //   DELIVERED + deliveredAt -> "delivered Xm ago" (preferred when known)
  //   FAILED  + cachedAt      -> "cached Xm ago"   (no delivery time exists)
  //   active                  -> no cache-time label
  //   delivered w/o deliveredAt (pre-feature legacy) -> no cache-time label
  const rangeText = formatRange(info.startedAt, info.endedAt);

  let cacheTimeText = '';
  if (source === 'delivered' && extra.deliveredAt) {
    cacheTimeText = `delivered ${timeAgo(extra.deliveredAt)}`;
  } else if (source === 'failed' && extra.cachedAt) {
    cacheTimeText = `cached ${timeAgo(extra.cachedAt)}`;
  }

  let metaExtra = '';
  if (rangeText && cacheTimeText) {
    metaExtra = `<span class="cache-time">${escapeHtml(rangeText)} · ${escapeHtml(cacheTimeText)}</span>`;
  } else if (rangeText || cacheTimeText) {
    metaExtra = `<span class="cache-time">${escapeHtml(rangeText || cacheTimeText)}</span>`;
  }

  // "journey" tag distinguishes an active/journey capture from the far more
  // common passive one; kept out of the delivery badge (LIVE/FAILED/
  // DELIVERED already uses that slot for delivery state).
  const kindTag = info.kind === 'active'
    ? '<span class="kind-tag" title="Recorded as an active journey">journey</span>'
    : '';

  let actions = '';
  if (source === 'failed') {
    actions += `<button class="btn btn-secondary btn-small retry-btn" data-capture-id="${escapeAttr(captureId)}" title="Send this capture to the backend again">Retry export</button>`;
  }
  if (source !== 'active') {
    actions += `<button class="btn btn-secondary btn-small download-btn" data-capture-id="${escapeAttr(captureId)}" data-source="${escapeAttr(source)}" title="Save this capture's raw JSON to disk">Download JSON</button>`;
  }

  const body = lazy ? '<p class="empty-state">Loading…</p>' : bodyHtml;
  const bodyStateAttr = lazy ? ' data-body-state="empty"' : '';

  return `<details class="session-card ${cardClass}" data-capture-id="${escapeAttr(captureId)}"${bodyStateAttr}>
    <summary>
      <span class="badge ${badgeClass}" title="${badgeTitle}">${badgeLabel}</span>
      <span class="card-id">
        <span class="session-name">${kindTag}${escapeHtml(captureId)}</span>
        ${metaExtra}
      </span>
      <span class="card-count">${pageCount} page${pageCount !== 1 ? 's' : ''}</span>
      <span class="card-actions">${actions}</span>
    </summary>
    <div class="card-body">
      ${body}
    </div>
  </details>`;
}

function renderActiveCapture(session) {
  if (!session) {
    activeContainer.innerHTML = '<p class="empty-state">No active capture</p>';
    return;
  }
  // Include current page in the displayed pages if not yet recorded
  const pages = [...(session.pages || [])];
  if (session.currentPage && session.currentPageStartTime) {
    pages.push({
      url: session.currentPage,
      title: session.currentPage,
      dwellTime: Date.now() - session.currentPageStartTime,
      transitionType: '(current)'
    });
  }

  const info = {
    captureId: session.captureId || 'unknown',
    kind: session.kind,
    startedAt: session.startedAt ?? session.startTime,
    endedAt: session.endedAt,
    pageCount: pages.length
  };
  activeContainer.innerHTML = renderCaptureCard(info, 'active', {}, renderPageTable(pages));
}

const MONTH_NAMES_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Sort/group key for a history summary: startedAt (ISO) when present,
// falling back to cachedAt (epoch ms) -- mirrors the fallback used for the
// rendered date range itself. Guards against either being unparseable: an
// invalid startedAt falls back to cachedAt, and if that's invalid too this
// returns an invalid Date -- callers (renderHistory) sort those last and
// skip the month heading for them, since there's no date to group by.
function entryDate(summary) {
  const d = new Date(summary.startedAt);
  if (!isNaN(d)) return d;
  return new Date(summary.cachedAt);
}

function hasValidDate(summary) {
  return !isNaN(entryDate(summary));
}

function monthHeading(summary) {
  const d = entryDate(summary);
  return `${MONTH_NAMES_FULL[d.getMonth()]} ${d.getFullYear()}`;
}

function renderSummaryCard(summary, pendingSet) {
  const source = pendingSet.has(summary.captureId) ? 'failed' : 'delivered';
  return renderCaptureCard(
    {
      captureId: summary.captureId,
      kind: summary.kind,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      pageCount: summary.pageCount
    },
    source,
    { cachedAt: summary.cachedAt, deliveredAt: summary.deliveredAt }
  );
}

function renderHistory(index, pendingSet) {
  if (!index || index.length === 0) {
    historyContainer.innerHTML = '<p class="empty-state-title">Nothing finalized yet.</p><p class="empty-state-hint">The live capture closes after 60 minutes without browsing, or when you use Force export in the popup. It appears here as delivered once the server confirms it, or as failed with a retry if it could not be sent.</p>';
    return;
  }

  // cacheIndex is stored oldest-first (writeExportCache pushes new summaries
  // onto the end) -- render newest-first, with a month heading inserted
  // before the first card of each calendar month. Each card's body is a
  // lazy placeholder until opened (see setupAccordion's lazy loader).
  // Entries with no resolvable date (startedAt and cachedAt both
  // unparseable) are sorted last and rendered with no month heading.
  const dated = index.filter(hasValidDate);
  const undated = index.filter(s => !hasValidDate(s));
  const newestFirst = [...dated].sort((a, b) => entryDate(b) - entryDate(a));

  let html = '';
  let lastHeading = null;
  for (const summary of newestFirst) {
    const heading = monthHeading(summary);
    if (heading !== lastHeading) {
      html += `<h3 class="month-heading">${escapeHtml(heading)}</h3>`;
      lastHeading = heading;
    }
    html += renderSummaryCard(summary, pendingSet);
  }
  for (const summary of undated) {
    html += renderSummaryCard(summary, pendingSet);
  }
  historyContainer.innerHTML = html;
}

function updateSummary(data, pendingSet) {
  const counts = [];
  if (data.activeCapture) counts.push('1 active');

  const cachedIds = data.index.map(s => s.captureId);
  const failed = cachedIds.filter(id => pendingSet.has(id)).length;
  const delivered = cachedIds.length - failed;
  if (failed > 0) counts.push(`${failed} failed`);
  if (delivered > 0) counts.push(`${delivered} delivered`);

  const total = (data.activeCapture ? 1 : 0) + data.index.length;
  summaryEl.textContent = total === 0
    ? 'No captures in history'
    : `${total} capture${total !== 1 ? 's' : ''}: ${counts.join(', ')}`;

  downloadAllBtn.disabled = total === 0;
}

async function refresh() {
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Loading...';

  try {
    const data = await loadAllData();
    const pendingSet = new Set(data.pendingExports.map(p => p.captureId));
    renderActiveCapture(data.activeCapture);
    renderHistory(data.index, pendingSet);
    updateSummary(data, pendingSet);

    // Store for download
    refresh._lastData = data;
  } catch (err) {
    summaryEl.textContent = `Error loading data: ${err.message}`;
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Refresh';
  }
}

// =============================================================================
// Actions
// =============================================================================

function downloadJson(sessionData, filename) {
  const json = JSON.stringify(sessionData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function retryExport(captureId, btn) {
  btn.disabled = true;
  btn.textContent = 'Retrying...';

  // Remove any previous status
  const existing = btn.parentElement.querySelector('.retry-status');
  if (existing) existing.remove();

  try {
    const resp = await chrome.runtime.sendMessage({ action: 'retryPendingExport', captureId });
    const status = document.createElement('span');
    status.className = `retry-status ${resp.success ? 'success' : 'error'}`;
    let failText;
    if (typeof resp.status === 'number') {
      failText = `Failed: HTTP ${resp.status}`;
    } else if (typeof resp.error === 'string') {
      failText = `Failed: ${resp.error}`;
    } else {
      failText = `Failed: ${resp.delivery}`;
    }
    status.textContent = resp.success ? 'Delivered!' : failText;
    btn.after(status);

    if (resp.success) {
      setTimeout(refresh, 1000);
    }
  } catch {
    const status = document.createElement('span');
    status.className = 'retry-status error';
    status.textContent = 'Service worker unavailable';
    btn.after(status);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Retry export';
  }
}

async function collectAllCaptures(data) {
  const files = [];

  if (data.activeCapture) {
    files.push({
      name: `active_${data.activeCapture.captureId || 'capture'}.json`,
      data: data.activeCapture
    });
  }

  for (const s of data.pendingExports) {
    files.push({
      name: `pending_${s.captureId || 'unknown'}.json`,
      data: s
    });
  }

  // Bulk-reads every finalized capture's full entry in one pass -- the only
  // point in the cache viewer where all of history's page text is loaded at
  // once, which is exactly what "Download all" needs.
  const entries = await readAllCacheEntries();
  for (const entry of entries) {
    const captureId = entry.captureData.captureId || entry.captureData.sessionId || 'unknown';
    files.push({
      name: `cached_${captureId}.json`,
      data: entry.captureData
    });
  }

  return files;
}

async function downloadAllAsZip() {
  const data = refresh._lastData;
  if (!data) return;

  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = 'Building ZIP...';

  try {
    const files = await collectAllCaptures(data);
    if (files.length === 0) return;

    const zip = new MiniZip();
    for (const f of files) {
      zip.addFile(f.name, JSON.stringify(f.data, null, 2));
    }

    const blob = zip.toBlob();
    const date = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compendium-cache-${date}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = 'Download all as ZIP';
  }
}

// =============================================================================
// Event Delegation
// =============================================================================

document.addEventListener('click', (e) => {
  const retryBtn = e.target.closest('.retry-btn');
  if (retryBtn) {
    retryExport(retryBtn.dataset.captureId, retryBtn);
    return;
  }

  const downloadBtn = e.target.closest('.download-btn');
  if (downloadBtn) {
    downloadSingleCapture(downloadBtn.dataset.captureId, downloadBtn);
  }
});

// History cards no longer carry the full captureData in the rendered page --
// only the lightweight summary. Download reads the one entry it needs
// on-click rather than the caller having to load it up front. The filename
// keeps the `cached_` prefix to stay compatible with the backfill script's
// filename-based classifier (see scripts/backfill_extension_zip.py::classify).
async function downloadSingleCapture(captureId, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing...';

  let entry;
  try {
    entry = await readCacheEntry(captureId);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    throw err;
  }

  if (!entry) {
    // Evicted (TTL/cap) since the list was rendered -- flash "Not cached"
    // for a couple seconds instead of silently restoring the button, so the
    // click has visible feedback beyond the console warning.
    console.warn(`[Cache] Download failed: ${captureId} is no longer cached`);
    btn.textContent = 'Not cached';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = original;
    }, 2000);
    return;
  }

  downloadJson(entry.captureData, `cached_${captureId}.json`);
  btn.disabled = false;
  btn.textContent = original;
}

refreshBtn.addEventListener('click', refresh);
downloadAllBtn.addEventListener('click', downloadAllAsZip);

// =============================================================================
// Accordion -- only one capture card expanded at a time (per container)
// =============================================================================

// <details class="session-card"> `toggle` events don't bubble in every
// engine version, so this listens in the CAPTURE phase, which fires
// regardless of bubbling. Native keyboard behaviour (Enter/Space toggling
// the focused <summary>) is untouched -- this only reacts after a card
// opens, closing any other open card in the same container.
//
// `lazy: true` (historyContainer only) additionally fills in a card's body
// the first time it's opened: History cards render with a "Loading…"
// placeholder and `data-body-state="empty"` (see renderCaptureCard) since
// the summary they're built from never carries page text.
function setupAccordion(container, { lazy = false } = {}) {
  container.addEventListener('toggle', (e) => {
    const opened = e.target;
    if (!(opened instanceof HTMLDetailsElement)) return;
    if (!opened.classList.contains('session-card') || !opened.open) return;

    for (const other of container.querySelectorAll('details.session-card[open]')) {
      if (other !== opened) other.open = false;
    }

    if (lazy && opened.dataset.bodyState === 'empty') {
      loadHistoryBody(opened);
    }
  }, true);
}

// Fetches one capture's full entry and swaps it into the already-open
// card's body. `data-body-state` guards against re-fetching on every open
// (close/reopen keeps the loaded body) and against a double-fire loading
// the same card twice.
async function loadHistoryBody(cardEl) {
  cardEl.dataset.bodyState = 'loading';
  const captureId = cardEl.dataset.captureId;
  const bodyEl = cardEl.querySelector('.card-body');

  try {
    const entry = await readCacheEntry(captureId);
    if (!entry) {
      bodyEl.innerHTML = '<p class="empty-state">No longer cached</p>';
    } else {
      bodyEl.innerHTML = renderPageTable(entry.captureData.pages);
    }
    cardEl.dataset.bodyState = 'loaded';
  } catch (err) {
    bodyEl.innerHTML = `<p class="empty-state">Failed to load: ${escapeHtml(err.message)}</p>`;
    cardEl.dataset.bodyState = 'empty';
  }
}

setupAccordion(historyContainer, { lazy: true });
setupAccordion(activeContainer);


// =============================================================================
// MiniZip — Uncompressed PKZIP builder
// =============================================================================

class MiniZip {
  constructor() {
    this.files = [];
  }

  addFile(name, content) {
    const encoder = new TextEncoder();
    this.files.push({
      name: encoder.encode(name),
      data: encoder.encode(content)
    });
  }

  toBlob() {
    // Calculate total size
    let offset = 0;
    const entries = this.files.map(f => {
      const localHeaderSize = 30 + f.name.length;
      const entry = {
        name: f.name,
        data: f.data,
        crc: crc32(f.data),
        localOffset: offset,
        localHeaderSize
      };
      offset += localHeaderSize + f.data.length;
      return entry;
    });

    const centralStart = offset;
    let centralSize = 0;
    for (const e of entries) {
      centralSize += 46 + e.name.length;
    }
    const totalSize = centralStart + centralSize + 22;

    const buf = new ArrayBuffer(totalSize);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    let pos = 0;

    // Local file headers + data
    for (const e of entries) {
      view.setUint32(pos, 0x04034b50, true);         // Local file header signature
      view.setUint16(pos + 4, 20, true);              // Version needed
      view.setUint16(pos + 6, 0, true);               // Flags
      view.setUint16(pos + 8, 0, true);               // Compression: STORE
      view.setUint16(pos + 10, 0, true);              // Mod time
      view.setUint16(pos + 12, 0, true);              // Mod date
      view.setUint32(pos + 14, e.crc, true);          // CRC-32
      view.setUint32(pos + 18, e.data.length, true);  // Compressed size
      view.setUint32(pos + 22, e.data.length, true);  // Uncompressed size
      view.setUint16(pos + 26, e.name.length, true);  // Filename length
      view.setUint16(pos + 28, 0, true);              // Extra field length
      bytes.set(e.name, pos + 30);
      bytes.set(e.data, pos + 30 + e.name.length);
      pos += 30 + e.name.length + e.data.length;
    }

    // Central directory
    for (const e of entries) {
      view.setUint32(pos, 0x02014b50, true);          // Central directory signature
      view.setUint16(pos + 4, 20, true);              // Version made by
      view.setUint16(pos + 6, 20, true);              // Version needed
      view.setUint16(pos + 8, 0, true);               // Flags
      view.setUint16(pos + 10, 0, true);              // Compression: STORE
      view.setUint16(pos + 12, 0, true);              // Mod time
      view.setUint16(pos + 14, 0, true);              // Mod date
      view.setUint32(pos + 16, e.crc, true);          // CRC-32
      view.setUint32(pos + 20, e.data.length, true);  // Compressed size
      view.setUint32(pos + 24, e.data.length, true);  // Uncompressed size
      view.setUint16(pos + 28, e.name.length, true);  // Filename length
      view.setUint16(pos + 30, 0, true);              // Extra field length
      view.setUint16(pos + 32, 0, true);              // Comment length
      view.setUint16(pos + 34, 0, true);              // Disk number start
      view.setUint16(pos + 36, 0, true);              // Internal attrs
      view.setUint32(pos + 38, 0, true);              // External attrs
      view.setUint32(pos + 42, e.localOffset, true);  // Relative offset
      bytes.set(e.name, pos + 46);
      pos += 46 + e.name.length;
    }

    // End of central directory
    view.setUint32(pos, 0x06054b50, true);            // EOCD signature
    view.setUint16(pos + 4, 0, true);                 // Disk number
    view.setUint16(pos + 6, 0, true);                 // Central dir disk
    view.setUint16(pos + 8, entries.length, true);    // Entries on disk
    view.setUint16(pos + 10, entries.length, true);   // Total entries
    view.setUint32(pos + 12, centralSize, true);      // Central dir size
    view.setUint32(pos + 16, centralStart, true);     // Central dir offset
    view.setUint16(pos + 20, 0, true);                // Comment length

    return new Blob([buf], { type: 'application/zip' });
  }
}

// CRC-32 with precomputed table (polynomial 0xEDB88320)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// =============================================================================
// Init
// =============================================================================

refresh();
