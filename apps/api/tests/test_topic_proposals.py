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
        out = tp.validate_topics({"topics": [{"label": "A", "cluster_ids": [1, 99]}]}, self.IDS, 8)
        assert out == []

    def test_cluster_claimed_twice_goes_to_first_topic(self):
        raw = {"topics": [{"label": "A", "cluster_ids": [1, 2]},
                          {"label": "B", "cluster_ids": [2, 3, 4]}]}
        out = tp.validate_topics(raw, self.IDS, 8)
        assert out == [{"label": "A", "cluster_ids": [1, 2]}, {"label": "B", "cluster_ids": [3, 4]}]

    def test_topic_left_with_one_cluster_after_dedup_is_dropped(self):
        raw = {"topics": [{"label": "A", "cluster_ids": [1, 2]}, {"label": "B", "cluster_ids": [2, 3]}]}
        assert [t["label"] for t in tp.validate_topics(raw, self.IDS, 8)] == ["A"]

    def test_empty_or_missing_label_dropped(self):
        raw = {"topics": [{"label": "  ", "cluster_ids": [1, 2]}, {"cluster_ids": [3, 4]},
                          {"label": None, "cluster_ids": [5, 6]}]}
        assert tp.validate_topics(raw, self.IDS, 8) == []

    def test_cap_at_max_topics(self):
        raw = {"topics": [{"label": "A", "cluster_ids": [1, 2]}, {"label": "B", "cluster_ids": [3, 4]},
                          {"label": "C", "cluster_ids": [5, 6]}]}
        assert [t["label"] for t in tp.validate_topics(raw, self.IDS, 2)] == ["A", "B"]

    def test_duplicate_ids_within_topic_counted_once(self):
        assert tp.validate_topics({"topics": [{"label": "A", "cluster_ids": [1, 1]}]}, self.IDS, 8) == []

    @pytest.mark.parametrize("raw", [None, [], "x", {"topics": "x"}, {"topics": [1, "a", None]},
                                     {"topics": [{"label": "A", "cluster_ids": "1,2"}]},
                                     {"topics": [{"label": "A", "cluster_ids": [True, "2"]}]}])
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


CANDS = [{"id": i, "name": f"C{i}", "pages": 5} for i in range(1, 6)]


class TestProposeTopics:
    def test_fewer_than_four_candidates_makes_no_call(self, monkeypatch):
        _patch_llm(monkeypatch, _LLM('{"topics": []}'))
        assert asyncio.run(tp.propose_topics(CANDS[:3], [], [])) == ([], 0.0)
        assert _LLM.calls == 0

    def test_prompt_carries_names_dismissed_and_candidates(self, monkeypatch):
        llm = _patch_llm(monkeypatch, _LLM(json.dumps(
            {"topics": [{"label": "Birds", "cluster_ids": [1, 2, 77]}]})))
        topics, cost = asyncio.run(tp.propose_topics(CANDS, ["science"], ["Origami Folding"]))
        assert topics == [{"label": "Birds", "cluster_ids": [1, 2]}] and cost == 0.0003
        prompt = llm.kwargs["prompt"]
        assert "- science" in prompt and "- Origami Folding" in prompt
        assert '{"id": 1, "name": "C1", "pages": 5}' in prompt
        assert llm.kwargs["model"] == settings.supercluster_proposal_model
        assert llm.kwargs["response_format"] == "json_object"

    def test_model_override_and_max_topics(self, monkeypatch):
        llm = _patch_llm(monkeypatch, _LLM('{"topics": []}'))
        asyncio.run(tp.propose_topics(CANDS, [], [], model="other-model", max_topics=3))
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
        assert r["member_count"] == 2 and r["page_count"] == 10
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
        assert settings.supercluster_suggestion_source == "proposed"
        assert settings.supercluster_suggestion_max_topics == 8
        assert settings.supercluster_proposal_model == "gpt-4o-mini"
        assert settings.supercluster_label_prompt_version == "v1a"


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
