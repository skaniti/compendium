/**
 * Unified Extension — Popup Script (Tabbed Layout)
 *
 * Two tabs: Passive (default) and Active. Both trackers run concurrently
 * regardless of which tab is visible — this is purely a UI concern.
 */

// ── DOM refs ─────────────────────────────────────────────────────────────────

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
    setDefaultPassiveBtn.textContent = 'Default view';
    setDefaultPassiveBtn.classList.add('is-default');
    setDefaultActiveBtn.textContent = 'Set as default view';
    setDefaultActiveBtn.classList.remove('is-default');
  } else {
    setDefaultActiveBtn.textContent = 'Default view';
    setDefaultActiveBtn.classList.add('is-default');
    setDefaultPassiveBtn.textContent = 'Set as default view';
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
  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }
}

function showActiveRecording(startTime, pageCount) {
  journeyReadyEl.classList.add('hidden');
  journeyActiveEl.classList.remove('hidden');
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

const STATUS_MESSAGES = {
  delivered: 'Capture delivered to backend',
  buffered: 'Capture buffered — will retry on next delivery',
  no_capture: 'No active capture to export',
  failed: 'Export failed'
};

function showExportStatus(delivery) {
  exportStatusEl.textContent = STATUS_MESSAGES[delivery] || STATUS_MESSAGES.failed;
  exportStatusEl.className = `export-status export-${delivery}`;
  exportStatusEl.classList.remove('hidden');

  clearTimeout(showExportStatus._timer);
  showExportStatus._timer = setTimeout(() => {
    exportStatusEl.classList.add('hidden');
  }, 5000);
}

forceExportBtn.addEventListener('click', async () => {
  forceExportBtn.disabled = true;
  forceExportBtn.textContent = 'Exporting...';

  try {
    const response = await chrome.runtime.sendMessage({ action: 'forceFinalize' });
    showExportStatus(response.delivery);
    await updateStatus();
  } catch {
    showExportStatus('failed');
  } finally {
    forceExportBtn.disabled = false;
    forceExportBtn.textContent = 'Force Export';
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

// Load current settings
chrome.storage.local.get(['backendUrl', 'apiKey', 'deviceLabel'], (data) => {
  settingsUrlEl.value = data.backendUrl || 'http://localhost:8001';
  settingsKeyEl.value = data.apiKey || '';
  settingsDeviceLabelEl.value = data.deviceLabel || '';
});

saveSettingsBtn.addEventListener('click', async () => {
  const backendUrl = settingsUrlEl.value.trim().replace(/\/+$/, '');
  const apiKey = settingsKeyEl.value.trim();
  const deviceLabel = settingsDeviceLabelEl.value.trim();
  await chrome.storage.local.set({ backendUrl, apiKey, deviceLabel });

  settingsSavedEl.classList.remove('hidden');
  setTimeout(() => settingsSavedEl.classList.add('hidden'), 2000);
});

// ── Init ─────────────────────────────────────────────────────────────────────

chrome.storage.local.get('defaultTab', (data) => {
  const defaultTab = data.defaultTab || 'passive';
  activateTab(defaultTab);
  updateDefaultIndicators(defaultTab);
});

updateStatus();
