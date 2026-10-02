"""Standardized skip-gate categories.

One module owns the list. The skip gate's ``skip_page`` tool constrains the
model to these ids; an out-of-enum answer is stored as ``other``. The ids are
mirrored in the ``pages_skip_category_check`` constraint (migration 046).
"""

import logging

logger = logging.getLogger(__name__)

# (id, label, one-line description) -- the description lines up with the
# skip_gate_v2_3 prompt's SKIP list.
SKIP_CATEGORIES: tuple[tuple[str, str, str], ...] = (
    ("login_wall", "Login Wall", "login wall, auth page, sign-in redirect"),
    (
        "user_specific",
        "User-Specific Page",
        "user-specific page (profile, account, dashboard, settings, inbox)",
    ),
    (
        "store_listing",
        "Store / Pricing Page",
        "marketplace, product, store, listing, or pricing page",
    ),
    ("homepage_index", "Homepage / Index", "site homepage or index/landing page of links"),
    ("search_results", "Search Results", "search results page"),
    (
        "asset_library",
        "Asset Library Listing",
        (
            "asset library browse / category / index page listing multiple items "
            "(icons, fonts, vectors, 3D models, templates)"
        ),
    ),
    (
        "entertainment_video",
        "Entertainment Video",
        "entertainment video (music, clips, vlog, streaming) with no learning content",
    ),
    ("disambiguation", "Disambiguation Page", "disambiguation page listing other articles"),
    ("error_page", "Error Page", "error page (404, 500, access denied, cookie-consent redirect)"),
    (
        "content_free_stub",
        "Content-Free Stub",
        "stub or placeholder page with no substantive content",
    ),
    ("local_file", "Local File", "local file or file:// page"),
    (
        "web_app",
        "Web App / Tool",
        (
            "interactive web app or tool page (maps, directions, forms, editors, "
            "status pages) with no article content"
        ),
    ),
    ("other", "Other", "none of the above"),
)

SKIP_CATEGORY_IDS: tuple[str, ...] = tuple(c[0] for c in SKIP_CATEGORIES)
SKIP_CATEGORY_LABELS: dict[str, str] = {c[0]: c[1] for c in SKIP_CATEGORIES}


_LABEL_TO_ID = {label.lower(): cid for cid, label, _ in SKIP_CATEGORIES}


def normalize_category(value: object) -> str:
    """Return the category id for ``value``, else ``"other"``.

    Accepts an id or a label, case-insensitive, surrounding whitespace ignored.
    Logs a warning for non-empty values that match neither.
    """
    if isinstance(value, str):
        v = value.strip().lower()
        if v in SKIP_CATEGORY_IDS:
            return v
        if v in _LABEL_TO_ID:
            return _LABEL_TO_ID[v]
        if not v:
            return "other"
    elif value is None:
        return "other"
    logger.warning("skip gate returned out-of-enum category %r; storing 'other'", value)
    return "other"
