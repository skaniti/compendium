"""Tests for the arXiv PDF parser.

Validates ``parse_pdf`` against the SimCSE PDF fixture. Note: the first
test run in a fresh environment downloads Docling's layout/OCR models
(roughly 500 MB) and is slow. Subsequent runs reuse the cached models.
"""

from pathlib import Path

from backend.services.arxiv_pdf_parser import (
    _ABSTRACT_LONG_CAP,
    _ABSTRACT_SHORT_CAP,
    _BIB_DENSITY_THRESHOLD,
    _looks_like_real_abstract,
    _looks_like_real_references,
    _refs_density,
    _should_drop_section,
    parse_pdf,
)


FIXTURES = Path(__file__).parent / "fixtures" / "arxiv"


class TestParsePdf:
    def test_empty_bytes_returns_empty(self):
        parsed = parse_pdf(b"")
        assert parsed.sections == []
        assert parsed.body_text == ""
        assert parsed.error_count == 0

    def test_simcse_extraction(self):
        # Slow on first run (Docling model download); fast after
        pdf_bytes = (FIXTURES / "2104.08821.pdf").read_bytes()
        parsed = parse_pdf(pdf_bytes)
        assert len(parsed.sections) > 0
        assert len(parsed.body_text) > 10_000
        # Successful conversion should report zero parser-level errors
        assert parsed.error_count == 0


# Sample reference-shaped text — high density of years, et al., DOIs/pp.
REAL_REFS_SAMPLE = """\
Brock, A., Donahue, J., & Simonyan, K. (2018). Large scale GAN training for high fidelity natural image synthesis. arXiv:1809.11096.
Karras, T., Aila, T., Laine, S., & Lehtinen, J. (2017). Progressive growing of GANs for improved quality, stability, and variation. arXiv:1710.10196.
Goodfellow, I., et al. (2014). Generative adversarial nets. NeurIPS, pp. 2672-2680.
Ho, J., et al. (2020). Denoising diffusion probabilistic models. NeurIPS, vol. 33.
Sohl-Dickstein, J., et al. (2015). Deep unsupervised learning using nonequilibrium thermodynamics. ICML, pp. 2256-2265.
Song, Y., & Ermon, S. (2019). Generative modeling by estimating gradients of the data distribution. NeurIPS.
"""

# Sample prose — Methods/Results/Discussion content with sparse citations,
# representative of the 2205.11500 mislabel case.
MISLABELED_PROSE_SAMPLE = """\
Numerical simulations were performed using Mathematica's NDSOLVE engine, which uses the method of lines.
Spatial derivatives are approximated using a Tensor Product Grid Method. The step size for the time derivative
is chosen adaptively. We used a 101x101 grid size, and the maximum time was 200000. We used periodic boundary
conditions, which is unusual, since most previous studies have used zero-flux boundary conditions. de Witt
showed, however, that unless the dx is very small, which is problematic for stability, zero-flux boundary
conditions introduce significant artifacts to the pattern. Moreover, in viewing cuttlefish dynamic patterns,
it often seems that waves that pass through one edge of the animal reappear on the opposite edge, so periodic
boundary conditions may be more appropriate. The one-dimensional Fourier transform centers around sinusoids,
and tries to find the frequency context of signals.
"""


class TestRefsDensity:
    def test_counts_year_etal_locator_markers(self):
        # 6 years + 3 et al. + (arxiv: x2 + pp x2 + vol x1) = 6 + 3 + 5 = 14 markers
        # in roughly 600 chars -> density well above the threshold
        density = _refs_density(REAL_REFS_SAMPLE)
        assert density > _BIB_DENSITY_THRESHOLD

    def test_prose_density_is_low(self):
        # The 2205.11500 mislabeled section has no parenthesized years
        # and no bibliographic locators; density should be ~0
        density = _refs_density(MISLABELED_PROSE_SAMPLE)
        assert density < _BIB_DENSITY_THRESHOLD

    def test_empty_text_returns_zero(self):
        assert _refs_density("") == 0.0


class TestLooksLikeRealReferences:
    def test_short_text_defaults_to_real(self):
        # Below 400 chars, density estimate is unreliable;
        # default to historical strip-by-name behavior.
        assert _looks_like_real_references("short")

    def test_high_density_is_real(self):
        # Repeat to push above 400 chars while keeping markers dense
        assert _looks_like_real_references(REAL_REFS_SAMPLE * 2)

    def test_low_density_prose_is_not_real(self):
        # Repeat to push above 400 chars; density stays low
        assert not _looks_like_real_references(MISLABELED_PROSE_SAMPLE * 2)


class TestLooksLikeRealAbstract:
    def test_short_abstract_is_real(self):
        # Below the short cap — a typical 1500-char abstract
        assert _looks_like_real_abstract("x" * 1500)
        assert _looks_like_real_abstract("x" * (_ABSTRACT_SHORT_CAP - 1))

    def test_very_long_abstract_is_mislabeled(self):
        # Above the long cap — clearly Docling-bundled body content
        assert not _looks_like_real_abstract("x" * (_ABSTRACT_LONG_CAP + 1))
        assert not _looks_like_real_abstract("x" * 60000)  # 2205.11500-ish

    def test_mid_range_low_density_is_real_abstract(self):
        # Mid-range (4000-20000) with low refs-marker density: extreme
        # structured abstract (e.g., Cochrane-style). Stays stripped.
        long_prose_no_citations = (
            "Background: this paper investigates the question. "
            "Methods: we used standard techniques. "
            "Results: we found things. "
            "Conclusions: more work is needed. "
        ) * 100  # ~12,000 chars; no years/et al/DOIs
        assert _looks_like_real_abstract(long_prose_no_citations)

    def test_mid_range_with_citations_is_mislabeled(self):
        # Mid-range with refs-marker density >= 1.0: looks like body
        # content with inline citations, not a real abstract.
        # Repeat MISLABELED_PROSE_SAMPLE has years like (Fornberg, 1998).
        text = (
            "Numerical simulations were performed using NDSOLVE (Fornberg, 1998). "
            "We used a 101x101 grid (de Witt, 1996). "
            "The Brock et al. method was applied (Smith, 2020). "
        ) * 50  # ~10,000 chars with high density of years/et al
        # Should be in mid-range and density >= 1.0
        assert _ABSTRACT_SHORT_CAP < len(text) < _ABSTRACT_LONG_CAP
        assert not _looks_like_real_abstract(text)


class TestShouldDropSection:
    def test_short_abstract_drops(self):
        assert _should_drop_section("Abstract", MISLABELED_PROSE_SAMPLE)
        assert _should_drop_section("Abstract", "")

    def test_long_abstract_kept_as_mislabeled_body(self):
        # 2205.11500 case: 54854-char "Abstract" containing the paper body
        assert not _should_drop_section("Abstract", "x" * 60000)

    def test_references_with_real_bib_drops(self):
        assert _should_drop_section("References", REAL_REFS_SAMPLE * 2)

    def test_references_with_mislabeled_prose_keeps(self):
        # The 2205.11500 case: section name is 'References' but content
        # is Methods/Results/Discussion prose — must be kept.
        assert not _should_drop_section("References", MISLABELED_PROSE_SAMPLE * 2)

    def test_bibliography_treated_same_as_references(self):
        assert _should_drop_section("Bibliography", REAL_REFS_SAMPLE * 2)
        assert not _should_drop_section("Bibliography", MISLABELED_PROSE_SAMPLE * 2)

    def test_methods_never_drops(self):
        # Section name doesn't match any excluded pattern
        assert not _should_drop_section("Methods", REAL_REFS_SAMPLE * 2)

    def test_trailing_digit_typesetting_artifact_normalized(self):
        # Older PDFs surface 'References2' / 'Methods2' from glyph
        # collision; the trailing-digit strip lets these match the
        # canonical name.
        assert _should_drop_section("References2", REAL_REFS_SAMPLE * 2)
        assert _should_drop_section("Abstract2", "")

    def test_empty_section_name_does_not_drop(self):
        # Empty / pure-digit names are handled by the title-page filter,
        # not this one.
        assert not _should_drop_section("", REAL_REFS_SAMPLE)
        assert not _should_drop_section("123", REAL_REFS_SAMPLE)
