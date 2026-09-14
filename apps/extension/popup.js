/**
 * Unified Extension — Popup Script (Tabbed Layout)
 *
 * Two tabs: Passive and Active. Both trackers run concurrently regardless of
 * which tab is visible — this is purely a UI concern. Which tab opens first
 * follows whichever the backend reports is actually happening: Active when a
 * journey is recording, Passive otherwise.
 */

import { validateApiKey, saveConfig, maskApiKey, CONFIG } from './modules/config.js';
import { composeExportResult } from './modules/export-status.js';

// ── DOM refs ─────────────────────────────────────────────────────────────────

// Header
const versionEl = document.getElementById('version');

// Tabs
const tabPassive = document.querySelector('.tab-passive');
const tabActive = document.querySelector('.tab-active');
const panelPassive = document.getElementById('panelPassive');
const panelActive = document.getElementById('panelActive');

// Passive panel
const passiveCaptionEl = document.getElementById('passiveCaption');
const passiveToggleEl = document.getElementById('passiveToggle');
const passivePageCountEl = document.getElementById('passivePageCount');
const completedCountEl = document.getElementById('completedCount');
const captureIdEl = document.getElementById('captureId');
const captureIdPrefixEl = document.getElementById('captureIdPrefix');
const forceExportBtn = document.getElementById('forceExportBtn');
const exportStatusEl = document.getElementById('exportStatus');
const pendingNoticeEl = document.getElementById('pendingNotice');
const pendingCountEl = document.getElementById('pendingCount');

// Active panel
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const journeyReadyEl = document.getElementById('journeyReady');
const journeyActiveEl = document.getElementById('journeyActive');
const activePageCountEl = document.getElementById('activePageCount');
const durationEl = document.getElementById('duration');

let durationInterval = null;

// ── Tab switching ────────────────────────────────────────────────────────────

function activateTab(tabName) {
  if (tabName === 'passive') {
    tabPassive.classList.add('active');
    tabActive.classList.remove('active');
    panelPassive.classList.remove('hidden');
    panelActive.classList.add('hidden');
  } else {
    tabActive.classList.add('active');
    tabPassive.classList.remove('active');
    panelActive.classList.remove('hidden');
    panelPassive.classList.add('hidden');
  }
}

tabPassive.addEventListener('click', () => activateTab('passive'));
tabActive.addEventListener('click', () => activateTab('active'));

// ── Passive tracking toggle ──────────────────────────────────────────────────

// Passive tab's caption + dot (dimmed via .off when tracking is off -- see
// .tab-passive.off .tab-dot in popup.css).
function updatePassiveUI(enabled) {
  passiveCaptionEl.textContent = enabled ? 'Always tracking' : 'Tracking off';
  tabPassive.classList.toggle('off', !enabled);
}

chrome.storage.local.get('passiveEnabled', (data) => {
  const enabled = data.passiveEnabled !== false; // absent -> true
  passiveToggleEl.checked = enabled;
  updatePassiveUI(enabled);
});

passiveToggleEl.addEventListener('change', () => {
  const enabled = passiveToggleEl.checked;
  chrome.storage.local.set({ passiveEnabled: enabled });
  updatePassiveUI(enabled);
});

// ── Status ───────────────────────────────────────────────────────────────────

// Whether the very first status check has run yet -- used once, to pick the
// tab the popup opens on (Active while a journey is recording, else
// Passive), rather than on every poll.
let didInitialTabPick = false;

async function updateStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });

    if (!didInitialTabPick) {
      didInitialTabPick = true;
      activateTab(status.isTracking ? 'active' : 'passive');
    }

    // Passive
    passivePageCountEl.textContent = status.passivePageCount || 0;
    completedCountEl.textContent = status.completedCount || 0;

    if (status.passiveCaptureId) {
      captureIdEl.textContent = status.passiveCaptureId;
      captureIdEl.classList.remove('inactive');
      captureIdPrefixEl.classList.remove('hidden');
    } else {
      captureIdEl.textContent = 'No active capture';
      captureIdEl.classList.add('inactive');
      captureIdPrefixEl.classList.add('hidden');
    }

    // Active
    if (status.isTracking) {
      showActiveRecording(status.activeStartTime, status.activePageCount);
    } else {
      showActiveReady();
    }

    // Pending exports
    if (status.pendingExports > 0) {
      pendingCountEl.textContent = status.pendingExports;
      pendingNoticeEl.classList.remove('hidden');
    } else {
      pendingNoticeEl.classList.add('hidden');
    }
  } catch {
    // Service worker may be starting
  }
}

// ── Active UI ────────────────────────────────────────────────────────────────

function showActiveReady() {
  journeyReadyEl.classList.remove('hidden');
  journeyActiveEl.classList.add('hidden');
  tabActive.classList.remove('recording');
  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }
}

function showActiveRecording(startTime, pageCount) {
  journeyReadyEl.classList.add('hidden');
  journeyActiveEl.classList.remove('hidden');
  tabActive.classList.add('recording');
  activePageCountEl.textContent = pageCount || 0;

  if (durationInterval) clearInterval(durationInterval);

  const updateDuration = () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    durationEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  updateDuration();
  durationInterval = setInterval(updateDuration, 1000);
}

// ── Active controls ──────────────────────────────────────────────────────────

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  await chrome.runtime.sendMessage({ action: 'startCapture' });
  showActiveRecording(Date.now(), 0);
  startBtn.disabled = false;
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  await chrome.runtime.sendMessage({ action: 'stopCapture' });
  showActiveReady();
  stopBtn.disabled = false;
});

// ── Force export ─────────────────────────────────────────────────────────────

// Text/class composition lives in modules/export-status.js (DOM-free, unit
// tested); this is just the DOM side -- render the composed result and run
// the show/hide timer.
function showExportResult(result) {
  const { text, cls } = composeExportResult(result);

  exportStatusEl.textContent = text;
  exportStatusEl.className = `export-status ${cls}`;
  exportStatusEl.classList.remove('hidden');

  clearTimeout(showExportResult._timer);
  showExportResult._timer = setTimeout(() => {
    exportStatusEl.classList.add('hidden');
  }, 8000);
}

forceExportBtn.addEventListener('click', async () => {
  forceExportBtn.disabled = true;
  forceExportBtn.textContent = 'Exporting...';

  try {
    const response = await chrome.runtime.sendMessage({ action: 'forceFinalize' });
    showExportResult(response ?? { success: false, delivery: 'failed', flush: null });
    await updateStatus();
  } catch {
    showExportResult({ success: false, delivery: 'failed', flush: null });
  } finally {
    forceExportBtn.disabled = false;
    forceExportBtn.textContent = 'Force export';
  }
});

// ── Live updates from background ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'pageVisited') {
    if (message.source === 'passive') {
      passivePageCountEl.textContent = message.pageCount;
    } else if (message.source === 'journey') {
      activePageCountEl.textContent = message.pageCount;
    }
  }
});

// ── Cache link ───────────────────────────────────────────────────────────────

document.getElementById('viewCacheLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('cache.html') });
  window.close();
});

// ── Settings ─────────────────────────────────────────────────────────────────

const settingsUrlEl = document.getElementById('settingsBackendUrl');
const settingsKeyEl = document.getElementById('settingsApiKey');
const settingsDeviceLabelEl = document.getElementById('settingsDeviceLabel');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const settingsSavedEl = document.getElementById('settingsSaved');
const settingsErrorEl = document.getElementById('settingsError');

// The real key, held only in memory -- the field's displayed text is either
// this masked or, briefly, the raw value the user is typing. Never written
// back to storage except through saveConfig().
let storedApiKey = '';

// True while settingsKeyEl.value is showing the masked readout rather than
// text the user typed. Focusing the field while masked selects-all (so a
// paste/keystroke replaces it outright); any `input` event clears the flag.
let keyFieldIsMasked = false;

// True from the moment the user empties the field (while a key is stored)
// until Save resolves the clear-intent (confirm/cancel) or a new key is
// typed. Recorded in the `input` handler rather than derived from the
// field's value at Save time, because `blur` fires before Save's `click`
// and restores the masked text first -- by the time Save's handler runs,
// the field no longer looks empty.
let keyCleared = false;

// True when the key loaded from storage at popup-open time fails
// validateApiKey. While true: the field shows the raw (unmasked) bad key
// so the user can see and fix it, `blur` must not re-mask over it, and Save
// must not flash "Saved" for an untouched, still-broken key.
let storedKeyIsInvalid = false;

function showSettingsError(message) {
  settingsErrorEl.textContent = message;
  settingsErrorEl.classList.remove('hidden');
  settingsKeyEl.classList.add('invalid');
}

function hideSettingsError() {
  settingsErrorEl.classList.add('hidden');
  settingsKeyEl.classList.remove('invalid');
}

settingsKeyEl.addEventListener('focus', () => {
  if (keyFieldIsMasked) settingsKeyEl.select();
});

settingsKeyEl.addEventListener('input', () => {
  keyFieldIsMasked = false;
  keyCleared = settingsKeyEl.value === '' && Boolean(storedApiKey);
});

settingsKeyEl.addEventListener('blur', () => {
  // An accidental clear (focus, then blur without typing) shouldn't stick --
  // restore the mask rather than leaving the field empty. Skip this when
  // the stored key is known-invalid: re-masking would hide the exact value
  // the user needs to see (and fix) to clear the error. `keyCleared` stays
  // set either way -- Save still sees the clear intent.
  if (settingsKeyEl.value === '' && storedApiKey && !storedKeyIsInvalid) {
    settingsKeyEl.value = maskApiKey(storedApiKey);
    keyFieldIsMasked = true;
  }
});

// Load current settings
chrome.storage.local.get(['backendUrl', 'apiKey', 'deviceLabel'], (data) => {
  settingsUrlEl.value = data.backendUrl || 'http://localhost:8001';
  settingsDeviceLabelEl.value = data.deviceLabel || '';
  storedApiKey = data.apiKey || '';

  // A pre-existing bad key (e.g. saved before this validator existed) is
  // shown raw and unmasked, with the error, and the settings panel open --
  // masking it would hide exactly the thing the user needs to see and fix.
  const err = validateApiKey(storedApiKey);
  storedKeyIsInvalid = Boolean(err);
  if (err) {
    settingsKeyEl.value = storedApiKey;
    keyFieldIsMasked = false;
    showSettingsError(err);
    settingsErrorEl.closest('details').open = true;
  } else if (storedApiKey) {
    settingsKeyEl.value = maskApiKey(storedApiKey);
    keyFieldIsMasked = true;
    hideSettingsError();
  } else {
    settingsKeyEl.value = '';
    keyFieldIsMasked = false;
    hideSettingsError();
  }
});

saveSettingsBtn.addEventListener('click', async () => {
  const backendUrl = settingsUrlEl.value.trim().replace(/\/+$/, '');
  const deviceLabel = settingsDeviceLabelEl.value.trim();

  const payload = { backendUrl, deviceLabel };
  let newStoredKey;      // set only when the key itself is changing
  let skipSavedFlash = false;

  // Checked FIRST: `blur` (fired by clicking Save) already restored the
  // mask and flipped keyFieldIsMasked back to true by this point, so the
  // clear intent recorded in the `input` handler is the only signal left
  // that the user emptied the field.
  if (keyCleared) {
    if (storedApiKey && !confirm('Remove the stored API key? Captures will buffer on this device until a key is set again.')) {
      // Restore the display and skip the key change. A known-invalid key
      // stays visible unmasked (same rule as the blur handler above) --
      // masking it would hide the value the user still needs to fix. Mirror
      // the untouched-bad-key path below: don't flash "Saved" for a key
      // that's still broken, and clear any stale error otherwise so a red
      // border from an earlier rejected paste doesn't persist under a
      // valid masked key.
      if (storedKeyIsInvalid) {
        settingsKeyEl.value = storedApiKey;
        keyFieldIsMasked = false;
        skipSavedFlash = true;
      } else {
        settingsKeyEl.value = maskApiKey(storedApiKey);
        keyFieldIsMasked = true;
        hideSettingsError();
      }
    } else {
      payload.apiKey = '';
      newStoredKey = '';
    }
    keyCleared = false;
  } else {
    const rawValue = settingsKeyEl.value.trim();
    // Covers the field being unchanged (masked, or retyped back to the same
    // masked text) AND the field being empty with no key ever stored
    // (`'' === maskApiKey('')`) -- nothing to remove either way.
    const unchanged = keyFieldIsMasked || rawValue === maskApiKey(storedApiKey);

    if (unchanged) {
      // Do not touch the key. If it's the untouched bad key from load,
      // don't flash "Saved" -- nothing changed and the key is still broken.
      // Otherwise clear any stale error/red border from an earlier
      // rejected paste, since the field now shows a valid masked key.
      if (storedKeyIsInvalid) {
        skipSavedFlash = true;
      } else {
        hideSettingsError();
      }
    } else {
      const err = validateApiKey(rawValue);
      if (err) {
        showSettingsError(err);
        return;
      }
      hideSettingsError();
      payload.apiKey = rawValue;
      newStoredKey = rawValue;
    }
  }

  try {
    await saveConfig(payload);
  } catch (err) {
    showSettingsError(err.message);
    return;
  }

  if (newStoredKey !== undefined) {
    storedApiKey = newStoredKey;
    storedKeyIsInvalid = false;
    if (newStoredKey) {
      settingsKeyEl.value = maskApiKey(storedApiKey);
      keyFieldIsMasked = true;
    } else {
      settingsKeyEl.value = '';
      keyFieldIsMasked = false;
    }
    hideSettingsError();
  }

  if (skipSavedFlash) {
    showSettingsError(validateApiKey(storedApiKey));
    return;
  }

  settingsSavedEl.classList.remove('hidden');
  setTimeout(() => settingsSavedEl.classList.add('hidden'), 2000);
});

// ── Init ─────────────────────────────────────────────────────────────────────

{
  const version = chrome.runtime.getManifest().version;
  versionEl.textContent = `v${version}`;
  if (CONFIG.RELEASE_NOTES_URL) {
    versionEl.href = `${CONFIG.RELEASE_NOTES_URL}#v${version}`;
    versionEl.target = '_blank';
    versionEl.rel = 'noopener';
    versionEl.title = 'Release notes';
    versionEl.style.cursor = 'pointer';
  } else {
    versionEl.removeAttribute('href');
    versionEl.title = 'Release notes page coming soon';
    versionEl.style.cursor = 'default';
  }
}

updateStatus();
