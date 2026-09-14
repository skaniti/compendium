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

const CONTROL_CHAR_ESCAPES = { 0x09: '\\t', 0x0a: '\\n', 0x0d: '\\r' };

function renderChar(ch, code) {
  if (CONTROL_CHAR_ESCAPES[code]) return CONTROL_CHAR_ESCAPES[code];
  if (code < 0x20 || code === 0x7f) {
    return '\\x' + code.toString(16).padStart(2, '0');
  }
  return ch;
}

/**
 * Validate an API key for the ByteString-safe header contract (spec:
 * the 2026-09-09 extension-hardening plan (private), spec.md,
 * D1). Keys are `cmp_...` ASCII; every character must be printable ASCII
 * (U+0021-U+007E). An empty/missing key is valid (means "no key") -- it is
 * NOT the same failure class as a key containing an invalid character.
 *
 * Returns null when valid, or a human message naming the first offending
 * character, its code point, and its 1-based position.
 */
export function validateApiKey(key) {
  if (key === undefined || key === null || key === '') return null;

  const chars = Array.from(key);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const code = ch.codePointAt(0);
    if (code < 0x21 || code > 0x7e) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      return `Invalid character "${renderChar(ch, code)}" (U+${hex}) at position ${i + 1} — re-paste the key`;
    }
  }
  return null;
}

/**
 * Save user-configurable settings to chrome.storage.local.
 * Throws when apiKey is provided and fails validateApiKey (defense in
 * depth -- callers are expected to validate first and show an inline error).
 */
export async function saveConfig({ backendUrl, apiKey, deviceLabel }) {
  if (apiKey !== undefined) {
    const error = validateApiKey(apiKey);
    if (error) throw new Error(error);
  }

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

const MASK_BULLET = '•'; // •
const MASK_BULLET_MAX = 24;

/**
 * Render a stored API key as a masked readout for display -- never the raw
 * key. The masked text IS the settings field's value (there's no separate
 * readout/edit toggle), so it must look like a plausible key rather than a
 * fixed-width placeholder: `cmp_` keys keep the 4-char prefix plus 3 more
 * characters (7 total) so a `cmp_` key is visually recognizable; any other
 * key shows only its first 3 characters. The bullet run mirrors the real
 * key's remaining length (capped at 24, so a very long key doesn't produce
 * an unbounded run) -- a key shorter than the prefix is not padded out.
 */
export function maskApiKey(key) {
  if (!key) return '';
  const prefixLen = key.startsWith('cmp_') ? 7 : 3;
  const prefix = key.slice(0, prefixLen);
  const bulletCount = Math.min(Math.max(key.length - prefixLen, 0), MASK_BULLET_MAX);
  return prefix + MASK_BULLET.repeat(bulletCount);
}

export const CONFIG = {
  // Release-notes page for the version link in the popup footer. Set to the
  // release-notes page when it exists; empty renders the version as plain
  // text (no link).
  RELEASE_NOTES_URL: '',

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

  // Export cache retention. Sizing: a capture is ~100 KB and we observe
  // ~9/week, so 52 weeks of history is ~9 * 52 * 100 KB =~ 47 MB -- well
  // over Chrome's 10 MB storage.local default quota, hence
  // "unlimitedStorage" in manifest.json's permissions. This is affordable
  // under the v2 layout (modules/export.js) because retention is per-
  // capture entries (`'cache:' + captureId`) plus one lightweight summary
  // array (`cacheIndex`) -- a finalize never rewrites the whole history,
  // and listing/rendering the History view never touches page text, only
  // the index. EXPORT_CACHE_MAX_ENTRIES is a belt-and-braces cap (600 =~ 52
  // weeks at ~9/week with headroom) independent of TTL.
  EXPORT_CACHE_MAX_ENTRIES: 600,
  EXPORT_CACHE_TTL_MS: 52 * 7 * 24 * 60 * 60 * 1000, // 52 weeks

  // Flush pacing (spec D4/D7): no Retry-After exists, so the client
  // self-paces via a per-pass cap and a periodic alarm.
  FLUSH_BATCH_MAX: 10,
  FLUSH_ALARM_NAME: 'pending_export_flush',
  FLUSH_ALARM_PERIOD_MINUTES: 1
};
