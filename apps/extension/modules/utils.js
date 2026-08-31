/**
 * Pure utility functions — no side effects, no Chrome API calls.
 */

import { CONFIG } from './config.js';

export function generateCaptureId() {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function isTrackedDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return CONFIG.trackedDomains.some(domain => hostname.includes(domain));
  } catch {
    return false;
  }
}

// Per-domain canonicalization table. Keep in parity with DOMAIN_RULES in
// apps/api/backend/utils/url_normalize.py — same domains, same params, same
// fold semantics ($1 backreference survives, everything else matched by the
// pattern is dropped). Add new rules as new rows, not new branches; the
// apply logic below is domain-agnostic.
//
// `domain` matches the request host either exactly or as a subdomain of it
// (host === domain || host.endsWith('.' + domain)) — apex entries such as
// "zillow.com" or "printables.com" therefore also cover the "www." forms
// seen in real capture data. Entries that are themselves already a specific
// subdomain (e.g. "www.thingiverse.com") stay scoped to that subdomain and
// its children only — they do not bleed onto sibling subdomains that may
// serve different content.
const DOMAIN_RULES = [
  // Luma event links carry a per-share/per-session `tk` token.
  { domain: 'luma.com', stripParams: ['tk'] },
  // Zillow's `mmlb` param indexes into the photo carousel; same listing.
  { domain: 'zillow.com', stripParams: ['mmlb'] },
  // GitHub's `tab` param selects a profile/repo view tab, not a resource.
  { domain: 'github.com', stripParams: ['tab'] },
  // Thingiverse: /thing:<id>/comments is a tab on the thing page itself.
  {
    domain: 'www.thingiverse.com',
    pathFold: { pattern: /^(\/thing:\d+)\/comments$/, replacement: '$1' },
  },
  // Printables: /model/<id>[-slug]/(files|comments) are tabs on the model.
  {
    domain: 'printables.com',
    pathFold: {
      pattern: /^(\/model\/\d+(?:-[^/]+)?)\/(?:files|comments)$/,
      replacement: '$1',
    },
  },
];

function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Canonical URL normalization for dedup comparison.
 *
 * MUST produce output identical to apps/api/backend/utils/url_normalize.py
 * on any URL both normalizers accept. The Python side is the source of
 * truth — see apps/api/tests/test_url_normalize.py for the parity fixture
 * list. This parity
 * requirement covers both the global rules below AND DOMAIN_RULES above —
 * any row added to one side must be added to the other, verbatim, in the
 * same conversation/commit. If you change either side, run the fixtures
 * through both implementations.
 *
 * Rules (in order, mirroring the Python implementation):
 *   1. Strip #fragment.
 *   2. Lowercase host only (not path — case-sensitive paths like GitHub
 *      URLs must be preserved).
 *   3. Strip trailing slash from path, except when path is exactly "/".
 *   4. Apply per-domain path folds (DOMAIN_RULES) — collapses structural
 *      sub-paths (comment/file/post-number tabs) that address the same
 *      underlying resource down to a canonical path.
 *   5. Drop known tracking query parameters (TRACKING_PARAMS), plus any
 *      per-domain params from DOMAIN_RULES for the matching host.
 *   6. Sort remaining query params alphabetically by key for deterministic
 *      ordering. URLSearchParams.sort() is stable.
 *   7. Preserve: scheme, port, userinfo, path casing, query-value encoding.
 *
 * Returns the original URL on parse failure.
 */
export function normalizeUrlForDedup(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Rule 1: strip fragment
    parsed.hash = '';

    // Rule 2: lowercase host only. URL.hostname setter is safe and
    // preserves port/userinfo. Path casing is untouched.
    parsed.hostname = host;

    // Rule 3: strip trailing slash except on root "/"
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    }

    // Rule 4: per-domain path folds. No-op if no rule matches this host or
    // the path doesn't match the rule's pattern.
    for (const rule of DOMAIN_RULES) {
      if (rule.pathFold && domainMatches(host, rule.domain)) {
        parsed.pathname = parsed.pathname.replace(
          rule.pathFold.pattern,
          rule.pathFold.replacement
        );
        break;
      }
    }

    // Rule 5: drop tracking params. Keep this list in sync with the
    // Python mirror at apps/api/backend/utils/url_normalize.py::TRACKING_PARAMS.
    const TRACKING_PARAMS = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'gclsrc',
      'mc_cid', 'mc_eid',
      'share_id',
    ];
    for (const param of TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }

    // Rule 5b: drop per-domain params for the matching host, if any.
    for (const rule of DOMAIN_RULES) {
      if (rule.stripParams && domainMatches(host, rule.domain)) {
        for (const param of rule.stripParams) {
          parsed.searchParams.delete(param);
        }
        break;
      }
    }

    // Rule 6: sort remaining query params alphabetically. URLSearchParams
    // has had .sort() since Chrome 61 / 2017; we're MV3 so this is fine.
    // The sort is stable, so repeated keys (?a=1&a=2) keep relative order.
    parsed.searchParams.sort();

    return parsed.toString();
  } catch {
    return url;
  }
}

export function isInternalUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://') ||
    url.startsWith('extension://') ||
    url.startsWith('moz-extension://')
  );
}

/**
 * Create a fresh empty capture state object.
 */
export function createEmptyCapture() {
  return {
    captureId: null,
    startTime: null,
    lastActivityTime: null,
    pages: [],
    events: [],
    currentPage: null,
    currentPageStartTime: null
  };
}
