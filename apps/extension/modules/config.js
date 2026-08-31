/**
 * Shared configuration for the unified extension.
 *
 * URL and API key are stored in chrome.storage.local and loaded via getConfig().
 * Defaults point to local dev backend.
 */

const DEFAULTS = {
  backendUrl: 'http://localhost:8001',
  apiKey: '',
  deviceLabel: ''
};

/**
 * Load user-configurable settings from chrome.storage.local.
 * Falls back to DEFAULTS for any missing keys.
 */
export async function getConfig() {
  const stored = await chrome.storage.local.get(['backendUrl', 'apiKey', 'deviceLabel']);
  return {
    backendUrl: (stored.backendUrl || DEFAULTS.backendUrl).replace(/\/+$/, ''),
    apiKey: stored.apiKey || DEFAULTS.apiKey,
    deviceLabel: (stored.deviceLabel || DEFAULTS.deviceLabel).trim()
  };
}

/**
 * Save user-configurable settings to chrome.storage.local.
 */
export async function saveConfig({ backendUrl, apiKey, deviceLabel }) {
  const updates = {};
  if (backendUrl !== undefined) updates.backendUrl = backendUrl;
  if (apiKey !== undefined) updates.apiKey = apiKey;
  if (deviceLabel !== undefined) updates.deviceLabel = deviceLabel;
  await chrome.storage.local.set(updates);
}

/**
 * Build standard headers for backend requests, including API key if set.
 *
 * X-API-Key contract is a three-way twin: this header, verify_api_key in
 * apps/api/backend/api/main.py, and the request in
 * apps/android/.../SessionExporter.kt.
 */
export function buildHeaders(config) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['X-API-Key'] = config.apiKey;
  return headers;
}

export const CONFIG = {
  trackedDomains: [
    'wikipedia.org',
    'youtube.com',
    'reddit.com',
    'stackoverflow.com',
    'arxiv.org',
    'github.com'
  ],

  // Passive capture segmentation
  INACTIVITY_TIMEOUT_MS: 60 * 60 * 1000, // 60 minutes
  ALARM_DELAY_MINUTES: 61,
  ALARM_NAME: 'passive_capture_timeout',
  MAX_CAPTURE_SIZE: 100,
  MAX_CAPTURE_AGE_MS: 24 * 60 * 60 * 1000,
  TRIVIAL_THRESHOLD: 3,

  // Export cache retention
  EXPORT_CACHE_MAX_ENTRIES: 56,
  EXPORT_CACHE_TTL_MS: 28 * 24 * 60 * 60 * 1000
};
