import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeExportResult } from '../modules/export-status.js';

// composeExportResult is DOM-free (no chrome, no document) -- no shim needed.
// Pins the exact behaviour lifted out of popup.js's showExportResult().

test('composeExportResult: delivered + 2 flushed + 0 remaining -> "Exported 3, 0 buffered" / export-ok', () => {
  const result = composeExportResult({
    success: true,
    delivery: 'delivered',
    flush: { attempted: 2, delivered: 2, remaining: 0, stop: null, lastError: null }
  });
  assert.deepEqual(result, { text: 'Exported 3, 0 buffered', cls: 'export-ok' });
});

test('composeExportResult: no_capture + 0/3 offline -> "Exported 0, 3 buffered (backend unreachable)" / export-warn', () => {
  const result = composeExportResult({
    success: true,
    delivery: 'no_capture',
    flush: { attempted: 1, delivered: 0, remaining: 3, stop: 'offline', lastError: 'network unreachable' }
  });
  assert.deepEqual(result, {
    text: 'Exported 0, 3 buffered (backend unreachable)',
    cls: 'export-warn'
  });
});

test('composeExportResult: rate_limited stop appends the rate-limit hint', () => {
  const result = composeExportResult({
    success: true,
    delivery: 'delivered',
    flush: { delivered: 0, remaining: 2, stop: 'rate_limited', lastError: 'HTTP 429' }
  });
  assert.deepEqual(result, {
    text: 'Exported 1, 2 buffered (rate limited, retrying in a minute)',
    cls: 'export-warn'
  });
});

test('composeExportResult: batch_cap stop appends the batch-cap hint', () => {
  const result = composeExportResult({
    success: true,
    delivery: 'buffered',
    flush: { delivered: 10, remaining: 2, stop: 'batch_cap', lastError: null }
  });
  assert.deepEqual(result, {
    text: 'Exported 10, 2 buffered (more will flush shortly)',
    cls: 'export-warn'
  });
});

test('composeExportResult: auth stop appends the auth hint', () => {
  const result = composeExportResult({
    success: true,
    delivery: 'delivered',
    flush: { delivered: 0, remaining: 1, stop: 'auth', lastError: 'HTTP 401' }
  });
  assert.deepEqual(result, {
    text: 'Exported 1, 1 buffered (rejected: check API key)',
    cls: 'export-warn'
  });
});

test('composeExportResult: buffered>0 with stop null and a lastError appends ": <lastError>"', () => {
  const result = composeExportResult({
    success: true,
    delivery: 'delivered',
    flush: { delivered: 0, remaining: 1, stop: null, lastError: 'HTTP 422' }
  });
  assert.equal(result.text.endsWith(': HTTP 422'), true);
  assert.deepEqual(result, { text: 'Exported 1, 1 buffered: HTTP 422', cls: 'export-warn' });
});

test('composeExportResult: no_capture + 0/0 -> "Nothing to export" / export-ok', () => {
  const result = composeExportResult({
    success: true,
    delivery: 'no_capture',
    flush: { delivered: 0, remaining: 0, stop: null, lastError: null }
  });
  assert.deepEqual(result, { text: 'Nothing to export', cls: 'export-ok' });
});

test('composeExportResult: success false with no flush -> "Export failed" / export-failed', () => {
  const result = composeExportResult({ success: false, delivery: 'failed', flush: null });
  assert.deepEqual(result, { text: 'Export failed', cls: 'export-failed' });
});

test('composeExportResult: success false with a flush.lastError appends ": <msg>"', () => {
  const result = composeExportResult({
    success: false,
    delivery: 'failed',
    flush: { delivered: 0, remaining: 0, stop: null, lastError: 'HTTP 500' }
  });
  assert.deepEqual(result, { text: 'Export failed: HTTP 500', cls: 'export-failed' });
});

test('composeExportResult: undefined flush is tolerated (delivered with no flush pass)', () => {
  const result = composeExportResult({ success: true, delivery: 'delivered', flush: undefined });
  assert.deepEqual(result, { text: 'Exported 1, 0 buffered', cls: 'export-ok' });
});

test('composeExportResult: undefined flush is tolerated (success false)', () => {
  const result = composeExportResult({ success: false, delivery: 'failed', flush: undefined });
  assert.deepEqual(result, { text: 'Export failed', cls: 'export-failed' });
});
