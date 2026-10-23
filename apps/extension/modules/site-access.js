/**
 * Site access -- detecting a withheld host permission.
 *
 * A user can withhold or later revoke the extension's site access (Firefox:
 * about:addons, Permissions; Chrome: site access "on click" or "on specific
 * sites"). Without access to the backend's origin every upload is
 * CORS-checked, the API refuses the extension's origin at the preflight, and
 * fetch() throws a TypeError -- indistinguishable, at the call site, from the
 * backend being unreachable. This module answers the one question that tells
 * them apart: does the extension currently hold access to the configured
 * backend origin?
 *
 * Detection looks at the backend origin (what uploads need), not at
 * `<all_urls>`: a Chrome user who allowed only the backend's site has working
 * uploads and must not see a banner saying otherwise. The Grant action
 * requests `<all_urls>` (SITE_ACCESS_REQUEST) -- the manifest's declared
 * permission, which page-text capture also needs -- as a constant, because
 * Firefox only honours permissions.request() inside the user-input handler
 * and reading config first would cost the gesture.
 *
 * Everything here fails open: an unavailable permissions API, an unparseable
 * backend URL, or a throwing contains() all count as "granted", so this can
 * only ever add a warning that is true, never invent one.
 */

import { getConfig } from './config.js';

/** Flush stop reason / retry delivery value for a missing host permission. */
export const SITE_ACCESS_STOP = 'site_access';

/** lastError / error text carried alongside SITE_ACCESS_STOP. */
export const SITE_ACCESS_ERROR = 'site access missing';

/** Argument to permissions.request() -- a constant so it can be called with no prior await. */
export const SITE_ACCESS_REQUEST = { origins: ['<all_urls>'] };

const DEFAULT_TITLE = 'Compendium Capture';
const BADGE_TEXT = '!';
const BADGE_COLOR = '#C9A66B';

/**
 * Match pattern covering the backend's origin, or null when the URL cannot be
 * one (unparseable, or not http/https). Match patterns ignore the port.
 *
 * @param {string} backendUrl
 * @returns {string|null}
 */
export function backendOriginPattern(backendUrl) {
  let url;
  try {
    url = new URL(backendUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * True when the extension may talk to the configured backend, or when that
 * cannot be determined (see the fail-open note in the header).
 *
 * @returns {Promise<boolean>}
 */
export async function hasSiteAccess() {
  if (typeof chrome === 'undefined' || !chrome.permissions || !chrome.permissions.contains) {
    return true;
  }
  try {
    const { backendUrl } = await getConfig();
    const pattern = backendOriginPattern(backendUrl);
    if (!pattern) return true;
    return Boolean(await chrome.permissions.contains({ origins: [pattern] }));
  } catch (err) {
    console.warn('[SiteAccess] permissions check failed:', err);
    return true;
  }
}

/**
 * Show or clear the toolbar badge (and its tooltip). A missing chrome.action
 * (older browser, test shim) is not an error.
 */
export async function setSiteAccessBadge(missing) {
  const action = typeof chrome === 'undefined' ? null : chrome.action;
  if (!action) return;
  try {
    await action.setBadgeText({ text: missing ? BADGE_TEXT : '' });
    if (missing) await action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await action.setTitle({
      title: missing ? `${DEFAULT_TITLE}: site access is off, captures cannot be uploaded` : DEFAULT_TITLE
    });
  } catch (err) {
    console.warn('[SiteAccess] badge update failed:', err);
  }
}

/**
 * Re-check access and make the badge match. Returns whether access is present.
 *
 * @returns {Promise<boolean>}
 */
export async function refreshSiteAccessBadge() {
  const granted = await hasSiteAccess();
  await setSiteAccessBadge(!granted);
  return granted;
}

/**
 * Keep the badge current: once now (service-worker start, which also covers
 * a fresh install), and again whenever a permission is added or removed or
 * the backend URL changes. Listeners register synchronously, so call this at
 * the top level of the background script. Resolves after the initial check.
 *
 * @returns {Promise<boolean>}
 */
export function startSiteAccessMonitor() {
  const refresh = () => {
    refreshSiteAccessBadge().catch(err => console.warn('[SiteAccess] refresh failed:', err));
  };
  if (chrome.permissions) {
    if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(refresh);
    if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(refresh);
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.backendUrl) refresh();
  });
  return refreshSiteAccessBadge();
}

/**
 * Banner content, DOM-free so the text and visibility rules are unit-tested.
 * `denied` is set after a Grant attempt that did not end in access (the user
 * said no, or the browser refused the request).
 *
 * @param {{ missing: boolean, denied?: boolean }} state
 * @returns {{ visible: boolean, text: string, buttonLabel: string }}
 */
export function composeSiteAccessBanner({ missing, denied = false }) {
  if (!missing) return { visible: false, text: '', buttonLabel: '' };
  const text = denied
    ? "Access was not granted. You can allow it in your browser's extension settings (Firefox: about:addons, Permissions)."
    : "Site access is off, so captures can't be uploaded.";
  return { visible: true, text, buttonLabel: 'Grant access' };
}
