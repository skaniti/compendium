"""Tests for prompt templates.

Milestone 4: Validate prompt template formatting, metadata, coverage of
required techniques, and behavior with edge-case inputs.

These tests do NOT make LLM API calls — they verify prompt structure only.
"""

import json
import re
import pytest
from pathlib import Path

from backend.prompts.templates import (
    PROMPTS,
    get_prompt,
    get_prompt_raw,
    list_prompts,
    get_prompts_by_task,
    get_prompt_metadata,
)


# =============================================================================
# Test Data
# =============================================================================

SYNTHETIC_DIR = Path(__file__).parent.parent / "data" / "synthetic"
ANNOTATIONS_PATH = (
    Path(__file__).parent.parent / "evaluation" / "annotations" / "llm_generated.json"
)

# Core tasks and their expected version suffixes
CORE_TASK_VERSIONS = {
    "page_summary": ["v1", "v2", "v3"],
    "journey_narrative": ["v2a", "v2b", "v2c", "v2d"],
}
CORE_TASKS = list(CORE_TASK_VERSIONS.keys())

# Required prompting techniques per milestone spec
REQUIRED_TECHNIQUES = {"instruction", "few_shot", "chain_of_thought"}


@pytest.fixture
def sample_sessions():
    """Load sample sessions from individual files in data/synthetic/."""
    sessions = []
    for path in sorted(SYNTHETIC_DIR.glob("session_*.json")):
        with open(path) as f:
            sessions.append(json.load(f))
    # Merge annotations for tests that use expected_clusters/expected_triggers.
    # annotations.json was removed along with trigger inference (settled
    # decision: temporal artifact) — default both keys unconditionally so the
    # narrative-formatting tests keep working with empty trigger/cluster
    # sections (their assertion is template formatting, not trigger content).
    if ANNOTATIONS_PATH.exists():
        with open(ANNOTATIONS_PATH) as f:
            annotations = json.load(f)
        for sess in sessions:
            sid = sess["sessionId"]
            if sid in annotations:
                sess["expected_clusters"] = annotations[sid].get("expected_clusters", [])
                sess["expected_triggers"] = annotations[sid].get("expected_triggers", [])
    for sess in sessions:
        sess.setdefault("expected_clusters", [])
        sess.setdefault("expected_triggers", [])
    return sessions


@pytest.fixture
def titanic_session(sample_sessions):
    """Short session (session_001): Titanic -> Hypothermia -> Frostbite."""
    return sample_sessions[0]


@pytest.fixture
def black_hole_session(sample_sessions):
    """Deep dive session (session_002): 6-page black hole exploration."""
    return sample_sessions[1]


@pytest.fixture
def single_page_session(sample_sessions):
    """Edge case (session_005): Single page, no transitions."""
    return sample_sessions[4]


@pytest.fixture
def duplicate_session(sample_sessions):
    """Edge case (session_006): Contains a revisited page."""
    return sample_sessions[5]


@pytest.fixture
def speed_session(sample_sessions):
    """Edge case (session_007): Very short dwell times."""
    return sample_sessions[6]


# =============================================================================
# Prompt Registry Tests
# =============================================================================


class TestPromptRegistry:
    """Tests for prompt template registry structure and metadata."""

    def test_all_prompts_have_required_fields(self):
        """Every prompt entry must have template, techniques, description."""
        for name, data in PROMPTS.items():
            assert "template" in data, f"{name} missing 'template'"
            assert "techniques" in data, f"{name} missing 'techniques'"
            assert "description" in data, f"{name} missing 'description'"

    def test_naming_convention(self):
        """All prompts follow {task}_{version} naming convention.

        Version suffix is 'v' + digit(s), optionally followed by either a
        single letter (technique variant: v2a/v2b) or '_' + digit(s) (patch
        level: v2_1/v2_2/v2_3). A plain rsplit on '_' would break the
        patch-level form at the inner underscore.
        """
        pattern = re.compile(r"^(?P<task>.+)_(?P<version>v\d+(?:_\d+|[a-z])?)$")
        for name in PROMPTS:
            assert pattern.match(name), (
                f"{name} doesn't match {{task}}_v{{version}} convention"
            )

    def test_techniques_are_lists(self):
        """Techniques field must be a non-empty list of strings."""
        for name, data in PROMPTS.items():
            assert isinstance(data["techniques"], list), f"{name} techniques is not a list"
            assert len(data["techniques"]) > 0, f"{name} has empty techniques"
            for t in data["techniques"]:
                assert isinstance(t, str), f"{name} has non-string technique: {t}"

    def test_core_tasks_have_expected_versions(self):
        """Each core task must have all its expected version variants."""
        for task, expected_versions in CORE_TASK_VERSIONS.items():
            versions = get_prompts_by_task(task)
            version_names = [p["name"] for p in versions]
            for v in expected_versions:
                assert f"{task}_{v}" in version_names, f"{task} missing {v}"

    def test_all_required_techniques_covered(self):
        """Across all prompts, instruction, few_shot, and chain_of_thought must appear."""
        all_techniques = set()
        for data in PROMPTS.values():
            all_techniques.update(data["techniques"])
        for required in REQUIRED_TECHNIQUES:
            assert required in all_techniques, f"Technique '{required}' not used in any prompt"

    def test_each_task_uses_multiple_techniques(self):
        """Each core task should use at least 2 distinct techniques across its versions."""
        for task in CORE_TASKS:
            techniques_used = set()
            for name, data in PROMPTS.items():
                if name.startswith(task):
                    techniques_used.update(data["techniques"])
            assert (
                len(techniques_used) >= 2
            ), f"{task} only uses {techniques_used} — need at least 2 distinct techniques"

    def test_list_prompts_returns_all(self):
        """list_prompts() should return metadata for every registered prompt."""
        result = list_prompts()
        assert len(result) == len(PROMPTS)
        names = {p["name"] for p in result}
        assert names == set(PROMPTS.keys())


# =============================================================================
# Prompt Formatting Tests
# =============================================================================


class TestPromptFormatting:
    """Tests for get_prompt() formatting with valid and invalid inputs."""

    def test_page_summary_v1_formats(self):
        """page_summary_v1 formats with title and content."""
        result = get_prompt("page_summary_v1", title="Titanic", content="The Titanic was a ship.")
        assert "Titanic" in result
        assert "The Titanic was a ship." in result

    def test_page_summary_v2_formats(self):
        """page_summary_v2 (few-shot) includes examples and formats input."""
        result = get_prompt("page_summary_v2", title="Test", content="Test content.")
        assert "Tardigrade" in result  # Few-shot example
        assert "Voyager 1" in result  # Few-shot example
        assert "Test" in result

    def test_page_summary_v3_formats(self):
        """page_summary_v3 (CoT) includes step instructions."""
        result = get_prompt("page_summary_v3", title="Test", content="Test content.")
        assert "Step 1" in result
        assert "Step 2" in result
        assert "Step 3" in result

    def test_journey_narrative_all_versions(self):
        """All journey narrative versions format with session data."""
        kwargs = {
            "duration": "30",
            "page_count": "5",
            "clusters": "Maritime Disasters (3 pages)",
            "triggers": "Cold water mention (Titanic -> Hypothermia)",
            "summaries": "Titanic: Ship sank. Hypothermia: Cold kills.",
        }
        for version in ["v2a", "v2b", "v2c", "v2d"]:
            result = get_prompt(f"journey_narrative_{version}", **kwargs)
            assert "30" in result or "5" in result

    def test_missing_placeholder_raises_error(self):
        """Formatting with missing required placeholders should raise KeyError."""
        with pytest.raises(KeyError, match="Missing placeholder"):
            get_prompt("page_summary_v1", title="Titanic")  # Missing 'content'

    def test_unknown_prompt_raises_error(self):
        """Requesting a nonexistent prompt should raise KeyError."""
        with pytest.raises(KeyError, match="not found"):
            get_prompt("nonexistent_prompt_v99")

    def test_get_prompt_metadata(self):
        """get_prompt_metadata returns correct info without formatting."""
        meta = get_prompt_metadata("page_summary_v2")
        assert meta["name"] == "page_summary_v2"
        assert "few_shot" in meta["techniques"]
        assert "instruction" in meta["techniques"]


# =============================================================================
# Edge Case Input Tests
# =============================================================================


class TestEdgeCaseInputs:
    """Test prompts with edge-case data that could break formatting or confuse LLMs."""

    def test_empty_content(self):
        """Prompt should format even with empty content (LLM handles it)."""
        result = get_prompt("page_summary_v1", title="Empty Page", content="")
        assert "Empty Page" in result
        assert len(result) > 50  # Template text is still present

    def test_very_long_content(self):
        """Prompt handles very long content without errors."""
        long_content = "The quick brown fox. " * 5000  # ~100K chars
        result = get_prompt("page_summary_v1", title="Long Article", content=long_content)
        assert "Long Article" in result
        assert len(result) > 100000

    def test_special_characters_in_title(self):
        """Titles with special chars (parentheses, quotes) format correctly."""
        result = get_prompt(
            "page_summary_v1",
            title='Singularity (physics) "theory"',
            content="A singularity is a point...",
        )
        assert 'Singularity (physics) "theory"' in result

    def test_curly_braces_in_content(self):
        """Content with literal curly braces doesn't break .format()."""
        # This is a known issue: Python .format() treats {} as placeholders
        # Content with curly braces should be escaped or handled
        content_with_braces = "The set {{1, 2, 3}} is finite."
        result = get_prompt("page_summary_v1", title="Set Theory", content=content_with_braces)
        assert "Set Theory" in result

    def test_narrative_with_no_triggers(self):
        """Narrative prompt works when no triggers were identified."""
        result = get_prompt(
            "journey_narrative_v2a",
            duration="10",
            page_count="1",
            clusters="None identified",
            triggers="None identified",
            summaries="Tardigrade: Microscopic animals that survive extreme conditions.",
        )
        assert "None identified" in result


# =============================================================================
# Prompt Quality Checks (Structural)
# =============================================================================


class TestPromptQuality:
    """Verify structural quality properties of prompt templates."""

    def test_no_prompt_is_empty(self):
        """No template should be empty or trivially short."""
        for name, data in PROMPTS.items():
            assert len(data["template"].strip()) > 50, f"{name} template is too short"

    def test_few_shot_and_one_shot_prompts_contain_examples(self):
        """Prompts tagged 'few_shot' or 'one_shot' must contain example text."""
        example_markers = ["example", "Example", "EXAMPLE"]
        for name, data in PROMPTS.items():
            if "few_shot" in data["techniques"] or "one_shot" in data["techniques"]:
                has_example = any(marker in data["template"] for marker in example_markers)
                assert has_example, f"{name} is tagged few/one_shot but contains no examples"

    def test_cot_prompts_contain_step_instructions(self):
        """Prompts tagged 'chain_of_thought' should guide step-by-step reasoning."""
        step_markers = [
            "step by step",
            "Step 1",
            "step 1",
            "Think through",
            "reason through these steps",
        ]
        for name, data in PROMPTS.items():
            if "chain_of_thought" in data["techniques"]:
                has_steps = any(marker in data["template"] for marker in step_markers)
                assert has_steps, f"{name} is tagged chain_of_thought but has no step guidance"

    def test_expert_narratives_no_casual_language(self):
        """Expert-style narratives (v2 series) should NOT contain casual language."""
        casual_markers = ["playful", "warm", "fun", "adventure", "rabbit hole", "dude"]
        expert_versions = [
            "journey_narrative_v2a",
            "journey_narrative_v2b",
            "journey_narrative_v2c",
            "journey_narrative_v2d",
        ]
        for version in expert_versions:
            template = PROMPTS[version]["template"].lower()
            for marker in casual_markers:
                assert (
                    marker not in template
                ), f"{version} contains casual language '{marker}' — should be expert style"

    def test_expert_narratives_request_expert_voice(self):
        """Expert-style narratives should request expert/dense/substantive output."""
        expert_markers = [
            "expert",
            "cognitive offload",
            "information density",
            "substantive",
        ]
        expert_versions = [
            "journey_narrative_v2a",
            "journey_narrative_v2b",
            "journey_narrative_v2c",
            "journey_narrative_v2d",
        ]
        for version in expert_versions:
            template = PROMPTS[version]["template"].lower()
            has_expert = any(marker in template for marker in expert_markers)
            assert has_expert, f"{version} doesn't request expert-style output"

    def test_compendium_narratives_have_knowledge_framing(self):
        """v2 narrative variants should use compendium/knowledge framing."""
        compendium_markers = ["compendium", "knowledge"]
        for suffix in ["v2a", "v2b", "v2c", "v2d"]:
            version = f"journey_narrative_{suffix}"
            template = PROMPTS[version]["template"].lower()
            has_compendium = any(marker in template for marker in compendium_markers)
            assert has_compendium, f"{version} missing compendium/knowledge framing"

    def test_narrative_v2c_has_example_input_and_output(self):
        """v2c (one-shot) should include both example input data and example output."""
        template = PROMPTS["journey_narrative_v2c"]["template"].lower()
        assert "example session data" in template, "v2c missing example input"
        assert "example compendium entry" in template, "v2c missing example output"

    def test_narrative_v2d_has_reasoning_section(self):
        """v2d (CoT) should include a reasoning section before the entry."""
        template = PROMPTS["journey_narrative_v2d"]["template"]
        assert "Reasoning:" in template, "v2d missing Reasoning section"
        assert "Compendium Entry:" in template, "v2d missing Compendium Entry section"


# =============================================================================
# Integration with Sample Data
# =============================================================================


class TestWithSampleData:
    """Test formatting prompts with real sample session data."""

    def test_summary_with_real_article(self, titanic_session):
        """Format page_summary with session page data."""
        page = titanic_session["pages"][0]
        content = f"Article about {page['title']}."
        for version in ["v1", "v2", "v3"]:
            result = get_prompt(
                f"page_summary_{version}",
                title=page["title"],
                content=content,
            )
            assert len(result) > 100
            assert "Titanic" in result

    def test_narrative_with_real_session_data(self, titanic_session):
        """Format journey_narrative with assembled session data."""
        session = titanic_session
        summaries = "; ".join(f"{p['title']}: brief summary" for p in session["pages"])
        triggers = "; ".join(
            f"{t['from_page']} -> {t['to_page']}: {t['trigger']}"
            for t in session["expected_triggers"]
        )
        clusters = "; ".join(
            f"{c['name']} ({len(c['pages'])} pages)" for c in session["expected_clusters"]
        )
        # Derive duration from timestamps
        from datetime import datetime

        started = datetime.fromisoformat(session["startedAt"].replace("Z", "+00:00"))
        ended = datetime.fromisoformat(session["endedAt"].replace("Z", "+00:00"))
        duration = max(1, round((ended - started).total_seconds() / 60))

        for version in ["v2a", "v2b", "v2c", "v2d"]:
            result = get_prompt(
                f"journey_narrative_{version}",
                duration=str(duration),
                page_count=str(len(session["pages"])),
                clusters=clusters,
                triggers=triggers,
                summaries=summaries,
            )
            assert len(result) > 200

    def test_single_page_edge_case(self, single_page_session):
        """Summarization works on the single-page edge case."""
        page = single_page_session["pages"][0]
        result = get_prompt(
            "page_summary_v1",
            title=page["title"],
            content=f"Article about {page['title']}.",
        )
        assert "Tardigrade" in result


# =============================================================================
# Cluster Naming / Supercluster Label Registry Migration
# (clustering-quality backlog, 2026-08-14)
# =============================================================================


class TestGetPromptRaw:
    """Tests for get_prompt_raw() -- the sanitize-free renderer used by
    prompts that require byte-identical parity with a pre-registry inline
    f-string (see get_prompt_raw's docstring for why get_prompt() itself
    can't be used for these)."""

    def test_unknown_prompt_raises_error(self):
        with pytest.raises(KeyError, match="not found"):
            get_prompt_raw("nonexistent_prompt_v99")

    def test_missing_placeholder_raises_error(self):
        with pytest.raises(KeyError, match="Missing placeholder"):
            get_prompt_raw("cluster_naming_v1a", n_pages=3)  # missing 'context'

    def test_extra_kwargs_are_ignored(self):
        """A kwarg the template doesn't reference is silently dropped
        (plain str.format() semantics) -- this is what lets
        supercluster_label_v1a ignore sibling_labels_block while v1b uses
        it, via the same call site."""
        result = get_prompt_raw(
            "cluster_naming_v1a", n_pages=1, context="- X [x.com]", unused="ignored"
        )
        assert "ignored" not in result

    def test_no_sanitize_wrap_for_long_values(self):
        """Unlike get_prompt(), get_prompt_raw() must NOT wrap long kwargs
        in <user_content> delimiters or escape their braces -- that would
        break byte-identical parity with the pre-registry inline prompts."""
        long_context = "\n".join(f"- Page {i} [example.com]" for i in range(20))
        assert len(long_context) > 50
        result = get_prompt_raw("cluster_naming_v1a", n_pages=20, context=long_context)
        assert "<user_content>" not in result
        assert long_context in result  # present verbatim, not brace-escaped

    def test_respects_overrides(self, tmp_path, monkeypatch):
        """get_prompt_raw() still checks overrides.json, matching
        get_prompt()'s hot-reload behavior."""
        import backend.prompts.templates as templates_mod

        override_path = tmp_path / "overrides.json"
        override_path.write_text(
            json.dumps({"cluster_naming_v1a": "OVERRIDDEN {n_pages} {context}"})
        )
        monkeypatch.setattr(templates_mod, "_OVERRIDES_PATH", override_path)
        result = get_prompt_raw("cluster_naming_v1a", n_pages=2, context="ctx")
        assert result == "OVERRIDDEN 2 ctx"


class TestClusterNamingRegistryParity:
    """cluster_naming_v1a must render byte-identical output to the original
    inline f-string in ClusteringService._build_naming_prompt, for any
    (n_pages, context) input -- this pins the registry migration so it
    cannot silently change production naming behavior."""

    @staticmethod
    def _old_inline_prompt(n_pages: int, context: str) -> str:
        """Literal copy of the pre-migration f-string body (clustering_service.py,
        pre-2026-08-14). Do not "clean up" to match the template -- the point
        of this copy is to be an independent, frozen reference."""
        return (
            f"Name this cluster of {n_pages} web pages based on the DOMINANT topic.\n\n"
            f"Pages:\n{context}\n\n"
            f"Rules:\n"
            f"- Focus on the subject matter, not the platform "
            f"(e.g., 'Volcanic Eruptions' not 'Wikipedia Articles', "
            f"'Figure Skating' not 'Reddit Discussions').\n"
            f"- If pages span unrelated topics, name the most common one "
            f"and ignore outliers.\n"
            f"- Be specific: 'Phreatomagmatic Eruptions' not 'Science Topics', "
            f"'Deck Box Organizers' not 'Gaming Resources'.\n"
            f"- BAD names: 'Web Search Queries', 'Diverse Online Resources', "
            f"'Reddit Discussions', 'Wikipedia and Related Resources'.\n"
            f"- 2-5 words. Output ONLY the name, nothing else."
        )

    @pytest.mark.parametrize(
        "n_pages,context",
        [
            (0, ""),
            (1, "- Solo Page [example.com]"),
            (
                4,
                "- Volcanic ash [en.wikipedia.org]: Fine particles from eruptions\n"
                "- Cinder cone [en.wikipedia.org]\n"
                "- Phreatomagmatic eruption [en.wikipedia.org]: Water-magma interaction\n"
                "- Volcanic explosivity index [en.wikipedia.org]",
            ),
            (2, "content with {braces} and 'quotes' and — em-dashes"),
        ],
    )
    def test_v1a_byte_identical_to_old_inline(self, n_pages, context):
        old = self._old_inline_prompt(n_pages, context)
        new = get_prompt_raw("cluster_naming_v1a", n_pages=n_pages, context=context)
        assert new == old

    def test_v1a_matches_pre_migration_via_settings_default(self):
        """settings.cluster_naming_prompt_version defaults to 'v1a', so
        resolving the version through settings (as ClusteringService does)
        reaches the same byte-identical template."""
        from backend.config.settings import settings

        assert settings.cluster_naming_prompt_version == "v1a"
        old = self._old_inline_prompt(5, "- A [a.com]\n- B [b.com]")
        new = get_prompt_raw(
            f"cluster_naming_{settings.cluster_naming_prompt_version}",
            n_pages=5,
            context="- A [a.com]\n- B [b.com]",
        )
        assert new == old


class TestSuperClusterLabelRegistryParity:
    """supercluster_label_v1a must render byte-identical output to the
    original inline prompt string in
    super_cluster_service._suggest_group_labels."""

    @staticmethod
    def _old_inline_prompt(groups_json: str) -> str:
        """Literal copy of the pre-migration prompt string
        (super_cluster_service.py, pre-2026-08-14)."""
        return (
            "Each entry below is a GROUP of related web-page clusters from one "
            "person's browsing. Give each group a short topic label (2-4 words, "
            "title case) that covers all its clusters — the label is offered to "
            "the user as a suggested new topic, so prefer the natural umbrella "
            "term over a list.\n\n"
            f"GROUPS (JSON):\n{groups_json}\n\n"
            "Return JSON ONLY in this exact shape:\n"
            '{"labels": [{"group_id": <id>, "label": "<label>"}, ...]}'
        )

    @pytest.mark.parametrize(
        "payload",
        [
            [],
            [{"group_id": 1, "clusters": ["Solo Cluster"]}],
            [
                {"group_id": 1, "clusters": ["Cricut Iron-On Techniques", "3D Printed Organizers"]},
                {"group_id": 2, "clusters": ["Volcanic Eruptions"]},
            ],
        ],
    )
    def test_v1a_byte_identical_to_old_inline(self, payload):
        groups_json = json.dumps(payload, ensure_ascii=False)
        old = self._old_inline_prompt(groups_json)
        new = get_prompt_raw(
            "supercluster_label_v1a",
            groups_json=groups_json,
            sibling_labels_block="unused by v1a",
        )
        assert new == old

    def test_v1a_matches_pre_migration_via_settings_default(self):
        from backend.config.settings import settings

        assert settings.supercluster_label_prompt_version == "v1a"
        payload = [{"group_id": 1, "clusters": ["A"]}]
        groups_json = json.dumps(payload, ensure_ascii=False)
        old = self._old_inline_prompt(groups_json)
        new = get_prompt_raw(
            f"supercluster_label_{settings.supercluster_label_prompt_version}",
            groups_json=groups_json,
            sibling_labels_block="(none yet -- infer distinctiveness only from the other GROUPS above)",
        )
        assert new == old


class TestNamingVariantSmoke:
    """Render smoke tests for the v1b variants -- confirm they format
    without error and carry the guidance the backlog item asked for."""

    def test_cluster_naming_v1b_renders(self):
        result = get_prompt_raw(
            "cluster_naming_v1b",
            n_pages=3,
            context="- Giant oarfish [en.wikipedia.org]\n- List of largest fish [en.wikipedia.org]",
        )
        assert "3 web pages" in result
        assert "Largest Fish Species" in result  # canonical bad example present
        assert "2-5 words" in result

    def test_cluster_naming_v1b_differs_from_v1a(self):
        kwargs = dict(n_pages=3, context="- A [a.com]\n- B [b.com]")
        v1a = get_prompt_raw("cluster_naming_v1a", **kwargs)
        v1b = get_prompt_raw("cluster_naming_v1b", **kwargs)
        assert v1a != v1b

    def test_supercluster_label_v1b_renders(self):
        result = get_prompt_raw(
            "supercluster_label_v1b",
            groups_json=json.dumps([{"group_id": 1, "clusters": ["A"]}]),
            sibling_labels_block="- Productivity Tools\n- Volcanic Eruptions",
        )
        assert "Zoology" in result  # forbidden bare-discipline example present
        assert "Productivity Tools" in result  # sibling label interpolated
        assert "Distinctive" in result

    def test_supercluster_label_v1b_differs_from_v1a(self):
        groups_json = json.dumps([{"group_id": 1, "clusters": ["A"]}])
        v1a = get_prompt_raw(
            "supercluster_label_v1a", groups_json=groups_json, sibling_labels_block="x"
        )
        v1b = get_prompt_raw(
            "supercluster_label_v1b", groups_json=groups_json, sibling_labels_block="x"
        )
        assert v1a != v1b

    def test_supercluster_label_v1b_no_siblings_fallback_renders(self):
        """Caller passes '(none yet ...)' when there are no sibling labels
        yet (see super_cluster_service._suggest_group_labels) -- must still
        render cleanly."""
        result = get_prompt_raw(
            "supercluster_label_v1b",
            groups_json=json.dumps([{"group_id": 1, "clusters": ["A"]}]),
            sibling_labels_block="(none yet -- infer distinctiveness only from the other GROUPS above)",
        )
        assert "(none yet" in result
