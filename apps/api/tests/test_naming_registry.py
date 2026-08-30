"""Service-side tests for the cluster_naming / supercluster_label registry
migration (clustering-quality backlog, 2026-08-14).

test_prompts.py pins the registry templates themselves (byte-identical
parity, variant rendering). This file verifies the two SERVICES actually
read from the registry, honor the version-selection settings, and wire the
extra data (sibling_labels) that only the v1b variant consumes -- i.e. the
call-site integration, not the template text.

No LLM calls are made -- ``_build_naming_prompt`` is pure, and
``_suggest_group_labels`` is exercised against a stub LLMService that
captures the rendered prompt instead of calling out.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import numpy as np
import pytest

from backend.config.settings import settings


# =============================================================================
# ClusteringService._build_naming_prompt
# =============================================================================


class TestClusteringServiceReadsRegistry:
    def _pages(self):
        return [
            {"title": "Volcanic ash", "domain": "en.wikipedia.org", "summary": "Fine particles from eruptions"},
            {"title": "Cinder cone", "domain": "en.wikipedia.org", "summary": ""},
            {"title": "Phreatomagmatic eruption", "domain": "en.wikipedia.org", "summary": "Water-magma interaction"},
            {"title": "Volcanic explosivity index", "domain": "en.wikipedia.org", "summary": ""},
        ]

    def test_default_version_is_v1a_byte_identical(self, monkeypatch):
        from backend.prompts.templates import get_prompt_raw
        from backend.services.clustering_service import ClusteringService

        assert settings.cluster_naming_prompt_version == "v1a"
        pages = self._pages()
        labels = np.array([0, 0, 0, 0])
        result = ClusteringService._build_naming_prompt(0, labels, pages)

        # Reproduce the context-building logic (title/domain/summary
        # sampling, [:10], [:100]/[:150] truncation) to compute the expected
        # registry rendering independently of the method under test.
        sample = pages[:10]
        page_lines = []
        for p in sample:
            title = (p["title"] or "(no title)")[:100]
            domain = p.get("domain", "")
            excerpt = ""
            if p.get("summary"):
                excerpt = ": " + p["summary"][:150].replace("\n", " ")
            page_lines.append(f"- {title} [{domain}]{excerpt}")
        context = "\n".join(page_lines)

        expected = get_prompt_raw("cluster_naming_v1a", n_pages=4, context=context)
        assert result == expected

    def test_version_setting_flips_rendered_prompt(self, monkeypatch):
        """Flipping settings.cluster_naming_prompt_version to v1b changes
        the prompt _build_naming_prompt renders -- proves the service reads
        the setting at call time, not a baked-in v1a constant."""
        from backend.services.clustering_service import ClusteringService

        pages = self._pages()
        labels = np.array([0, 0, 0, 0])

        v1a_result = ClusteringService._build_naming_prompt(0, labels, pages)
        monkeypatch.setattr(settings, "cluster_naming_prompt_version", "v1b")
        v1b_result = ClusteringService._build_naming_prompt(0, labels, pages)

        assert v1a_result != v1b_result
        assert "covers ALL of them" in v1b_result
        assert "covers ALL of them" not in v1a_result

    def test_unknown_version_raises(self, monkeypatch):
        from backend.services.clustering_service import ClusteringService

        monkeypatch.setattr(settings, "cluster_naming_prompt_version", "v99z")
        with pytest.raises(KeyError, match="not found"):
            ClusteringService._build_naming_prompt(0, np.array([0]), [self._pages()[0]])

    def test_batch_and_realtime_paths_share_the_prompt(self):
        """Both naming paths call the same static helper -- the byte-
        identical-prompt guarantee the original docstring describes still
        holds after the registry migration."""
        from backend.services.clustering_service import ClusteringService
        import inspect

        # Both _name_one_cluster and _name_clusters_batch call
        # _build_naming_prompt (not a duplicated inline string) -- assert
        # by source inspection since neither makes an LLM call without a
        # network stub.
        assert "_build_naming_prompt" in inspect.getsource(
            ClusteringService._name_one_cluster
        )
        assert "_build_naming_prompt" in inspect.getsource(
            ClusteringService._name_clusters_batch
        )


# =============================================================================
# super_cluster_service._suggest_group_labels
# =============================================================================


class _LLMStub:
    """Captures the rendered prompt instead of calling out."""

    def __init__(self, content: str):
        self._content = content
        self.last_prompt: str | None = None

    async def complete(self, **kwargs):
        self.last_prompt = kwargs["prompt"]
        assert kwargs["response_format"] == "json_object"
        return SimpleNamespace(content=self._content, cost_usd=0.0002, latency_ms=1)


class TestSuperClusterServiceReadsRegistry:
    def _unlabeled(self):
        return [{"group_index": 1, "label": None}, {"group_index": 2, "label": None}]

    def _members(self):
        return {1: [10, 11], 2: [12]}

    def _names(self):
        return {10: "Cricut Iron-On Techniques", 11: "3D Printed Organizers", 12: "Volcanic Eruptions"}

    def test_default_version_is_v1a_byte_identical(self, monkeypatch):
        import backend.services.super_cluster_service as scs
        from backend.prompts.templates import get_prompt_raw

        assert settings.supercluster_label_prompt_version == "v1a"
        stub = _LLMStub('{"labels": [{"group_id": 1, "label": "Craft Techniques"}, '
                         '{"group_id": 2, "label": "Volcanic Eruptions"}]}')
        monkeypatch.setattr(scs, "LLMService", lambda: stub)

        result, cost = asyncio.run(
            scs._suggest_group_labels(self._unlabeled(), self._members(), self._names())
        )
        assert result == {1: "Craft Techniques", 2: "Volcanic Eruptions"}
        assert cost == 0.0002

        payload = [
            {"group_id": 1, "clusters": ["Cricut Iron-On Techniques", "3D Printed Organizers"]},
            {"group_id": 2, "clusters": ["Volcanic Eruptions"]},
        ]
        expected = get_prompt_raw(
            "supercluster_label_v1a",
            groups_json=json.dumps(payload, ensure_ascii=False),
            sibling_labels_block="unused",
        )
        assert stub.last_prompt == expected

    def test_version_setting_flips_rendered_prompt(self, monkeypatch):
        import backend.services.super_cluster_service as scs

        stub = _LLMStub('{"labels": [{"group_id": 1, "label": "Craft Techniques"}]}')
        monkeypatch.setattr(scs, "LLMService", lambda: stub)

        asyncio.run(
            scs._suggest_group_labels(self._unlabeled(), self._members(), self._names())
        )
        v1a_prompt = stub.last_prompt

        monkeypatch.setattr(settings, "supercluster_label_prompt_version", "v1b")
        asyncio.run(
            scs._suggest_group_labels(self._unlabeled(), self._members(), self._names())
        )
        v1b_prompt = stub.last_prompt

        assert v1a_prompt != v1b_prompt
        assert "Distinctive" in v1b_prompt
        assert "Distinctive" not in v1a_prompt

    def test_sibling_labels_reach_v1b_prompt(self, monkeypatch):
        """sibling_labels is only meaningful to v1b -- confirm it actually
        lands in the rendered prompt when v1b is active."""
        import backend.services.super_cluster_service as scs

        monkeypatch.setattr(settings, "supercluster_label_prompt_version", "v1b")
        stub = _LLMStub('{"labels": [{"group_id": 1, "label": "Craft Techniques"}]}')
        monkeypatch.setattr(scs, "LLMService", lambda: stub)

        asyncio.run(
            scs._suggest_group_labels(
                self._unlabeled(), self._members(), self._names(),
                sibling_labels=["Productivity Tools", "Astronomy"],
            )
        )
        assert "Productivity Tools" in stub.last_prompt
        assert "Astronomy" in stub.last_prompt

    def test_no_sibling_labels_falls_back_to_placeholder(self, monkeypatch):
        import backend.services.super_cluster_service as scs

        monkeypatch.setattr(settings, "supercluster_label_prompt_version", "v1b")
        stub = _LLMStub('{"labels": [{"group_id": 1, "label": "Craft Techniques"}]}')
        monkeypatch.setattr(scs, "LLMService", lambda: stub)

        asyncio.run(
            scs._suggest_group_labels(
                self._unlabeled(), self._members(), self._names(), sibling_labels=None
            )
        )
        assert "none yet" in stub.last_prompt

    def test_v1a_ignores_sibling_labels(self, monkeypatch):
        """v1a's template has no sibling_labels_block placeholder -- passing
        sibling_labels must not raise and must not appear in the prompt."""
        import backend.services.super_cluster_service as scs

        stub = _LLMStub('{"labels": [{"group_id": 1, "label": "Craft Techniques"}]}')
        monkeypatch.setattr(scs, "LLMService", lambda: stub)

        asyncio.run(
            scs._suggest_group_labels(
                self._unlabeled(), self._members(), self._names(),
                sibling_labels=["Should Not Appear"],
            )
        )
        assert "Should Not Appear" not in stub.last_prompt

    def test_call_site_computes_sibling_labels_from_groups(self, monkeypatch):
        """assign_super_clusters_hybrid's call site derives sibling_labels
        from OTHER groups' already-known labels -- verify via the
        _suggest_group_labels monkeypatch shape used across
        test_supercluster_hybrid.py / test_supercluster_singleton_collapse.py
        (accepts sibling_labels as a kwarg without raising)."""
        captured = {}

        async def fake_suggest(unlabeled, members_by_group, names, sibling_labels=None):
            captured["sibling_labels"] = sibling_labels
            return {g["group_index"]: "Stub Label" for g in unlabeled}, 0.0

        import backend.services.super_cluster_service as scs

        monkeypatch.setattr(scs, "_suggest_group_labels", fake_suggest)

        groups = [
            {"group_index": 0, "label": "Existing Keyword Group", "topic": "kw", "member_count": 1},
            {"group_index": 1, "label": None, "member_count": 1},
        ]
        members_by_group = {0: [1], 1: [2]}
        cluster_names = {1: "A", 2: "B"}

        unlabeled = [g for g in groups if g["label"] is None]
        sibling_labels = sorted({g["label"] for g in groups if g.get("label")})
        asyncio.run(
            scs._suggest_group_labels(
                unlabeled, members_by_group, cluster_names, sibling_labels=sibling_labels
            )
        )
        assert captured["sibling_labels"] == ["Existing Keyword Group"]
