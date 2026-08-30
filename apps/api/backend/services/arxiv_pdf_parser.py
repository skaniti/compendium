"""arXiv PDF parser using Docling.

Converts PDF bytes to a ``ParsedPaper`` matching the ar5iv parser's
output shape so the quality gate (``arxiv_quality_gate``) and
downstream consumers (chunker, RAG indexer) work uniformly over
either source.

Used as the fallback path when ar5iv has no render or returns a
degraded one. Activated only for the rare modern paper without LaTeX
source on arXiv plus pre-2007 PDF-only deposits.

Performance: ``DocumentConverter`` is cached at module level — first
call in a process pays the model-load cost (~500 MB; downloaded on
first use, cached locally thereafter), subsequent calls are fast. The
function is synchronous (CPU-bound); async callers should wrap with
``asyncio.to_thread`` to avoid blocking the event loop.
"""

import logging
import re
from io import BytesIO
from typing import Optional

from docling.datamodel.base_models import ConversionStatus, DocumentStream
from docling.document_converter import DocumentConverter
from docling_core.types.doc.document import (
    SectionHeaderItem,
    TextItem,
    TitleItem,
)

from backend.services.arxiv_html_parser import ParsedPaper, Section

logger = logging.getLogger(__name__)


_CONVERTER: Optional[DocumentConverter] = None


_TRAILING_DIGITS_RE = re.compile(r"\d+$")


# Bibliographic-shape signals: counted per 1000 chars to decide whether
# a section named 'references' / 'bibliography' actually contains a
# bibliography (strip) or prose Docling mislabeled (keep). Observed on
# 2205.11500: Docling collapsed Methods/Results/Discussion into a single
# section named 'References'; stripping by name alone lost most of the
# paper.
_BIB_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_BIB_ETAL_RE = re.compile(r"\bet\s+al\b\.?", re.IGNORECASE)
_BIB_LOCATOR_RE = re.compile(
    r"(?:doi\.org/|arxiv:\s*\d|\bpp?\.?\s*\d|\bvol\.?\s*\d)",
    re.IGNORECASE,
)

# Calibrated 2026-05-08 against scripts/calibration/measure_refs_density.py
# output: real refs density 6.10-13.54/1000 across n=16; mislabeled-prose
# expected ~0-2/1000. 4.0 sits ~2 below the real-refs floor.
_BIB_DENSITY_THRESHOLD = 4.0

# Abstract gating thresholds. Calibrated against real abstracts in the
# 20-paper validation set (max=1739 chars, all density~0) plus the
# 2205.11500 mislabeled case (54854 chars, density=3.68 because Docling
# bundled the entire paper body under 'Abstract'). The single-cap
# approach risks false-negatives on short mislabels and false-positives
# on extreme structured abstracts; the two-cap + density disambiguator
# generalizes better.
_ABSTRACT_SHORT_CAP = 4000      # below this = clearly a real abstract
_ABSTRACT_LONG_CAP = 20000      # above this = clearly mislabeled body
_ABSTRACT_DENSITY_THRESHOLD = 1.0  # mid-range disambiguator


def _refs_density(text: str) -> float:
    """Bibliographic markers per 1000 chars."""
    if not text:
        return 0.0
    n = (
        len(_BIB_YEAR_RE.findall(text))
        + len(_BIB_ETAL_RE.findall(text))
        + len(_BIB_LOCATOR_RE.findall(text))
    )
    return n * 1000.0 / len(text)


def _looks_like_real_references(text: str) -> bool:
    """True iff section text matches a bibliography content shape.

    Sections shorter than 400 chars default to True (preserves the
    historical strip-by-name behavior for tiny tails where density
    estimates are unreliable).
    """
    if len(text) < 400:
        return True
    return _refs_density(text) >= _BIB_DENSITY_THRESHOLD


def _looks_like_real_abstract(text: str) -> bool:
    """True iff section text plausibly is an abstract (vs Docling-mislabeled body).

    Three-tier gate:
      - length < 4000: clearly short enough to be a real abstract
      - length > 20000: clearly too long to be an abstract -- mislabeled
      - mid-range: real abstracts are nearly devoid of refs markers
        (typically density ~0); mislabeled body content runs higher
        (e.g., 2205.11500's mislabel scored density 3.68). Density < 1.0
        keeps as real abstract; >=1.0 treats as mislabeled body.
    """
    n = len(text)
    if n < _ABSTRACT_SHORT_CAP:
        return True
    if n > _ABSTRACT_LONG_CAP:
        return False
    return _refs_density(text) < _ABSTRACT_DENSITY_THRESHOLD


def _should_drop_section(name: str, text: str) -> bool:
    """True if this section should be excluded from body_text.

    Mirrors the ar5iv path's exclusions: `<div class='ltx_abstract'>`
    is dropped because abstract is already in `ArxivPaper.title`/metadata,
    and `ltx_bibliography` is dropped because `_SECTION_LEVELS` doesn't
    map it. The PDF path matches by section name (case-insensitive,
    trailing-digit typesetting artifacts like 'References2' normalized
    out).

    Both abstract and references/bibliography use content-shape gates
    on top of the name match — Docling sometimes mislabels real body
    content under either name (observed: 2205.11500's whole paper body
    was bundled under 'Abstract'). The gate keeps a section that
    doesn't match the expected shape; reverts to the historical
    strip-by-name behavior when content matches.
    """
    n = _TRAILING_DIGITS_RE.sub("", name.strip().lower()).strip()
    if not n:
        return False
    if n == "abstract":
        return _looks_like_real_abstract(text)
    if n in ("references", "bibliography"):
        return _looks_like_real_references(text)
    return False


# Patterns that indicate a section header is a "real" paper section.
# Used by the title-page filter to skip paper-title-as-section-header
# and author-name pseudo-sections that Docling emits for the title page
# of some PDFs (e.g., 2206.00364: 'Elucidating the Design Space of
# Diffusion-Based Generative Models' as a top-level section).
_REAL_SECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\d+(?:\.\d+)*[\s\.]"),   # "1 X", "1. X", "1.2 X"
    re.compile(r"^[A-Z]\.\d"),              # "A.1", "B.2"
    re.compile(r"^[A-Z]\s+[A-Z][a-z]"),     # "A Additional results"
)

# First-word matches for "real" section headers (after stripping
# trailing punctuation, lowercase). Covers common section words across
# scientific papers: methodology, results, discussion, etc.
_REAL_SECTION_FIRST_WORDS: frozenset[str] = frozenset({
    "abstract",                  # 2205.11500: Docling-mislabeled body
                                 # surfaces under 'Abstract'; once
                                 # _should_drop_section keeps it (long
                                 # length), the title-page filter must
                                 # also recognize it as real
    "introduction", "background", "preliminaries", "notation",
    "method", "methods", "methodology", "approach", "approaches",
    "results", "result", "experiments", "experiment", "experimental",
    "evaluation", "evaluations", "analysis", "analyses",
    "discussion", "discussions", "conclusion", "conclusions",
    "appendix", "appendices", "supplementary", "supplement",
    "acknowledgments", "acknowledgements", "ackowledgments",
    "summary", "future", "limitations", "limitation",
    "related",                  # "Related Work"
    "broader", "ethics", "reproducibility", "impact",
    "captions",                  # 2205.11500 has body content under "Captions"
    "objectives", "objective", "rationale",  # 2312.10840 sections
    "literature",                # "Literature Review" in 2312.10840
    "data",                      # "Data Collection", "Data Analysis"
    "fundamentals", "theory",
    "author",                    # "Author Contributions" / 'Author2contributions2'
})


_LEADING_ALPHA_RE = re.compile(r"^([a-z]+)")


def _looks_like_real_section_header(name: str) -> bool:
    """True if this name looks like a real paper section header.

    Used to filter out paper-title-as-header and author-name pseudo-
    sections that Docling sometimes emits for the title page. A section
    is "real" if either:
    - Name matches a numbered/lettered section pattern (`1 X`, `A.1 X`, `A Additional results`)
    - Leading alphabetic run (lowercased) matches a recognized section keyword
      (Introduction, Methods, ...). Using only the leading alpha run lets us
      transparently match typesetting-glyph variants like 'Acknowledgements2'
      / 'Author2contributions2' where digits replaced whitespace.

    Caller should apply this only to sections at the START of the document
    (before any real section has been seen) — once we've crossed into the
    paper body, all subsequent sections pass through normally.
    """
    n = name.strip()
    if not n:
        return False
    for pat in _REAL_SECTION_PATTERNS:
        if pat.match(n):
            return True
    m = _LEADING_ALPHA_RE.match(n.lower())
    if m is None:
        return False
    return m.group(1) in _REAL_SECTION_FIRST_WORDS


# Figure / Table caption pattern at the start of a TextItem. Catches
# "Figure 1: Description...", "Table 12 . ...", etc. — the canonical
# caption shape Docling emits for figure/table caption blocks. Prose
# like "Figure 1 shows that..." is preserved (no trailing : or .).
_CAPTION_RE = re.compile(r"^(Figure|Table)\s+\d+\s*[:\.]")


def _is_caption_text(text: str) -> bool:
    """True if this TextItem looks like a figure/table caption.

    Matched at the start of the stripped text so prose discussing a
    figure (e.g., 'Figure 1 shows that ...') stays in the body — only
    paragraphs that ARE the caption block are dropped.
    """
    return bool(_CAPTION_RE.match(text.strip()))


def _get_converter() -> DocumentConverter:
    """Lazy module-level singleton; first call loads the Docling models."""
    global _CONVERTER
    if _CONVERTER is None:
        _CONVERTER = DocumentConverter()
    return _CONVERTER


def parse_pdf(pdf_bytes: bytes) -> ParsedPaper:
    """Parse PDF bytes into a ``ParsedPaper``.

    Returns an empty ``ParsedPaper`` when ``pdf_bytes`` is empty or
    Docling fails to convert (caller decides whether to fall through
    to abstract-only).
    """
    if not pdf_bytes:
        return ParsedPaper(sections=[], body_text="", error_count=0)

    source = DocumentStream(name="paper.pdf", stream=BytesIO(pdf_bytes))
    converter = _get_converter()

    try:
        result = converter.convert(source)
    except Exception as exc:
        logger.warning("docling conversion raised: %s", exc)
        return ParsedPaper(
            sections=[],
            body_text="",
            error_count=1,
            error_locations=[f"docling exception: {type(exc).__name__}"],
        )

    if result.status != ConversionStatus.SUCCESS:
        errors = list(result.errors or [])
        return ParsedPaper(
            sections=[],
            body_text="",
            error_count=len(errors) or 1,
            error_locations=[str(e) for e in errors] or [f"status={result.status}"],
        )

    sections: list[Section] = []
    buffer_name = ""
    buffer_level = 1
    buffer_parts: list[str] = []
    seen_first_real = False  # mutated via nonlocal in _flush

    def _flush(current_sections: list[Section]) -> None:
        nonlocal seen_first_real
        if not buffer_parts:
            return
        text = "\n\n".join(buffer_parts)
        if _should_drop_section(buffer_name, text):
            return
        # Title-page filter: until we've seen our first real-looking
        # section, drop anything that doesn't look like one. Catches
        # paper-title-as-header (2206.00364), author-name pseudo-
        # sections (2312.10840), and empty-name title-page content.
        if not seen_first_real:
            if not _looks_like_real_section_header(buffer_name):
                return
            seen_first_real = True
        if text.strip():
            current_sections.append(
                Section(name=buffer_name, level=buffer_level, text=text)
            )

    for item, hierarchy_level in result.document.iterate_items():
        if isinstance(item, SectionHeaderItem):
            _flush(sections)
            buffer_name = (item.text or "").strip()
            buffer_level = max(1, int(hierarchy_level) if hierarchy_level else 1)
            buffer_parts = []
        elif isinstance(item, TitleItem):
            # Title is metadata (already in ArxivPaper.title) — skip
            continue
        elif isinstance(item, TextItem):
            text = (item.text or "").strip()
            # Drop figure/table caption paragraphs at the TextItem level
            # so they don't pollute the body. Prose discussing a figure
            # ("Figure 1 shows that ...") doesn't match the pattern and
            # is preserved.
            if text and not _is_caption_text(text):
                buffer_parts.append(text)

    _flush(sections)
    body_text = "\n\n".join(s.text for s in sections)

    return ParsedPaper(
        sections=sections,
        body_text=body_text,
        error_count=0,
        error_locations=[],
    )
