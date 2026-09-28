"""Tests for the agent_system_v4 prompt template (2026-09-28).

Origin: a 12-question demo-corpus measurement of v3 showed the citation
batched into a trailing "For more details, you can refer to ..." sentence
in 6 of 12 answers, one answer citing the same page four times, and an
"In summary" recap paragraph. v4 tightens ONLY the "When answering:" bullet
block; everything else stays byte-identical to v3 so the env knob can flip
back with zero drift.

These tests do NOT make LLM API calls -- prompt-structure and registry
checks only.
"""

import difflib

from backend.prompts.templates import PROMPTS, get_prompt

V3_TEMPLATE = PROMPTS["agent_system_v3"]["template"]
V4_TEMPLATE = PROMPTS["agent_system_v4"]["template"]


class TestAgentSystemV4Registry:
    def test_v4_exists_in_registry(self):
        assert "agent_system_v4" in PROMPTS

    def test_v4_renders_via_get_prompt(self):
        assert get_prompt("agent_system_v4") == V4_TEMPLATE

    def test_v3_entry_untouched(self):
        assert "agent_system_v3" in PROMPTS
        assert "as you use each one, not batched at the end" in V3_TEMPLATE

    def test_techniques_extend_v3(self):
        v3 = PROMPTS["agent_system_v3"]["techniques"]
        v4 = PROMPTS["agent_system_v4"]["techniques"]
        assert v4 == v3 + ["inline citation at the claim"]


class TestAgentSystemV4AnsweringStyle:
    def test_names_the_page_in_the_sentence_that_makes_the_claim(self):
        assert "name the page in the sentence that makes the claim" in V4_TEMPLATE

    def test_never_batches_citations(self):
        assert "Never batch citations into a trailing" in V4_TEMPLATE

    def test_caps_repeat_citations(self):
        assert "never cite the same page more than twice" in V4_TEMPLATE

    def test_no_closing_offer_or_recap(self):
        assert "No closing offer" in V4_TEMPLATE
        assert '"In summary"/"Thus, ..." recap paragraph' in V4_TEMPLATE

    def test_still_requires_citation_format(self):
        assert "[Page Title](URL)" in V4_TEMPLATE


class TestAgentSystemV4ExactDiffFromV3:
    """v4 must equal v3 line-for-line except the pinned bullet changes
    inside the "When answering:" block."""

    EXPECTED_UNIFIED_DIFF = [
        "--- ",
        "+++ ",
        "@@ -31,9 +31,10 @@",
        " ",
        " When answering:",
        " - Lead with the answer in the first sentence. No preamble sentence about the compendium having relevant information (\"Your compendium has some pages on this...\", \"I found some relevant results...\") -- state the answer, then support it.",
        "-- Cite compendium sources as [Page Title](URL) as you use each one, not batched at the end.",
        "+- Answer from the pages, not around them: when a claim comes from a page, name the page in the sentence that makes the claim and cite it there as [Page Title](URL) -- e.g. \"The [Classifier-Free Diffusion Guidance](URL) paper drops the classifier by ...\". Never batch citations into a trailing \"for more details, see ...\" sentence, and never cite the same page more than twice in one answer.",
        " - Label [archived], [low-confidence], and taxonomy-match results clearly per the marker guidance above; never present them as ordinary top-relevance hits.",
        " - Ground every compendium claim in content actually returned by tools. Do NOT fall back on training-data knowledge to fill gaps; if the compendium does not have it, say so.",
        "-- No closing offer (\"let me know if you'd like more detail\", \"want me to look further?\") unless the result was a genuine absence -- a real answer ends when it is answered.",
        "+- Prefer the specific over the generic: quote or paraphrase what the captured page actually says (its figures, terms, examples) over textbook summaries of the topic.",
        "+- No closing offer (\"let me know if you'd like more detail\", \"want me to look further?\") and no \"In summary\"/\"Thus, ...\" recap paragraph -- a real answer ends when it is answered. The only exception is a genuine absence, where one sentence may offer the nearest thing the compendium does have.",
        " ",
        " Out of scope: some questions are outside what you can do -- general knowledge, coding help, current events, math, anything unrelated to this person's captured browsing. Stay in character. Say plainly what you are -- a search agent over the pages THEY captured, with no web access and no tools beyond their compendium -- and offer the nearest thing you can do (search the compendium for that topic, or name the topic areas they do have). One or two sentences. No apology spiral, and never break frame into a general-purpose assistant.",
    ]

    def test_unified_diff_matches_exactly(self):
        actual = list(
            difflib.unified_diff(
                V3_TEMPLATE.splitlines(), V4_TEMPLATE.splitlines(), lineterm=""
            )
        )
        assert actual == self.EXPECTED_UNIFIED_DIFF


class TestAgentSystemV4Description:
    def test_description_documents_measurement_origin(self):
        desc = PROMPTS["agent_system_v4"]["description"]
        assert "2026-09-28" in desc
        assert "6 of 12" in desc
