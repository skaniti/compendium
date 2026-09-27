"""Tests for the agent_system_v3 prompt template (Task 7d, 2026-09-26).

Backlog origin: a prod-mode demo pass on a plain corpus question got a
hedged non-answer ("let me check that for you...") as the FINAL turn --
the model narrated an intent to search instead of calling the tool, and
the ReAct loop (agent.py query / query_stream) treats a no-tool-call
message as done. v3 targets that failure mode with two additive changes
over v2: (a) an explicit "never announce, just call the tool" rule under
Strategy, and (b) tightened "When answering" style rules (lead with the
answer, cite as you go, no compendium-has-relevant-info preamble, no
gratuitous closing offer). Everything else -- the product self-awareness
framing, tool/marker/citation discipline, out-of-scope handling -- stays
byte-identical to v2 so the env knob can flip back with zero drift.

These tests do NOT make LLM API calls -- prompt-structure and registry
checks only.
"""

import difflib

from backend.prompts.templates import PROMPTS, get_prompt

V2_TEMPLATE = PROMPTS["agent_system_v2"]["template"]
V3_TEMPLATE = PROMPTS["agent_system_v3"]["template"]


class TestAgentSystemV3Registry:
    def test_v3_exists_in_registry(self):
        assert "agent_system_v3" in PROMPTS

    def test_v3_renders_via_get_prompt(self):
        assert get_prompt("agent_system_v3") == V3_TEMPLATE

    def test_v2_entry_untouched(self):
        """v3 is additive -- the env knob can still flip back to v2."""
        assert "agent_system_v2" in PROMPTS
        assert "never announce" not in V2_TEMPLATE.lower()
        assert "Be concise. Lead with the answer, then supporting detail." in V2_TEMPLATE


class TestAgentSystemV3NeverAnnounceRule:
    def test_forbids_narrating_a_search_or_check(self):
        lowered = V3_TEMPLATE.lower()
        assert "never announce a search" in lowered

    def test_says_the_only_way_to_look_is_to_call_the_tool(self):
        lowered = V3_TEMPLATE.lower()
        assert "call the tool" in lowered

    def test_says_a_no_tool_call_answer_is_final(self):
        lowered = V3_TEMPLATE.lower()
        assert "is final" in lowered
        assert "greeting" in lowered
        assert "scope" in lowered


class TestAgentSystemV3AnsweringStyle:
    def test_leads_with_the_answer(self):
        assert "lead with the answer" in V3_TEMPLATE.lower()

    def test_forbids_relevant_information_preamble(self):
        lowered = V3_TEMPLATE.lower()
        assert "preamble" in lowered
        assert "relevant information" in lowered

    def test_forbids_gratuitous_closing_offer_unless_genuine_absence(self):
        lowered = V3_TEMPLATE.lower()
        assert "closing offer" in lowered
        assert "genuine absence" in lowered

    def test_still_requires_citations(self):
        assert "[Page Title](URL)" in V3_TEMPLATE


class TestAgentSystemV3ExactDiffFromV2:
    """v3 must equal v2 line-for-line except an EXACT, pinned set of
    inserted/replaced lines (fix round 1, review-7d.md W1: the prior
    prefix/suffix/substring-presence assertion would still pass if an
    extra line were inserted anywhere in the Strategy..Out-of-scope
    region other than the intended six changed lines -- this pins the
    unified diff itself so any other drift fails).
    """

    # Generated via difflib.unified_diff(v2_lines, v3_lines, lineterm="")
    # against the templates as shipped -- embedded verbatim, not
    # recomputed, so this test actually catches drift instead of trivially
    # re-deriving its own expectation from the current template.
    EXPECTED_UNIFIED_DIFF = [
        "--- ",
        "+++ ",
        "@@ -22,6 +22,7 @@",
        " - get_page_detail: full content for a single page, by id (search results and cluster listings both carry ids). Use when a chunk preview is insufficient to answer.",
        " ",
        " Strategy (stop calling tools as soon as you can answer):",
        "+Never announce a search or a check in prose -- \"let me look\", \"one moment\", \"I'll search\" and the like are forbidden as a final turn. The only way to look something up is to call the tool in the SAME turn you would otherwise have narrated it. An answer that makes no tool call is sent to the user exactly as written, so it is final: it must already be grounded in a prior tool result, or be an in-character greeting or out-of-scope/scope reply -- never a promise to look later.",
        ' 1. Meta questions about the compendium or the graph ITSELF -- "what am I looking at", "what does this graph show", "what is in here", "what topics do I have", "how many clusters are there" -- are answered with list_clusters (ONCE), not search_compendium. Describe their actual topic areas and counts; do not search for the words of the question.',
        " 2. Otherwise, call search_compendium ONCE with the user's query.",
        " 3. Read the result markers (above) and synthesize the answer. Do NOT call additional tools unless the question genuinely requires content from a page you do not yet have, or the result was a taxonomy match needing follow-up.",
        "@@ -29,9 +30,10 @@",
        " 5. If the user explicitly asks to search everything or archived content, or says they know it is there, call search_compendium with include_archived=true.",
        " ",
        " When answering:",
        "-- Cite compendium sources as [Page Title](URL).",
        "+- Lead with the answer in the first sentence. No preamble sentence about the compendium having relevant information (\"Your compendium has some pages on this...\", \"I found some relevant results...\") -- state the answer, then support it.",
        "+- Cite compendium sources as [Page Title](URL) as you use each one, not batched at the end.",
        " - Label [archived], [low-confidence], and taxonomy-match results clearly per the marker guidance above; never present them as ordinary top-relevance hits.",
        " - Ground every compendium claim in content actually returned by tools. Do NOT fall back on training-data knowledge to fill gaps; if the compendium does not have it, say so.",
        "-- Be concise. Lead with the answer, then supporting detail.",
        "+- No closing offer (\"let me know if you'd like more detail\", \"want me to look further?\") unless the result was a genuine absence -- a real answer ends when it is answered.",
        " ",
        " Out of scope: some questions are outside what you can do -- general knowledge, coding help, current events, math, anything unrelated to this person's captured browsing. Stay in character. Say plainly what you are -- a search agent over the pages THEY captured, with no web access and no tools beyond their compendium -- and offer the nearest thing you can do (search the compendium for that topic, or name the topic areas they do have). One or two sentences. No apology spiral, and never break frame into a general-purpose assistant.",
    ]

    def test_unified_diff_matches_exactly(self):
        v2_lines = V2_TEMPLATE.splitlines()
        v3_lines = V3_TEMPLATE.splitlines()
        actual = list(difflib.unified_diff(v2_lines, v3_lines, lineterm=""))
        assert actual == self.EXPECTED_UNIFIED_DIFF


class TestAgentSystemV3Description:
    def test_description_documents_2026_09_26_origin(self):
        desc = PROMPTS["agent_system_v3"]["description"]
        assert "2026-09-26" in desc
