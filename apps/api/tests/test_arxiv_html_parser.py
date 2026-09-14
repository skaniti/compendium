"""Tests for the ar5iv HTML parser.

Validates ``parse_ar5iv`` against frozen ar5iv renders. Fixtures live at
``tests/fixtures/arxiv/{paper_id}.html`` and were captured 2026-05-03 from
``https://ar5iv.labs.arxiv.org/html/{paper_id}``. Sizes match the round-2
probe in the 2026-05-03 arxiv-full-paper-extraction plan (private)
(SimCSE 600 KB, PaLM 2 917 KB).
"""

from pathlib import Path

from backend.services.arxiv_html_parser import parse_ar5iv


FIXTURES = Path(__file__).parent / "fixtures" / "arxiv"


def _load(paper_id: str) -> str:
    return (FIXTURES / f"{paper_id}.html").read_text(encoding="utf-8")


class TestParseAr5iv:
    def test_simcse_basic_extraction(self):
        parsed = parse_ar5iv(_load("2104.08821"))
        assert len(parsed.sections) > 0
        assert len(parsed.body_text) > 10_000
        assert parsed.error_count == 0

    def test_palm2_counts_render_errors(self):
        # Plan probe noted "1 error" semantically (one Devanagari macro broke
        # in the Transliteration appendix), but the broken macro renders as
        # 6 separate ltx_ERROR DOM spans. The quality gate operates on DOM
        # count (visible to RAG), so 6 is the correct invariant for this
        # frozen fixture. Density 6 / ~600 KB body still well under any
        # plausible threshold.
        parsed = parse_ar5iv(_load("2305.10403"))
        assert parsed.error_count == 6
        assert all("Transliterat" in loc for loc in parsed.error_locations)


class TestArxivQualityGate:
    @staticmethod
    def _parsed(*, n_sections: int, body_chars: int, errors: int):
        from backend.services.arxiv_html_parser import ParsedPaper, Section

        sections = [
            Section(name=f"S{i}", level=1, text="x" * (body_chars // max(1, n_sections)))
            for i in range(n_sections)
        ]
        # body_text is what the gate measures; size it exactly.
        body_text = "x" * body_chars
        return ParsedPaper(
            sections=sections,
            body_text=body_text,
            error_count=errors,
            error_locations=[],
        )

    def test_falls_through_on_zero_sections(self):
        from backend.services.arxiv_html_parser import arxiv_quality_gate

        parsed = self._parsed(n_sections=0, body_chars=0, errors=0)
        assert arxiv_quality_gate(parsed) == "fall_through"

    def test_accepts_clean_render(self):
        from backend.services.arxiv_html_parser import arxiv_quality_gate

        # 5 sections, 5 KB body, 0 errors -> density 0, well under threshold
        parsed = self._parsed(n_sections=5, body_chars=5000, errors=0)
        assert arxiv_quality_gate(parsed) == "accept"

    def test_falls_through_on_dense_errors(self):
        from backend.services.arxiv_html_parser import arxiv_quality_gate

        # 1 section, 1000 chars, 10 errors -> density = 10 / max(1, 1.0) = 10.0,
        # which exceeds default threshold 5.0. (For bodies under 1000 chars
        # the divisor is clamped to 1, so the gate reports errors/1 instead
        # of errors/(chars/1000) — protects against tiny-body division noise.)
        parsed = self._parsed(n_sections=1, body_chars=1000, errors=10)
        assert arxiv_quality_gate(parsed) == "fall_through"

    def test_accepts_at_threshold_boundary(self):
        from backend.services.arxiv_html_parser import arxiv_quality_gate

        # 1 section, 1000 chars, 5 errors -> density = 5 / 1.0 = 5.0,
        # NOT strictly greater than 5.0, so accept (boundary semantics)
        parsed = self._parsed(n_sections=1, body_chars=1000, errors=5)
        assert arxiv_quality_gate(parsed) == "accept"

    def test_palm2_real_density_accepts(self):
        # Real-fixture sanity check: PaLM 2 (6 errors, ~150 KB body) should
        # accept under the default threshold — its errors are appendix-local
        # and not load-bearing for RAG.
        from backend.services.arxiv_html_parser import arxiv_quality_gate

        parsed = parse_ar5iv(_load("2305.10403"))
        assert arxiv_quality_gate(parsed) == "accept"

    def test_custom_threshold_overrides_default(self):
        from backend.services.arxiv_html_parser import arxiv_quality_gate

        # density 10 with threshold 20 -> accept (would fail default)
        parsed = self._parsed(n_sections=1, body_chars=1000, errors=10)
        assert arxiv_quality_gate(parsed, error_density_threshold=20.0) == "accept"
        assert arxiv_quality_gate(parsed) == "fall_through"  # default is stricter
