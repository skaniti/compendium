import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeShim, silenceLog } from './helpers/chrome-shim.mjs';

// Shim must be installed before the dynamic import: config.js reads
// chrome.storage at call time, not import time.
const shim = installChromeShim();
silenceLog();

const { validateApiKey, saveConfig, maskApiKey, CONFIG } = await import('../modules/config.js');

// ── CONFIG additions ─────────────────────────────────────────────────────────

test('CONFIG: flush pacing constants', () => {
  assert.equal(CONFIG.FLUSH_BATCH_MAX, 10);
  assert.equal(CONFIG.FLUSH_ALARM_NAME, 'pending_export_flush');
  assert.equal(CONFIG.FLUSH_ALARM_PERIOD_MINUTES, 1);
});

test('CONFIG: RELEASE_NOTES_URL defaults empty', () => {
  assert.equal(CONFIG.RELEASE_NOTES_URL, '');
});

// ── maskApiKey ───────────────────────────────────────────────────────────────

test('maskApiKey: a cmp_ key keeps a 7-char prefix, then (len - 7) bullets', () => {
  // 'cmp_7f3abcdef123' is 16 chars -> 16 - 7 = 9 bullets
  assert.equal(maskApiKey('cmp_7f3abcdef123'), 'cmp_7f3•••••••••');
});

test('maskApiKey: a short key (shorter than the prefix) is not padded out', () => {
  assert.equal(maskApiKey('cmp_a'), 'cmp_a');
});

test('maskApiKey: empty/undefined/null render as empty string', () => {
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey(undefined), '');
  assert.equal(maskApiKey(null), '');
});

test('maskApiKey: a non-cmp_ key shows only a 3-char prefix, then (len - 3) bullets', () => {
  // 'abcdefgh' is 8 chars -> 8 - 3 = 5 bullets
  assert.equal(maskApiKey('abcdefgh'), 'abc•••••');
});

test('maskApiKey: bullet count caps at 24 for very long keys', () => {
  const longKey = 'cmp_' + 'x'.repeat(40); // 44 chars -> 44 - 7 = 37, capped to 24
  assert.equal(maskApiKey(longKey), 'cmp_xxx' + '•'.repeat(24));
});

// ── validateApiKey ───────────────────────────────────────────────────────────

test('validateApiKey: empty/undefined/null are valid (no key)', () => {
  assert.equal(validateApiKey(''), null);
  assert.equal(validateApiKey(undefined), null);
  assert.equal(validateApiKey(null), null);
});

test('validateApiKey: a normal cmp_ key is valid', () => {
  assert.equal(validateApiKey('cmp_abcDEF123XYZ'), null);
});

test('validateApiKey: boundary printable-ASCII chars (0x21, 0x7e) are valid', () => {
  assert.equal(validateApiKey('!~'), null);
});

test('validateApiKey: em dash (U+2014) reports char, code point and 1-based position', () => {
  const key = 'abc—def';
  const msg = validateApiKey(key);
  assert.equal(msg, 'Invalid character "—" (U+2014) at position 4 — re-paste the key');
});

test('validateApiKey: NBSP (U+00A0) is rejected', () => {
  const key = 'abc def';
  const msg = validateApiKey(key);
  assert.equal(msg, 'Invalid character " " (U+00A0) at position 4 — re-paste the key');
});

test('validateApiKey: leading space (U+0020) is rejected', () => {
  const msg = validateApiKey(' cmp_abc');
  assert.equal(msg, 'Invalid character " " (U+0020) at position 1 — re-paste the key');
});

test('validateApiKey: newline is reported as the escaped form \\n', () => {
  const key = 'cmp_abc\ndef';
  const msg = validateApiKey(key);
  assert.equal(msg, 'Invalid character "\\n" (U+000A) at position 8 — re-paste the key');
});

test('validateApiKey: DEL (0x7f) is rejected and escaped', () => {
  const msg = validateApiKey('abc\x7Fdef');
  assert.match(msg, /U\+007F/);
  assert.match(msg, /\\x7f/);
});

test('validateApiKey: stops at the FIRST violation', () => {
  const key = 'ab—cd ef';
  const msg = validateApiKey(key);
  assert.match(msg, /U\+2014/);
  assert.doesNotMatch(msg, /U\+00A0/);
});

// ── saveConfig ────────────────────────────────────────────────────────────────

test('saveConfig: throws on an invalid apiKey and does not store it', async () => {
  shim.reset();
  await assert.rejects(
    () => saveConfig({ apiKey: 'cmp_bad—key' }),
    (err) => err instanceof Error && /Invalid character/.test(err.message)
  );
  assert.equal(shim.storage.has('apiKey'), false);
});

test('saveConfig: accepts and stores a valid apiKey', async () => {
  shim.reset();
  await saveConfig({ apiKey: 'cmp_goodkey123' });
  assert.equal(shim.storage.get('apiKey'), 'cmp_goodkey123');
});

test('saveConfig: accepts an empty apiKey (clears the stored key)', async () => {
  shim.reset();
  await saveConfig({ apiKey: '' });
  assert.equal(shim.storage.get('apiKey'), '');
});

test('saveConfig: apiKey omitted entirely does not validate or touch storage', async () => {
  shim.reset();
  await saveConfig({ backendUrl: 'http://example.test' });
  assert.equal(shim.storage.has('apiKey'), false);
  assert.equal(shim.storage.get('backendUrl'), 'http://example.test');
});

test('saveConfig: apiKey \'\' clears an existing key; saveConfig({}) leaves it untouched', async () => {
  shim.reset();
  await saveConfig({ apiKey: 'cmp_existing123' });
  assert.equal(shim.storage.get('apiKey'), 'cmp_existing123');

  await saveConfig({});
  assert.equal(shim.storage.get('apiKey'), 'cmp_existing123');

  await saveConfig({ apiKey: '' });
  assert.equal(shim.storage.get('apiKey'), '');
});
