"""Pure-logic tests for the Pipeline dev view's summary shaping. Ports the
rules of explorer frontend/dash/callbacks/pipeline_monitor.py:137-293."""

from backend.services import pipeline_summary as ps


class TestDecisionRows:
    def test_expands_null_depth_into_breakdown_rows(self):
        rows = ps.build_decision_rows(
            {"processed": 10, "skipped": 30, "null": 7},
            {"Pending": 4, "Trivial Capture": 2, "Other": 1},
        )
        assert [r["key"] for r in rows] == [
            "skipped",
            "processed",
            "pending",
            "trivial_capture",
            "other",
        ]
        assert [r["label"] for r in rows] == [
            "Skipped",
            "Processed",
            "Pending",
            "Trivial Capture",
            "Other",
        ]
        assert [r["evaluated"] for r in rows] == [True, True, False, False, False]

    def test_legacy_active_folds_into_processed(self):
        rows = ps.build_decision_rows({"processed": 10, "null": 5}, {"legacy_active": 5})
        assert rows[0] == {"key": "processed", "label": "Processed", "count": 15, "evaluated": True}
        assert len(rows) == 1  # no leftover breakdown rows

    def test_legacy_active_without_processed_key_creates_processed_row(self):
        rows = ps.build_decision_rows({"skipped": 3, "null": 5}, {"legacy_active": 5})
        assert {"key": "processed", "label": "Processed", "count": 5, "evaluated": True} in rows

    def test_surface_and_full_are_title_cased(self):
        rows = ps.build_decision_rows({"surface": 1, "full": 2}, {})
        assert {r["key"]: r["label"] for r in rows} == {"surface": "Surface", "full": "Full"}

    def test_sorted_by_count_desc(self):
        rows = ps.build_decision_rows({"processed": 1, "skipped": 9, "surface": 5}, {})
        assert [r["count"] for r in rows] == [9, 5, 1]

    def test_empty_inputs(self):
        assert ps.build_decision_rows({}, {}) == []


class TestSkipMethods:
    def test_labels_and_order(self):
        rows = ps.build_skip_method_rows(
            {"skip_gate": 5, "domain_skip": 9, "dedupe_fold": 1, "other": 2}
        )
        assert rows == [
            {"key": "domain_skip", "label": "Domain Filter", "count": 9},
            {"key": "skip_gate", "label": "LLM Skip Gate", "count": 5},
            {"key": "other", "label": "Other", "count": 2},
            {"key": "dedupe_fold", "label": "Dedupe Fold", "count": 1},
        ]


    def test_unknown_snake_case_falls_back_to_title_case(self):
        rows = ps.build_skip_method_rows({"some_new_reason": 3})
        assert rows[0]["label"] == "Some New Reason"
        assert ps.skip_method_label("dedup") == "Dedup"


class TestSkipGateReasons:
    def test_drops_none_bucket_and_keeps_order(self):
        rows = ps.build_skip_gate_reasons([("login wall", 7), ("(none)", 100), ("stub", 2)])
        assert rows == [{"reason": "login wall", "count": 7}, {"reason": "stub", "count": 2}]


class TestSkipGateConfig:
    def test_shape_from_live_registry(self):
        cfg = ps.build_skip_gate_config()
        assert cfg["prompt_name"] == "skip_gate_v2_3"
        assert cfg["model"] and isinstance(cfg["model"], str)
        assert cfg["temperature"] == 0.0
        assert "{title}" in cfg["prompt"]  # unformatted template text
        assert [t["name"] for t in cfg["tools"]] == ["skip_page", "process_page"]
        assert all(t["description"] for t in cfg["tools"])

    def test_override_wins(self, monkeypatch):
        from backend.prompts import templates

        monkeypatch.setattr(
            templates, "_load_overrides", lambda: {"skip_gate_v2_3": "OVERRIDE {title}"}
        )
        assert ps.build_skip_gate_config()["prompt"] == "OVERRIDE {title}"


class TestGetPromptTemplate:
    def test_unknown_name_raises_keyerror(self):
        import pytest

        from backend.prompts.templates import get_prompt_template

        with pytest.raises(KeyError):
            get_prompt_template("no_such_prompt")
