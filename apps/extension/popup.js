/**
 * Unified Extension — Popup Script (Tabbed Layout)
 *
 * Two tabs: Passive (default) and Active. Both trackers run concurrently
 * regardless of which tab is visible — this is purely a UI concern.
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
const passivePageCountEl = document.getElementById('passivePageCount');
const completedCountEl = document.getElementById('completedCount');
const captureIdEl = document.getElementById('captureId');
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

// Set-as-default buttons
const setDefaultPassiveBtn = document.getElementById('setDefaultPassive');
const setDefaultActiveBtn = document.getElementById('setDefaultActive');

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

function updateDefaultIndicators(defaultTab) {
  if (defaultTab === 'passive') {
    setDefaultPassiveBtn.textContent = 'Opens on this tab';
    setDefaultPassiveBtn.classList.add('is-default');
    setDefaultActiveBtn.textContent = 'Open this tab first';
    setDefaultActiveBtn.classList.remove('is-default');
  } else {
    setDefaultActiveBtn.textContent = 'Opens on this tab';
    setDefaultActiveBtn.classList.add('is-default');
    setDefaultPassiveBtn.textContent = 'Open this tab first';
    setDefaultPassiveBtn.classList.remove('is-default');
  }
}

tabPassive.addEventListener('click', () => activateTab('passive'));
tabActive.addEventListener('click', () => activateTab('active'));

setDefaultPassiveBtn.addEventListener('click', () => {
  chrome.storage.local.set({ defaultTab: 'passive' });
  updateDefaultIndicators('passive');
});

setDefaultActiveBtn.addEventListener('click', () => {
  chrome.storage.local.set({ defaultTab: 'active' });
  updateDefaultIndicators('active');
});

// ── Status ───────────────────────────────────────────────────────────────────

async function updateStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });

    // Passive
    passivePageCountEl.textContent = status.passivePageCount || 0;
    completedCountEl.textContent = status.completedCount || 0;

    if (status.passiveCaptureId) {
      captureIdEl.textContent = status.passiveCaptureId;
      captureIdEl.classList.remove('inactive');
    } else {
      captureIdEl.textContent = 'No active capture';
      captureIdEl.classList.add('inactive');
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
const apiKeyMaskedEl = document.getElementById('apiKeyMasked');
const apiKeyEditEl = document.getElementById('apiKeyEdit');
const apiKeyChangeBtn = document.getElementById('apiKeyChangeBtn');
const apiKeyCancelBtn = document.getElementById('apiKeyCancelBtn');
const apiKeyRemoveBtn = document.getElementById('apiKeyRemoveBtn');

// The real key, held only in memory -- the masked readout is display-only
// and is never written back to storage.
let storedApiKey = '';

// Set when the load-time path opens the edit block because the stored key
// is invalid (spec D1). While true and the stored key is still invalid, an
// empty-input Save must keep the edit block open instead of silently
// closing over an unresolved error. Cleared once a valid key is saved or
// the key is removed.
let editOpenedForBadKey = false;

function showSettingsError(message) {
  settingsErrorEl.textContent = message;
  settingsErrorEl.classList.remove('hidden');
  settingsKeyEl.classList.add('invalid');
}

function hideSettingsError() {
  settingsErrorEl.classList.add('hidden');
  settingsKeyEl.classList.remove('invalid');
}

function renderMaskedKey() {
  if (storedApiKey) {
    apiKeyMaskedEl.textContent = maskApiKey(storedApiKey);
    apiKeyMaskedEl.classList.remove('faint');
    apiKeyRemoveBtn.classList.remove('hidden');
  } else {
    apiKeyMaskedEl.textContent = 'No key set';
    apiKeyMaskedEl.classList.add('faint');
    apiKeyRemoveBtn.classList.add('hidden');
  }
}

function openApiKeyEdit(prefill = '') {
  apiKeyEditEl.classList.remove('hidden');
  settingsKeyEl.value = prefill;
}

function closeApiKeyEdit() {
  apiKeyEditEl.classList.add('hidden');
  settingsKeyEl.value = '';
  hideSettingsError();
}

apiKeyChangeBtn.addEventListener('click', () => {
  hideSettingsError();
  openApiKeyEdit('');
  settingsKeyEl.focus();
});

apiKeyCancelBtn.addEventListener('click', () => {
  closeApiKeyEdit();
});

apiKeyRemoveBtn.addEventListener('click', async () => {
  if (!confirm('Remove the stored API key? Captures will buffer on this device until a key is set again.')) return;

  await saveConfig({ apiKey: '' });
  storedApiKey = '';
  editOpenedForBadKey = false;
  renderMaskedKey();
  closeApiKeyEdit();
});

// Load current settings
chrome.storage.local.get(['backendUrl', 'apiKey', 'deviceLabel'], (data) => {
  settingsUrlEl.value = data.backendUrl || 'http://localhost:8001';
  settingsDeviceLabelEl.value = data.deviceLabel || '';
  storedApiKey = data.apiKey || '';
  renderMaskedKey();

  // A pre-existing bad key (e.g. saved before this validator existed) is
  // surfaced here too, so it's visible without re-saving (spec D1). Since
  // the raw key only shows in the edit block, open it pre-filled with the
  // offending value so the user can see and fix it in place.
  const err = validateApiKey(storedApiKey);
  if (err) {
    openApiKeyEdit(storedApiKey);
    showSettingsError(err);
    settingsErrorEl.closest('details').open = true;
    editOpenedForBadKey = true;
  } else {
    hideSettingsError();
  }
});

saveSettingsBtn.addEventListener('click', async () => {
  const backendUrl = settingsUrlEl.value.trim().replace(/\/+$/, '');
  const deviceLabel = settingsDeviceLabelEl.value.trim();

  const editOpen = !apiKeyEditEl.classList.contains('hidden');
  const newKey = settingsKeyEl.value.trim();
  const changingKey = editOpen && newKey !== '';
  // Empty-input Save closes the edit block, unless the load-time
  // bad-stored-key path opened it and the stored key is still invalid --
  // then the error must stay visible instead of being swept away.
  const stillBadFromLoad = editOpenedForBadKey && Boolean(validateApiKey(storedApiKey));
  const clearingEdit = editOpen && newKey === '' && !stillBadFromLoad;

  if (changingKey) {
    const err = validateApiKey(newKey);
    if (err) {
      showSettingsError(err);
      return;
    }
    hideSettingsError();
  }

  const payload = { backendUrl, deviceLabel };
  if (changingKey) payload.apiKey = newKey;

  try {
    await saveConfig(payload);
  } catch (err) {
    showSettingsError(err.message);
    return;
  }

  if (changingKey) {
    storedApiKey = newKey;
    editOpenedForBadKey = false;
    renderMaskedKey();
    closeApiKeyEdit();
  } else if (clearingEdit) {
    closeApiKeyEdit();
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

chrome.storage.local.get('defaultTab', (data) => {
  const defaultTab = data.defaultTab || 'passive';
  activateTab(defaultTab);
  updateDefaultIndicators(defaultTab);
});

updateStatus();
