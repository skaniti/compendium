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
    ("login_wall", "Login Wall", "login or sign-in wall, or a paywall with no readable content"),
    (
        "user_specific",
        "User-Specific Page",
        "account, dashboard, inbox, settings, or other page only meaningful to the signed-in user",
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
        "browse/listing page of an asset library (images, fonts, templates, icons)",
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
    ("other", "Other", "none of the above"),
)

SKIP_CATEGORY_IDS: tuple[str, ...] = tuple(c[0] for c in SKIP_CATEGORIES)
SKIP_CATEGORY_LABELS: dict[str, str] = {c[0]: c[1] for c in SKIP_CATEGORIES}


def normalize_category(value: object) -> str:
    """Return ``value`` if it is a valid category id, else ``"other"``.

    Logs a warning for non-empty values that are not valid ids.
    """
    if isinstance(value, str) and value in SKIP_CATEGORY_IDS:
        return value
    if value not in (None, "") and not (isinstance(value, str) and not value.strip()):
        logger.warning("skip gate returned out-of-enum category %r; storing 'other'", value)
    return "other"
