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


class TestAgentSystemV3StructuralDiffFromV2:
    """v3 must be byte-identical to v2 everywhere except the Strategy
    never-announce addition and the rewritten 'When answering' bullets --
    pins that boundary so v3 cannot silently drift from v2 elsewhere.
    """

    def test_identical_before_strategy_section(self):
        header = "Strategy (stop calling tools as soon as you can answer):"
        v2_pre = V2_TEMPLATE.split(header, 1)[0]
        v3_pre = V3_TEMPLATE.split(header, 1)[0]
        assert v2_pre == v3_pre

    def test_identical_from_out_of_scope_onward(self):
        footer = "Out of scope:"
        v2_post = V2_TEMPLATE.split(footer, 1)[1]
        v3_post = V3_TEMPLATE.split(footer, 1)[1]
        assert v2_post == v3_post

    def test_numbered_strategy_steps_unchanged(self):
        for step_text in (
            '1. Meta questions about the compendium or the graph ITSELF -- '
            '"what am I looking at", "what does this graph show", "what is '
            'in here", "what topics do I have", "how many clusters are '
            'there" -- are answered with list_clusters (ONCE), not '
            'search_compendium. Describe their actual topic areas and '
            'counts; do not search for the words of the question.',
            "2. Otherwise, call search_compendium ONCE with the user's query.",
            "3. Read the result markers (above) and synthesize the answer. "
            "Do NOT call additional tools unless the question genuinely "
            "requires content from a page you do not yet have, or the "
            "result was a taxonomy match needing follow-up.",
            '4. On a genuine absence (a diagnosed "No relevant matches" '
            "with no taxonomy or low-confidence hit): optionally call "
            "list_clusters ONCE to name the nearest topic areas the "
            "user's compendium DOES cover, optionally reformulate the "
            "query ONCE into a more specific multi-word phrasing and "
            "search again, and only then tell the user the compendium has "
            "nothing on the topic. You may then offer 1-2 authoritative "
            "external starting points (e.g. a Wikipedia URL), clearly "
            "labeled as external.",
            "5. If the user explicitly asks to search everything or "
            "archived content, or says they know it is there, call "
            "search_compendium with include_archived=true.",
        ):
            assert step_text in V2_TEMPLATE
            assert step_text in V3_TEMPLATE

    def test_marker_and_grounding_bullets_unchanged(self):
        for bullet in (
            "Label [archived], [low-confidence], and taxonomy-match "
            "results clearly per the marker guidance above; never present "
            "them as ordinary top-relevance hits.",
            "Ground every compendium claim in content actually returned "
            "by tools. Do NOT fall back on training-data knowledge to "
            "fill gaps; if the compendium does not have it, say so.",
        ):
            assert bullet in V2_TEMPLATE
            assert bullet in V3_TEMPLATE

    def test_when_answering_lead_bullet_actually_changed(self):
        """Sanity check the diff isn't a no-op: v2's old lead bullet must
        be gone from v3."""
        old_bullet = "Be concise. Lead with the answer, then supporting detail."
        assert old_bullet in V2_TEMPLATE
        assert old_bullet not in V3_TEMPLATE


class TestAgentSystemV3Description:
    def test_description_documents_2026_09_26_origin(self):
        desc = PROMPTS["agent_system_v3"]["description"]
        assert "2026-09-26" in desc
