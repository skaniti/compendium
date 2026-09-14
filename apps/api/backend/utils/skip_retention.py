"""Retention policy for skip-gate-archived pages (privacy carve-out).

Implements the sensitive-content carve-out from the retain-skipped-pages
design (the 2026-04-26 retain-skipped-pages-audit-log plan, private):
skipped pages are retained as audit rows (url/title/domain/verdict survive),
but when the skip looks sensitivity-driven the CONTENT must not be retained --
no page_content link, no content_summary, extracted_text nulled.

The validated v2.x gate does not emit a threat category (its tool schema has
only a free-text reason), so v1 matches conservatively on the reason text.
``threat_category`` is accepted for forward-compatibility with a future gate
version (v2_4+) that classifies explicitly; when a category is present it
takes precedence over the heuristic.

Also home to :func:`build_row_snippet`, the shared boilerplate-aware snippet
builder mandated by Finding 1 of the same plan: any code deriving a snippet
from STORED page rows must not let the passive-capture boilerplate
``content_summary`` ("Page browsed outside API tool scope for N seconds")
mask real extracted text. (The live Stage-1 gate path is immune by
construction -- it reads freshly-fetched content dicts, verified 2026-07-01 --
but audit/reprocess scripts read DB rows and need this helper.)
"""

from __future__ import annotations

import re

# Categories whose snippets are PII by definition (plan carve-out table).
_SENSITIVE_THREAT_CATEGORIES = {"sensitive_content", "borderline_sensitive"}

# Conservative heuristic over the gate's free-text reason. False positives
# cost a snippet on an already-skipped page; false negatives retain PII --
# so the pattern list leans wide.
_SENSITIVE_REASON_RE = re.compile(
    r"bank|financ|medical|health|patient|password|credential"
    r"|private (?:message|conversation|account|profile)"
    r"|personal (?:data|account|dashboard|information)"
    r"|sensitive|confidential|inbox|e-?mail account"
    r"|account (?:settings|dashboard)|logged-?in",
    re.IGNORECASE,
)

_SNIPPET_KEYS = ("content_summary", "content_level_summary", "content_extracted_text")
_SNIPPET_MAX_LEN = 500

# Mirrors clustering_service._BOILERPLATE_SUMMARY_RE; imported lazily in
# build_row_snippet to avoid a utils->services import cycle.


def should_redact_snippet(
    reason: str | None,
    threat_category: str | None = None,
) -> bool:
    """True when a skipped page's content must not be retained.

    Category (future gate versions) wins over the reason-text heuristic.
    """
    if threat_category is not None:
        return threat_category in _SENSITIVE_THREAT_CATEGORIES
    if not reason:
        return False
    return bool(_SENSITIVE_REASON_RE.search(reason))


def build_row_snippet(page: dict, max_len: int = _SNIPPET_MAX_LEN) -> str:
    """Boilerplate-aware snippet from a stored page row (Finding 1 fix).

    Walks the legacy priority chain but refuses to return a *summary* field
    whose value is the passive-capture boilerplate -- falling through to the
    real extracted text instead.
    """
    from backend.services.clustering_service import _BOILERPLATE_SUMMARY_RE

    for key in _SNIPPET_KEYS:
        val = page.get(key)
        if not val:
            continue
        val = str(val)
        if key.endswith("summary") and _BOILERPLATE_SUMMARY_RE.match(val):
            continue
        return val[:max_len]
    return ""
