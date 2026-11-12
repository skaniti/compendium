"""Model-proposed superclusters (backend/services/topic_proposals.py): candidate
collection, output validation, storage, exclusion from the graph payload and
counts, the offer rule with both source settings, the endpoint shape, accept and
dismiss, and failure isolation. Synthetic data only."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from backend.config.settings import settings
from backend.services import topic_proposals as tp
from backend.services.suggestion_offers import offered_suggestions, skip_reason


@pytest.fixture(autouse=True)
def _pin_settings(monkeypatch):
    """Tests here must not depend on a machine's .env: pin what they rely on."""
    monkeypatch.setattr(settings, "label_first_enabled", False)
    monkeypatch.setattr(settings, "supercluster_suggestion_source", "proposed")
    monkeypatch.setattr(settings, "supercluster_proposal_shape", "fields")
    monkeypatch.setattr(settings, "supercluster_suggestion_min_clusters", 2)
    monkeypatch.setattr(settings, "supercluster_suggestion_min_pages", 15)
    monkeypatch.setattr(settings, "supercluster_suggestion_max_topics", 8)
    monkeypatch.setattr(settings, "supercluster_proposal_max_candidates", 120)
    monkeypatch.setattr(settings, "supercluster_proposal_timeout_seconds", 30.0)


def _cluster(i, name, sc=None, pages=3):
    return {"id": i, "cluster_name": name, "super_cluster": sc, "page_ids": list(range(pages))}


# --- candidate collection ----------------------------------------------------

class TestCollectCandidates:
    def test_hybrid_style_excludes_keyword_and_accepted_labels(self):
        clusters = [
            _cluster(1, "Volcanoes", sc="science"),        # keyword group
            _cluster(2, "Crochet", sc="Fiber Crafts"),     # suggested group label
            _cluster(3, "Kites", sc=None),                 # dismissed/unpainted
            _cluster(4, "Accepted One", sc="Birds"),       # accepted keyword
        ]
        got = tp.collect_candidates(clusters, ["Science", "birds"])
        assert [c["id"] for c in got] == [2, 3]
        assert got[0] == {"id": 2, "name": "Crochet", "pages": 3}

    def test_keywords_mode_only_unclassified_clusters(self):
        clusters = [_cluster(1, "A", sc="zoology"), _cluster(2, "B"), _cluster(3, "C", sc="")]
        assert [c["id"] for c in tp.collect_candidates(clusters, ["zoology"])] == [2, 3]

    def test_no_keywords_everything_is_a_candidate(self):
        assert len(tp.collect_candidates([_cluster(1, "A"), _cluster(2, "B")], [])) == 2


# --- validation --------------------------------------------------------------

class TestValidateTopics:
    IDS = {1, 2, 3, 4, 5, 6}

    def test_valid_passes_through_trimmed(self):
        out = tp.validate_topics({"topics": [{"label": "  Cooking ", "cluster_ids": [1, 2]}]}, self.IDS, 8)
        assert out == [{"label": "Cooking", "cluster_ids": [1, 2]}]

    def test_unknown_ids_dropped_and_thin_topic_removed(self):
        out = tp.validate_topics({"topics": [{"label": "Alpha", "cluster_ids": [1, 99]}]}, self.IDS, 8)
        assert out == []

    def test_cluster_claimed_twice_goes_to_first_topic(self):
        raw = {"topics": [{"label": "Alpha", "cluster_ids": [1, 2]},
                          {"label": "Beta", "cluster_ids": [2, 3, 4]}]}
        out = tp.validate_topics(raw, self.IDS, 8)
        assert out == [{"label": "Alpha", "cluster_ids": [1, 2]}, {"label": "Beta", "cluster_ids": [3, 4]}]

    def test_topic_left_with_one_cluster_after_dedup_is_dropped(self):
        raw = {"topics": [{"label": "Alpha", "cluster_ids": [1, 2]}, {"label": "Beta", "cluster_ids": [2, 3]}]}
        assert [t["label"] for t in tp.validate_topics(raw, self.IDS, 8)] == ["Alpha"]

    def test_empty_or_missing_label_dropped(self):
        raw = {"topics": [{"label": "  ", "cluster_ids": [1, 2]}, {"cluster_ids": [3, 4]},
                          {"label": None, "cluster_ids": [5, 6]}]}
        assert tp.validate_topics(raw, self.IDS, 8) == []

    def test_cap_at_max_topics(self):
        raw = {"topics": [{"label": "Alpha", "cluster_ids": [1, 2]}, {"label": "Beta", "cluster_ids": [3, 4]},
                          {"label": "Gamma", "cluster_ids": [5, 6]}]}
        assert [t["label"] for t in tp.validate_topics(raw, self.IDS, 2)] == ["Alpha", "Beta"]

    def test_duplicate_ids_within_topic_counted_once(self):
        assert tp.validate_topics({"topics": [{"label": "Alpha", "cluster_ids": [1, 1]}]}, self.IDS, 8) == []

    @pytest.mark.parametrize("raw", [None, [], "x", {"topics": "x"}, {"topics": [1, "a", None]},
                                     {"topics": [{"label": "Alpha", "cluster_ids": "1,2"}]},
                                     {"topics": [{"label": "Alpha", "cluster_ids": [True, "2"]}]}])
    def test_malformed_shapes_yield_nothing(self, raw):
        assert tp.validate_topics(raw, self.IDS, 8) == []


class TestValidateTopicsHardening:
    IDS = set(range(1, 11))  # 10 candidates

    def test_equal_labels_ignoring_case_merge_first_spelling_wins(self):
        raw = {"topics": [{"label": "Birds", "cluster_ids": [1, 2]},
                          {"label": "  birds ", "cluster_ids": [2, 3]},
                          {"label": "Lanterns", "cluster_ids": [3, 4]}]}
        out = tp.validate_topics(raw, self.IDS, 8)
        # the second topic keeps only cluster 4 after the merge, so it is dropped
        assert out == [{"label": "Birds", "cluster_ids": [1, 2, 3]}]

    def test_label_over_four_words_dropped(self):
        raw = {"topics": [{"label": "One Two Three Four Five", "cluster_ids": [1, 2]},
                          {"label": "One Two Three Four", "cluster_ids": [3, 4]}]}
        assert [t["label"] for t in tp.validate_topics(raw, self.IDS, 8)] == ["One Two Three Four"]

    def test_label_over_sixty_characters_dropped(self):
        long = "Abcdefghijklmnopqrstuvwxyz Abcdefghijklmnopqrstuvwxyz Abcdefgh"  # 3 words, 62 chars
        assert len(long) > 60
        assert tp.validate_topics({"topics": [{"label": long, "cluster_ids": [1, 2]}]}, self.IDS, 8) == []

    @pytest.mark.parametrize("label", ["null", "None", "N/A", "Diverse Topics", "MISCELLANEOUS",
                                       "general knowledge", "Various", "other", "Mixed"])
    def test_forbidden_labels_dropped(self, label):
        assert tp.validate_topics({"topics": [{"label": label, "cluster_ids": [1, 2]}]}, self.IDS, 8) == []

    def test_umbrella_over_sixty_percent_dropped_with_six_or_more_candidates(self):
        raw = {"topics": [{"label": "Everything", "cluster_ids": list(range(1, 8))},   # 7 of 10
                          {"label": "Birds", "cluster_ids": [1, 2]}]}
        out = tp.validate_topics(raw, self.IDS, 8)
        assert [t["label"] for t in out] == ["Birds"]  # the umbrella claimed nothing

    def test_exactly_sixty_percent_is_kept(self):
        raw = {"topics": [{"label": "Big", "cluster_ids": list(range(1, 7))}]}  # 6 of 10
        assert len(tp.validate_topics(raw, self.IDS, 8)) == 1

    def test_umbrella_rule_needs_six_candidates(self):
        ids = {1, 2, 3, 4, 5}
        raw = {"topics": [{"label": "Big", "cluster_ids": [1, 2, 3, 4]}]}
        assert len(tp.validate_topics(raw, ids, 8)) == 1


# --- the model call ----------------------------------------------------------

class _LLM:
    calls = 0

    def __init__(self, content=None, error=None):
        self.content, self.error = content, error

    async def complete(self, **kwargs):
        type(self).calls += 1
        self.kwargs = kwargs
        if self.error:
            raise self.error
        return SimpleNamespace(content=self.content, cost_usd=0.0003)


def _patch_llm(monkeypatch, llm):
    import backend.services.llm_service as ls

    _LLM.calls = 0
    monkeypatch.setattr(ls, "LLMService", lambda: llm)
    return llm


CANDS = [{"id": i, "name": f"C{i}", "pages": 10} for i in range(1, 6)]


class TestProposeTopics:
    def test_fewer_than_four_candidates_makes_no_call(self, monkeypatch):
        _patch_llm(monkeypatch, _LLM('{"topics": []}'))
        assert asyncio.run(tp.propose_topics(CANDS[:3], [], [])) == ([], 0.0)
        assert _LLM.calls == 0

    def test_prompt_carries_names_dismissed_and_candidates(self, monkeypatch):
        llm = _patch_llm(monkeypatch, _LLM(json.dumps(
            {"topics": [{"label": "Birds", "cluster_ids": [1, 2, 77]}]})))
        topics, cost = asyncio.run(tp.propose_topics(CANDS, ["science"], ["Origami Folding"], shape="topics"))
        assert topics == [{"label": "Birds", "cluster_ids": [1, 2]}] and cost == 0.0003
        prompt = llm.kwargs["prompt"]
        assert "- science" in prompt and "- Origami Folding" in prompt
        assert '{"id": 1, "name": "C1", "pages": 10}' in prompt
        assert llm.kwargs["model"] == settings.supercluster_proposal_model
        assert llm.kwargs["response_format"] == "json_object"

    def test_model_override_and_max_topics(self, monkeypatch):
        llm = _patch_llm(monkeypatch, _LLM('{"topics": []}'))
        asyncio.run(tp.propose_topics(CANDS, [], [], model="other-model", max_topics=3, shape="topics"))
        assert llm.kwargs["model"] == "other-model"
        assert "up to 3 new superclusters" in llm.kwargs["prompt"]

    @pytest.mark.parametrize("llm", [_LLM(error=RuntimeError("boom")), _LLM("not json"), _LLM("[1]")])
    def test_failed_or_malformed_call_proposes_nothing(self, monkeypatch, llm):
        _patch_llm(monkeypatch, llm)
        topics, _ = asyncio.run(tp.propose_topics(CANDS, [], []))
        assert topics == []


class TestBuildRows:
    def test_rows_carry_ids_totals_and_covered_by(self):
        rows = tp.build_rows(
            [{"label": "Applied Machine Learning", "cluster_ids": [1, 2]}],
            CANDS, ["machine learning"], lambda ids: {"n_weeks": 3},
        )
        r = rows[0]
        assert r["source"] == "proposed" and r["topic"] is None
        assert r["member_count"] == 2 and r["page_count"] == 20
        assert r["evidence"]["cluster_db_ids"] == [1, 2]
        assert r["evidence"]["covered_by"] == "machine learning"
        assert r["evidence"]["n_weeks"] == 3 and r["interest_tier"]


# --- offer rule with both source settings -----------------------------------

def _row(**over):
    g = {"id": 1, "label": "Birds", "source": "proposed", "topic": None,
         "topic_similarity": None, "interest_tier": "casual", "evidence": {"cluster_db_ids": [1, 2]},
         "member_count": 2, "page_count": 20, "cluster_ids": [1, 2], "cluster_names": ["a", "b"]}
    g.update(over)
    return g


FLOORS = dict(min_clusters=2, min_pages=15)


class TestOfferRuleSources:
    def test_proposed_row_offered_only_with_proposed_source(self):
        assert skip_reason(_row(), suggestion_source="proposed", **FLOORS) is None
        assert skip_reason(_row(), suggestion_source="groups", **FLOORS) == "not a suggestion"

    def test_suggested_row_offered_only_with_groups_source(self):
        g = _row(source="suggested")
        assert skip_reason(g, suggestion_source="groups", **FLOORS) is None
        assert skip_reason(g, suggestion_source="proposed", **FLOORS) == "not a suggestion"

    @pytest.mark.parametrize("over,reason", [
        ({"member_count": 1}, "fewer than 2 clusters"),
        ({"page_count": 14}, "fewer than 15 pages"),
        ({"evidence": {"covered_by": "birds"}}, "covered by birds"),
        ({"evidence": {"accepted_as": "Birds"}}, "accepted"),
    ])
    def test_proposed_row_reasons(self, over, reason):
        assert skip_reason(_row(**over), suggestion_source="proposed", **FLOORS) == reason

    def test_dismissed(self):
        assert skip_reason(_row(), suggestion_source="proposed", dismissed_labels={"birds"}, **FLOORS) == "dismissed"

    def test_offered_suggestions_reads_the_setting(self, monkeypatch):
        monkeypatch.setattr(settings, "label_first_enabled", False)
        groups = [_row(id=1), _row(id=2, label="Other", source="suggested")]
        monkeypatch.setattr(settings, "supercluster_suggestion_source", "proposed")
        assert [g["id"] for g in offered_suggestions(groups, {})] == [1]
        monkeypatch.setattr(settings, "supercluster_suggestion_source", "groups")
        assert [g["id"] for g in offered_suggestions(groups, {})] == [2]

    def test_defaults(self):
        # the field defaults, not the live singleton (a .env may override it)
        from backend.config.settings import Settings

        d = {n: f.default for n, f in Settings.model_fields.items()}
        assert d["supercluster_suggestion_source"] == "proposed"
        assert d["supercluster_suggestion_max_topics"] == 8
        assert d["supercluster_proposal_model"] == "gpt-4o-mini"
        assert d["supercluster_label_prompt_version"] == "v1a"
        assert d["supercluster_proposal_max_candidates"] == 120


# --- failure isolation (no DB) ----------------------------------------------

class TestStoreFailureIsolation:
    def test_exceptions_never_escape(self, monkeypatch):
        from backend.db import auth_repo

        monkeypatch.setattr(settings, "label_first_enabled", False)
        monkeypatch.setattr(settings, "supercluster_suggestion_source", "proposed")
        monkeypatch.setattr(auth_repo, "get_preferences", lambda uid: (_ for _ in ()).throw(RuntimeError("db down")))
        assert asyncio.run(tp.store_proposals_for_run(1, 5)) == {"proposed": 0}

    @pytest.mark.parametrize("flag,source", [(True, "proposed"), (False, "groups")])
    def test_skipped_in_label_first_and_groups_source(self, monkeypatch, flag, source):
        from backend.db import auth_repo

        monkeypatch.setattr(settings, "label_first_enabled", flag)
        monkeypatch.setattr(settings, "supercluster_suggestion_source", source)
        monkeypatch.setattr(auth_repo, "get_preferences", lambda uid: (_ for _ in ()).throw(AssertionError("touched")))
        assert asyncio.run(tp.store_proposals_for_run(1, 5)) == {"proposed": 0}

    def test_recluster_hook_survives_a_failing_proposal_call(self, monkeypatch):
        from backend.db import auth_repo, cluster_repo

        monkeypatch.setattr(settings, "label_first_enabled", False)
        monkeypatch.setattr(settings, "supercluster_suggestion_source", "proposed")
        monkeypatch.setattr(auth_repo, "get_preferences", lambda uid: {"topic_interests": []})
        monkeypatch.setattr(cluster_repo, "get_clusters_for_user",
                            lambda uid, run: [_cluster(i, f"C{i}") for i in range(1, 6)])
        saved = []
        monkeypatch.setattr(cluster_repo, "save_super_cluster_groups", lambda *a: saved.append(a))
        _patch_llm(monkeypatch, _LLM(error=RuntimeError("api down")))
        out = asyncio.run(tp.store_proposals_for_run(1, 5))
        assert out["proposed"] == 0 and saved == []


class TestTimeoutAndRecluster:
    def test_slow_call_times_out_and_proposes_nothing(self, monkeypatch):
        import backend.services.llm_service as ls

        class Slow:
            async def complete(self, **kw):
                await asyncio.sleep(5)

        monkeypatch.setattr(ls, "LLMService", lambda: Slow())
        monkeypatch.setattr(settings, "supercluster_proposal_timeout_seconds", 0.05)
        assert asyncio.run(tp.propose_topics(CANDS, [], [])) == ([], 0.0)

    def test_timeout_setting_default(self):
        assert settings.supercluster_proposal_timeout_seconds == 30.0

    def test_source_setting_rejects_a_misspelling(self):
        from pydantic import ValidationError

        from backend.config.settings import Settings

        with pytest.raises(ValidationError):
            Settings(supercluster_suggestion_source="proposd")

    def test_recluster_all_proposes_before_completing_the_run(self):
        """Fails if the proposal call is removed from recluster_all, or moved
        after complete_run (the run would be marked complete without it)."""
        import inspect

        from backend.services.clustering_service import ClusteringService

        src = inspect.getsource(ClusteringService.recluster_all)
        call = src.index("await store_proposals_for_run(user_id, run_id)")
        # the main path's complete_run is the last one; early-exit paths come first
        assert call < src.rindex("recluster_repo.complete_run(")
        assert call > src.index("assign_super_clusters_hybrid")


# --- shape "fields": one field per cluster, grouped server-side ---------------

class TestParseAndGroupFields:
    IDS = {1, 2, 3, 4, 5}

    def test_parses_valid_entries(self):
        raw = {"fields": [{"id": 1, "field": " Cooking "}, {"id": 2, "field": "Cooking"}]}
        assert tp.parse_fields(raw, self.IDS) == {1: "Cooking", 2: "Cooking"}

    def test_bad_ids_dropped(self):
        raw = {"fields": [{"id": 99, "field": "A"}, {"id": "2", "field": "A"}, {"id": True, "field": "A"},
                          {"id": None, "field": "A"}, {"field": "A"}, "x", 3]}
        assert tp.parse_fields(raw, self.IDS) == {}

    @pytest.mark.parametrize("field", [None, 5, ["Cooking"], "", "   ", "null", "NULL", "None"])
    def test_unusable_fields_dropped(self, field):
        assert tp.parse_fields({"fields": [{"id": 1, "field": field}]}, self.IDS) == {}

    def test_duplicate_ids_first_wins_even_when_first_is_null(self):
        raw = {"fields": [{"id": 1, "field": "Cooking"}, {"id": 1, "field": "Outdoors"},
                          {"id": 2, "field": None}, {"id": 2, "field": "Outdoors"}]}
        assert tp.parse_fields(raw, self.IDS) == {1: "Cooking"}

    @pytest.mark.parametrize("raw", [None, [], "x", {"fields": "x"}, {"topics": []}])
    def test_malformed_shapes_yield_nothing(self, raw):
        assert tp.parse_fields(raw, self.IDS) == {}

    def test_group_by_casefolded_trimmed_field_first_spelling_wins(self):
        out = tp.group_fields({1: "Literature", 2: "literature", 3: "Cooking"})
        assert out == {"topics": [{"label": "Literature", "cluster_ids": [1, 2]},
                                  {"label": "Cooking", "cluster_ids": [3]}]}

    def test_singletons_do_not_become_topics(self):
        raw = {"fields": [{"id": 1, "field": "Literature"}, {"id": 2, "field": "literature"},
                          {"id": 3, "field": "Cooking"}]}
        ids = {1, 2, 3, 4, 5, 6, 7}
        topics = tp.validate_topics(tp.group_fields(tp.parse_fields(raw, ids)), ids, 8)
        assert topics == [{"label": "Literature", "cluster_ids": [1, 2]}]

    def test_grouped_fields_go_through_the_same_validation(self):
        ids = set(range(1, 11))
        fields = {i: "Everything" for i in range(1, 8)} | {8: "Birds", 9: "birds", 10: "Other"}
        topics = tp.validate_topics(tp.group_fields(fields), ids, 8)
        assert topics == [{"label": "Birds", "cluster_ids": [8, 9]}]  # umbrella and "Other" dropped


class TestFieldsShapeEndToEnd:
    def test_propose_topics_with_fields_shape(self, monkeypatch):
        llm = _patch_llm(monkeypatch, _LLM(json.dumps({"fields": [
            {"id": 1, "field": "Birds"}, {"id": 2, "field": "birds"}, {"id": 3, "field": None},
            {"id": 4, "field": "Kites"}, {"id": 5, "field": "Lone"}]})))
        topics, cost = asyncio.run(tp.propose_topics(CANDS, ["science"], ["Origami Folding"], shape="fields"))
        assert topics == [{"label": "Birds", "cluster_ids": [1, 2]}] and cost == 0.0003
        assert "one entry per cluster" in llm.kwargs["prompt"] or "EVERY" in llm.kwargs["prompt"]
        assert "- Origami Folding" in llm.kwargs["prompt"]

    def test_shape_comes_from_settings_by_default(self, monkeypatch):
        llm = _patch_llm(monkeypatch, _LLM('{"fields": []}'))
        monkeypatch.setattr(settings, "supercluster_proposal_shape", "topics")
        asyncio.run(tp.propose_topics(CANDS, [], []))
        assert "Propose up to" in llm.kwargs["prompt"]
        monkeypatch.setattr(settings, "supercluster_proposal_shape", "fields")
        asyncio.run(tp.propose_topics(CANDS, [], []))
        assert "For EVERY cluster" in llm.kwargs["prompt"]

    def test_shape_setting_default_and_validation(self):
        from pydantic import ValidationError

        from backend.config.settings import Settings

        from backend.config.settings import Settings

        assert Settings.model_fields["supercluster_proposal_shape"].default == "fields"
        with pytest.raises(ValidationError):
            Settings(supercluster_proposal_shape="field")


# --- hardening round: label set, grouping key, merge-then-umbrella ----------

class TestLabelSetAndKeys:
    IDS = set(range(1, 11))

    @pytest.mark.parametrize("label", ["Misc", "uncategorized", "Unknown", "General", "OTHERS",
                                       "Random", "Stuff", "Everything Else", "Misc."])
    def test_more_catch_all_labels_dropped(self, label):
        assert tp.validate_topics({"topics": [{"label": label, "cluster_ids": [1, 2]}]}, self.IDS) == []

    @pytest.mark.parametrize("label", ["X", "7", "3D", "--", "9 9"])
    def test_label_needs_two_letters(self, label):
        assert tp.validate_topics({"topics": [{"label": label, "cluster_ids": [1, 2]}]}, self.IDS) == []

    def test_two_letter_label_is_fine(self):
        assert len(tp.validate_topics({"topics": [{"label": "AI", "cluster_ids": [1, 2]}]}, self.IDS)) == 1

    def test_min_clusters_follows_the_caller(self):
        raw = {"topics": [{"label": "Cooking", "cluster_ids": [1]}]}
        assert tp.validate_topics(raw, self.IDS) == []
        assert [t["label"] for t in tp.validate_topics(raw, self.IDS, min_clusters=1)] == ["Cooking"]

    @pytest.mark.parametrize("a,b", [("Health & Fitness", "Health and Fitness"),
                                     ("Sci-Fi", "Sci Fi"), ("Cooking", "Cooking.")])
    def test_label_variants_group_together(self, a, b):
        assert tp.label_key(a) == tp.label_key(b)
        grouped = tp.group_fields({1: a, 2: b, 3: "Birds"})
        assert grouped["topics"][0] == {"label": a, "cluster_ids": [1, 2]}  # first spelling wins

    @pytest.mark.parametrize("a,b", [("Health & Fitness", "Health and Fitness"),
                                     ("Sci-Fi", "Sci Fi"), ("Cooking", "Cooking.")])
    def test_label_variants_merge_in_validation(self, a, b):
        raw = {"topics": [{"label": a, "cluster_ids": [1]}, {"label": b, "cluster_ids": [2]}]}
        assert tp.validate_topics(raw, self.IDS) == [{"label": a, "cluster_ids": [1, 2]}]

    def test_umbrella_check_runs_after_the_merge(self):
        # two case variants of 40 percent each would merge to 80 percent
        raw = {"topics": [{"label": "Everything", "cluster_ids": [1, 2, 3, 4]},
                          {"label": "EVERYTHING", "cluster_ids": [5, 6, 7, 8]},
                          {"label": "Birds", "cluster_ids": [9, 10]}]}
        assert [t["label"] for t in tp.validate_topics(raw, self.IDS)] == ["Birds"]

    def test_merged_topic_under_the_umbrella_share_survives(self):
        raw = {"topics": [{"label": "Birds", "cluster_ids": [1, 2]},
                          {"label": "birds", "cluster_ids": [3, 4]}]}
        assert tp.validate_topics(raw, self.IDS) == [{"label": "Birds", "cluster_ids": [1, 2, 3, 4]}]


def _cands(pages):
    return [{"id": i + 1, "name": f"C{i + 1}", "pages": p} for i, p in enumerate(pages)]


class TestRankAndCap:
    KW = dict(min_clusters=2, min_pages=15)

    def test_twelve_valid_groups_keep_the_eight_largest(self):
        cands = _cands([10] * 24)
        for g in range(12):
            cands[2 * g]["pages"] = 10 + g          # group g totals 20 + g pages
        topics = [{"label": f"Field {g:02d}", "cluster_ids": [2 * g + 1, 2 * g + 2]} for g in range(12)]
        out = tp.rank_and_cap(topics, cands, [], [], 8, **self.KW)
        assert [t["label"] for t in out] == [f"Field {g:02d}" for g in range(11, 3, -1)]

    def test_under_floor_or_covered_groups_never_take_a_slot(self):
        cands = _cands([30, 30, 5, 5, 40, 40, 20, 20, 99, 99])
        topics = [
            {"label": "Tiny", "cluster_ids": [3, 4]},                 # 10 pages: under the page floor
            {"label": "Lonely", "cluster_ids": [9]},                  # one cluster
            {"label": "Computer Science", "cluster_ids": [9, 10]},    # covered by "science"
            {"label": "Hush", "cluster_ids": [7, 8]},                 # dismissed
            {"label": "Birds", "cluster_ids": [1, 2]},                # 60 pages
            {"label": "Kites", "cluster_ids": [5, 6]},                # 80 pages
        ]
        out = tp.rank_and_cap(topics, cands, ["science"], ["hush"], 2, **self.KW)
        assert [t["label"] for t in out] == ["Kites", "Birds"]

    def test_ties_break_by_cluster_count_then_label(self):
        cands = _cands([10, 10, 10, 10, 20, 20])
        topics = [{"label": "Zed", "cluster_ids": [5, 6]},             # 40 pages, 2 clusters
                  {"label": "Beta", "cluster_ids": [1, 2, 3, 4]},      # 40 pages, 4 clusters
                  {"label": "Alpha", "cluster_ids": [1, 2]}]           # 20 pages
        out = tp.rank_and_cap(topics, cands, [], [], 8, **self.KW)
        assert [t["label"] for t in out] == ["Beta", "Zed", "Alpha"]

    def test_label_breaks_a_full_tie(self):
        cands = _cands([10, 10, 10, 10])
        topics = [{"label": "Zed", "cluster_ids": [1, 2]}, {"label": "Alpha", "cluster_ids": [3, 4]}]
        out = tp.rank_and_cap(topics, cands, [], [], 8, **self.KW)
        assert [t["label"] for t in out] == ["Alpha", "Zed"]

    def test_propose_topics_ranks_before_capping(self, monkeypatch):
        cands = [{"id": i, "name": f"C{i}", "pages": 10 + (30 if i > 8 else 0)} for i in range(1, 13)]
        answer = {"fields": [{"id": i, "field": f"Field {'ABCDEF'[(i - 1) // 2]}x"} for i in range(1, 13)]}
        _patch_llm(monkeypatch, _LLM(json.dumps(answer)))
        topics, _ = asyncio.run(tp.propose_topics(cands, [], [], max_topics=2, shape="fields"))
        # the later, larger groups win the two slots over the first two in output order
        assert [t["label"] for t in topics] == ["Field Ex", "Field Fx"]


class TestCandidateCap:
    def test_only_the_largest_candidates_are_sent_and_the_cap_is_logged(self, monkeypatch, caplog):
        import logging

        monkeypatch.setattr(settings, "supercluster_proposal_max_candidates", 5)
        cands = [{"id": i, "name": f"C{i}", "pages": i} for i in range(1, 9)]
        llm = _patch_llm(monkeypatch, _LLM('{"fields": []}'))
        with caplog.at_level(logging.INFO, logger="backend.services.topic_proposals"):
            asyncio.run(tp.propose_topics(cands, [], [], shape="fields"))
        sent = json.loads(llm.kwargs["prompt"].split("CLUSTERS (JSON):\n")[1].split("\n\n")[0])
        assert [c["id"] for c in sent] == [8, 7, 6, 5, 4]
        assert "3 of 8 candidate clusters left out" in caplog.text

    def test_max_tokens_scale_with_the_number_sent_with_a_floor(self, monkeypatch):
        small = _patch_llm(monkeypatch, _LLM('{"fields": []}'))
        asyncio.run(tp.propose_topics(CANDS, [], [], shape="fields"))
        assert small.kwargs["max_tokens"] == 2000
        many = [{"id": i, "name": f"C{i}", "pages": 5} for i in range(1, 121)]
        big = _patch_llm(monkeypatch, _LLM('{"fields": []}'))
        asyncio.run(tp.propose_topics(many, [], [], shape="fields"))
        assert big.kwargs["max_tokens"] == 30 * 120 + 500
