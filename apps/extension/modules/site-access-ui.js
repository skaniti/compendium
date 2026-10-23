/**
 * Site-access banner wiring shared by the popup and the cache page.
 *
 * Both pages carry the same three elements (banner, text, Grant button); this
 * shows the banner while access to the backend is missing, keeps it current
 * as permissions change, and runs the Grant click. It touches only
 * classList/textContent/disabled/addEventListener so it can be driven with
 * plain stand-in objects in node:test.
 */

import {
  SITE_ACCESS_REQUEST,
  composeSiteAccessBanner,
  refreshSiteAccessBadge
} from './site-access.js';

/**
 * @param {{ banner: HTMLElement, text: HTMLElement, button: HTMLButtonElement }} els
 * @returns {Promise<void>} resolves after the first check has rendered
 */
export function initSiteAccessBanner({ banner, text, button }) {
  function render(missing, denied = false) {
    const view = composeSiteAccessBanner({ missing, denied });
    banner.classList.toggle('hidden', !view.visible);
    if (view.visible) {
      text.textContent = view.text;
      button.textContent = view.buttonLabel;
    }
  }

  async function refresh() {
    // Also re-syncs the toolbar badge, so opening either page corrects a
    // badge a browser failed to clear (no permissions.onAdded event).
    render(!(await refreshSiteAccessBadge()));
  }

  button.addEventListener('click', async () => {
    // permissions.request() must be the click handler's first call -- no
    // await before it -- or Firefox treats it as not user-initiated and
    // rejects it. SITE_ACCESS_REQUEST is a constant for that reason.
    button.disabled = true;
    let granted = false;
    try {
      granted = Boolean(await chrome.permissions.request(SITE_ACCESS_REQUEST));
    } catch (err) {
      console.warn('[SiteAccess] permissions.request failed:', err);
    }
    // The request resolving true only means the permission was granted;
    // re-check against the configured backend rather than trusting it.
    const stillMissing = !(await refreshSiteAccessBadge());
    render(stillMissing, stillMissing && !granted);
    button.disabled = false;
  });

  if (chrome.permissions) {
    const onChange = () => {
      refresh().catch(err => console.warn('[SiteAccess] refresh failed:', err));
    };
    if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(onChange);
    if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(onChange);
  }

  return refresh();
}
