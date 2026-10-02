"""Pure-logic tests for the Pipeline dev view's flow and config shaping."""

from backend.services import pipeline_summary as ps


class TestBuildFlow:
    def test_zero_filled_and_fixed_order_when_empty(self):
        f = ps.build_flow([], [], [])
        assert f["total"] == 0 and f["details"] == []
        assert [(o["key"], o["count"], o["top_domains"]) for o in f["outcomes"]] == [
            (k, 0, []) for k in ps.OUTCOME_ORDER
        ]
        assert [x["key"] for x in f["fates"]] == list(ps.FATE_ORDER)
        assert f["outcomes"][1]["label"] == "Rule filter \u00b7 no LLM"

    def test_details_ordered_labelled_and_fates_zero_filled(self):
        cells = [
            ("gate", "uncategorized", "archived", 9),
            ("gate", "web_app", "archived", 2),
            ("gate", "login_wall", "archived", 3),
            ("gate", "login_wall", "active", 1),
            ("processed", "active", "active", 4),
            ("processed", "later_manual", "archived", 1),
            ("before_gate", "other", "archived", 1),
            ("before_gate", "placeholder", "archived", 2),
            ("pending", "waiting", "pending", 5),
        ]
        top = [{"key": "gate:login_wall", "count": 4, "top_domains": [{"domain": "x", "count": 4}]}]
        f = ps.build_flow(cells, [], top)
        assert [(d["outcome"], d["key"]) for d in f["details"]] == [
            ("before_gate", "placeholder"),
            ("before_gate", "other"),
            ("gate", "login_wall"),
            ("gate", "web_app"),
            ("gate", "uncategorized"),
            ("processed", "later_manual"),
            ("processed", "active"),
            ("pending", "waiting"),
        ]
        lw = f["details"][2]
        assert lw["label"] == "Login Wall" and lw["count"] == 4
        assert lw["fates"] == {"archived": 3, "active": 1, "pending": 0}
        assert lw["top_domains"] == [{"domain": "x", "count": 4}]
        assert f["details"][0]["top_domains"] == []
        assert f["total"] == 28
        assert {x["key"]: x["count"] for x in f["fates"]} == {
            "archived": 18,
            "active": 5,
            "pending": 5,
        }

    def test_detail_labels(self):
        assert ps.detail_label("gate", "uncategorized") == "Uncategorized (no reason)"
        assert ps.detail_label("rule_filter", "url_pattern") == "URL pattern rule"
        assert ps.detail_label("processed", "later_chrome") == "Archived later \u00b7 chrome"
        assert ps.detail_label("pending", "waiting") == "Not yet processed"
        assert ps.detail_label("gate", "some_new_cat") == "Some New Cat"


class TestRuleFilterConfig:
    def test_built_live_from_main(self):
        from backend.api import main

        cfg = ps.build_rule_filter_config()
        assert cfg["domains"] == sorted(main.SKIP_DOMAINS)
        assert cfg["domain_suffixes"] == list(main.SKIP_DOMAIN_SUFFIXES)
        assert cfg["url_patterns"] == [{"domain": d, "path": p} for d, p in main.SKIP_URL_PATTERNS]
        assert cfg["path_rules"] == list(main.SKIP_URL_PATH_RULES)

    def test_path_rules_cover_every_special_case(self):
        # Pins the twin of main._is_skip_url: it has 4 special cases after the
        # SKIP_URL_PATTERNS loop (reddit, youtube, instructure, claude.ai chrome).
        # Adding or removing one there means updating SKIP_URL_PATH_RULES and this count.
        assert len(ps.build_rule_filter_config()["path_rules"]) == 4


class TestSkipGateConfig:
    def test_shape_from_live_registry(self):
        cfg = ps.build_skip_gate_config()
        assert cfg["prompt_name"] == "skip_gate_v2_3"
        assert cfg["model"] and isinstance(cfg["model"], str)
        assert cfg["temperature"] == 0.0
        assert "{title}" in cfg["prompt"]  # unformatted template text
        assert [t["name"] for t in cfg["tools"]] == ["skip_page", "process_page"]
        assert all(t["description"] for t in cfg["tools"])

    def test_categories_come_from_the_module(self):
        from backend.services.skip_categories import SKIP_CATEGORIES

        cats = ps.build_skip_gate_config()["categories"]
        assert [(c["id"], c["label"], c["description"]) for c in cats] == list(SKIP_CATEGORIES)

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
