/**
 * In-memory chrome.* shim for node:test.
 *
 * export.js/config.js read chrome.storage at call time (not import time), so
 * callers must call installChromeShim() BEFORE dynamically importing the
 * modules under test. There is no real browser here -- storage is a plain
 * Map, alarms are recorded (not scheduled), and fetch is stubbed separately
 * via fetchQueue(). chrome.permissions is a single granted/not-granted flag
 * (default granted, so tests that don't care about site access are unaffected)
 * and chrome.action records the toolbar badge.
 */

function normalizeKeys(keys) {
  if (keys === null || keys === undefined) return null; // null = "all keys"
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys;
  // chrome allows an object of {key: defaultValue} -- we only need the names.
  return Object.keys(keys);
}

/**
 * Installs `chrome` and `navigator` on globalThis and returns handles for
 * asserting on stored state / alarm activity from tests.
 *
 * @returns {{
 *   storage: Map,
 *   alarms: { created: Array, cleared: Array },
 *   permissions: { granted: boolean, requestResult: boolean|'throw', containsCalls: Array,
 *                  requests: Array, fireAdded: Function, fireRemoved: Function },
 *   action: { badgeText: string, badgeColor: string|null, title: string|null },
 *   runtime: { version: string },
 *   reset: () => void
 * }}
 */
export function installChromeShim() {
  const store = new Map();
  const alarms = { created: [], cleared: [] };
  const storageListeners = [];
  const permissionListeners = { added: [], removed: [] };

  const permissions = {
    granted: true,
    // What request() resolves to: true grants (and fires onAdded), false is a
    // user denial, 'throw' rejects (Firefox does this outside a user gesture).
    requestResult: true,
    containsCalls: [],
    requests: [],
    fireAdded() {
      permissionListeners.added.forEach(fn => fn({ origins: [], permissions: [] }));
    },
    fireRemoved() {
      permissionListeners.removed.forEach(fn => fn({ origins: [], permissions: [] }));
    }
  };

  const action = { badgeText: '', badgeColor: null, title: null };

  // chrome.runtime: only getManifest() is read (config.js::buildHeaders puts
  // the manifest version in X-Compendium-Client). Tests may change .version.
  const runtime = { version: '0.0.0-test' };

  function get(keys, callback) {
    const names = normalizeKeys(keys);
    const result = {};
    if (names === null) {
      for (const [k, v] of store) result[k] = v;
    } else {
      for (const k of names) {
        if (store.has(k)) result[k] = store.get(k);
      }
    }
    if (typeof callback === 'function') {
      callback(result);
      return undefined;
    }
    return Promise.resolve(result);
  }

  function set(items, callback) {
    for (const [k, v] of Object.entries(items)) store.set(k, v);
    if (storageListeners.length > 0) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) changes[k] = { newValue: v };
      storageListeners.forEach(fn => fn(changes, 'local'));
    }
    if (typeof callback === 'function') {
      callback();
      return undefined;
    }
    return Promise.resolve();
  }

  function remove(keys, callback) {
    const names = Array.isArray(keys) ? keys : [keys];
    for (const k of names) store.delete(k);
    if (typeof callback === 'function') {
      callback();
      return undefined;
    }
    return Promise.resolve();
  }

  globalThis.chrome = {
    storage: {
      local: { get, set, remove },
      onChanged: { addListener: fn => storageListeners.push(fn) }
    },
    permissions: {
      async contains(query) {
        permissions.containsCalls.push(query);
        return permissions.granted;
      },
      async request(query) {
        permissions.requests.push(query);
        if (permissions.requestResult === 'throw') {
          throw new Error('permissions.request may only be called from a user input handler');
        }
        if (permissions.requestResult) {
          permissions.granted = true;
          permissions.fireAdded();
        }
        return permissions.requestResult;
      },
      onAdded: { addListener: fn => permissionListeners.added.push(fn) },
      onRemoved: { addListener: fn => permissionListeners.removed.push(fn) }
    },
    runtime: {
      getManifest() {
        return { version: runtime.version };
      }
    },
    action: {
      async setBadgeText({ text }) {
        action.badgeText = text;
      },
      async setBadgeBackgroundColor({ color }) {
        action.badgeColor = color;
      },
      async setTitle({ title }) {
        action.title = title;
      }
    },
    alarms: {
      create(name, info) {
        alarms.created.push({ name, info });
      },
      clear(name, callback) {
        alarms.cleared.push(name);
        if (typeof callback === 'function') {
          callback(true);
          return undefined;
        }
        return Promise.resolve(true);
      }
    }
  };

  // Node >= 21 defines a built-in `navigator` global as a getter with no
  // setter, so a plain assignment throws under strict-mode ESM. Redefine it
  // (it's configurable) rather than assigning to it.
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'test' },
    configurable: true,
    writable: true,
    enumerable: true
  });

  function reset() {
    store.clear();
    alarms.created.length = 0;
    alarms.cleared.length = 0;
    storageListeners.length = 0;
    permissionListeners.added.length = 0;
    permissionListeners.removed.length = 0;
    permissions.granted = true;
    permissions.requestResult = true;
    permissions.containsCalls.length = 0;
    permissions.requests.length = 0;
    action.badgeText = '';
    action.badgeColor = null;
    action.title = null;
    runtime.version = '0.0.0-test';
  }

  return { storage: store, alarms, permissions, action, runtime, reset };
}

/**
 * Installs globalThis.fetch to return a queued sequence of responses, one
 * per call, in order. Each entry is either:
 *   { status, json }  -> resolves { ok: 2xx, status, json: async () => json }
 *   { throw: 'msg' }  -> the call rejects by throwing a TypeError('msg')
 *     (mirrors the real failure mode: fetch() rejects with a TypeError when
 *     a header value can't be encoded, or when the network is unreachable)
 *
 * Calling fetch more times than there are queued responses is a test setup
 * bug -- it throws immediately so it fails loudly instead of silently
 * reusing/looping.
 *
 * @returns {Array<{url: string, options: object, body: any}>} recorded calls
 */
export function fetchQueue(responses) {
  const calls = [];
  let index = 0;

  globalThis.fetch = async (url, options) => {
    if (index >= responses.length) {
      throw new Error(
        `fetchQueue exhausted: call ${index + 1} had no queued response (url=${url})`
      );
    }
    const entry = responses[index];
    index += 1;

    const body = options && options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, options, body });

    if (entry.throw) {
      throw new TypeError(entry.throw);
    }

    const status = entry.status;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (entry.json !== undefined ? entry.json : {})
    };
  };

  return calls;
}

/**
 * Replaces console.warn with a spy that records call args (without
 * stringifying them -- callers can assert an Error/object instance was
 * passed as a distinct argument). Call .restore() to put the original back.
 */
export function spyWarn() {
  const calls = [];
  const original = console.warn;
  console.warn = (...args) => calls.push(args);
  return {
    calls,
    restore() {
      console.warn = original;
    }
  };
}

/**
 * Silences console.log for the rest of the process. Call once per test
 * file, alongside installChromeShim() -- unlike spyWarn(), this isn't a
 * per-test spy/restore: export.js logs a success line on every delivered
 * capture, which is pure pass-through noise no test asserts on, and
 * spying/restoring it around every single test would be ceremony for
 * nothing. console.warn stays untouched -- warning assertions are real
 * coverage and keep using spyWarn() as before.
 */
export function silenceLog() {
  console.log = () => {};
}
