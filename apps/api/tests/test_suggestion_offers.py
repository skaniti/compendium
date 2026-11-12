"""The shared "is this group offered as a suggestion" rule
(backend/services/suggestion_offers.py): every reason, the near-duplicate
rule, ordering, and the label-first path. Pure functions, synthetic data."""

import pytest

from backend.config.settings import settings
from backend.services.suggestion_offers import (
    covering_keyword,
    is_offered,
    offer_reason,
    offered_suggestions,
    skip_reason,
)

FLOORS = dict(min_clusters=2, min_pages=15)


@pytest.fixture(autouse=True)
def _groups_source(monkeypatch):
    """These tests cover the embedding-groups candidate source; the default
    source is "proposed" (see test_topic_proposals.py)."""
    from backend.config.settings import settings

    monkeypatch.setattr(settings, "supercluster_suggestion_source", "groups")


def _group(**over):
    g = {
        "id": 1, "label": "Fiber Crafts", "source": "suggested", "topic": None,
        "topic_similarity": 0.2, "interest_tier": "recurrent", "evidence": {},
        "member_count": 3, "page_count": 20, "cluster_ids": [1, 2, 3],
        "cluster_names": ["a", "b", "c"],
    }
    g.update(over)
    return g


class TestSkipReason:
    def test_offered_when_everything_passes(self):
        assert skip_reason(_group(), **FLOORS) is None
        assert is_offered(_group(), **FLOORS)

    def test_one_cluster_group_never_offered(self):
        assert skip_reason(_group(member_count=1, page_count=200), **FLOORS) == (
            "fewer than 2 clusters"
        )

    def test_page_floor(self):
        assert skip_reason(_group(page_count=14), **FLOORS) == "fewer than 15 pages"
        assert skip_reason(_group(page_count=15), **FLOORS) is None

    def test_cluster_floor_boundary(self):
        assert skip_reason(_group(member_count=2), **FLOORS) is None

    def test_floors_are_parameters(self):
        assert skip_reason(_group(member_count=1), min_clusters=1, min_pages=15) is None

    def test_no_single_field(self):
        g = _group(evidence={"no_single_field": True})
        assert skip_reason(g, **FLOORS) == "no single field"

    def test_covered_by(self):
        g = _group(evidence={"covered_by": "science"})
        assert skip_reason(g, **FLOORS) == "covered by science"

    def test_dismissed_label_case_insensitive(self):
        g = _group(label="Fiber Crafts")
        assert skip_reason(g, dismissed_labels={"fiber crafts"}, **FLOORS) == "dismissed"

    @pytest.mark.parametrize("source", ["keyword", "accepted", "dismissed"])
    def test_other_sources_are_not_suggestions(self, source):
        assert skip_reason(_group(source=source), **FLOORS) == "not a suggestion"

    def test_missing_evidence_and_counts_do_not_crash(self):
        g = _group(evidence=None, member_count=None)
        assert skip_reason(g, **FLOORS) == "fewer than 2 clusters"


class TestLabelFirst:
    def _taxonomy(self, **over):
        fields = dict(source="taxonomy", topic="literature", topic_similarity=None)
        fields.update(over)
        return _group(**fields)

    def test_undeclared_taxonomy_group_offered_only_in_label_first(self):
        assert skip_reason(self._taxonomy(), label_first=True, **FLOORS) is None
        assert skip_reason(self._taxonomy(), label_first=False, **FLOORS) == "not a suggestion"

    def test_declared_taxonomy_group_not_offered(self):
        g = self._taxonomy(topic="Literature", topic_similarity=1.0)
        assert skip_reason(g, label_first=True, **FLOORS) == "not a suggestion"

    def test_taxonomy_group_obeys_size_floor_and_dismissal(self):
        assert skip_reason(self._taxonomy(page_count=3), label_first=True, **FLOORS) == (
            "fewer than 15 pages"
        )
        assert skip_reason(
            self._taxonomy(), label_first=True, dismissed_labels={"fiber crafts"}, **FLOORS
        ) == "dismissed"


class TestCoveringKeyword:
    @pytest.mark.parametrize(
        "label,keyword",
        [
            ("Machine Learning", "machine learning"),   # equal ignoring case
            ("  Zoology ", "zoology"),                  # surrounding whitespace
            ("Computer Science", "science"),            # keyword is the trailing word
            ("Applied Machine Learning", "machine learning"),  # trailing words
            ("3D-Printing", "3d printing"),             # equal once non-alphanumerics go
            ("Science!", "science"),
            ("Straße", "STRASSE"),                      # casefold, not lower
            ("Ünïcode Tópic", "ünïcode tópic"),         # identical non-ASCII names
            ("Applied Science,", "science"),            # punctuation at token edges
        ],
    )
    def test_covered(self, label, keyword):
        assert covering_keyword(label, ["astronomy", keyword]) == keyword

    @pytest.mark.parametrize(
        "label,keyword",
        [
            ("Science Fiction", "science"),                    # leading word: a different field
            ("Machine Learning Models", "machine learning"),   # keyword leads the label
            ("Non-Fiction", "fiction"),                        # the hyphen joins one word
            ("Artisan Bread", "art"),                          # substring, not whole word
            ("Science", "Computer Science"),                   # label shorter than keyword
            ("Literature", "science"),
            ("???", "science"),                                # nothing alphanumeric
        ],
    )
    def test_not_covered(self, label, keyword):
        assert covering_keyword(label, [keyword]) is None

    def test_empty_inputs(self):
        assert covering_keyword("", ["science"]) is None
        assert covering_keyword("Science", []) is None
        assert covering_keyword("Science", ["", "  ", "!!"]) is None


class TestReadTimeCoverage:
    def test_a_keyword_added_by_hand_hides_the_suggestion_at_once(self, monkeypatch):
        monkeypatch.setattr(settings, "label_first_enabled", False)
        groups = [_group(id=1, label="Fiber Crafts"), _group(id=2, label="Birds")]
        assert len(offered_suggestions(groups, {})) == 2
        prefs = {"topic_interests": [{"keyword": "fiber crafts", "icon_id": "x"}]}
        assert [g["label"] for g in offered_suggestions(groups, prefs)] == ["Birds"]
        assert offer_reason(groups[0], prefs) == "covered by fiber crafts"

    def test_offer_reason_none_when_offered(self, monkeypatch):
        monkeypatch.setattr(settings, "label_first_enabled", False)
        assert offer_reason(_group(), {}) is None

    def test_bare_string_topic_entries_are_tolerated(self, monkeypatch):
        monkeypatch.setattr(settings, "label_first_enabled", False)
        assert offer_reason(_group(), {"topic_interests": ["fiber crafts", None]}) is not None


class TestOfferedSuggestions:
    def test_orders_by_tier_then_pages_and_filters(self, monkeypatch):
        monkeypatch.setattr(settings, "label_first_enabled", False)
        groups = [
            _group(id=1, label="Casual Big", interest_tier="casual", page_count=90),
            _group(id=2, label="Recurrent Small", interest_tier="recurrent", page_count=20),
            _group(id=3, label="Recurrent Big", interest_tier="recurrent", page_count=60),
            _group(id=4, label="Too Few Clusters", member_count=1),
            _group(id=5, label="Grab Bag", evidence={"no_single_field": True}),
            _group(id=6, label="Gone", source="dismissed"),
            _group(id=7, label="Hidden Now"),
        ]
        prefs = {"dismissed_topics": [{"label": "hidden now"}]}
        offered = offered_suggestions(groups, prefs)
        assert [g["label"] for g in offered] == ["Recurrent Big", "Recurrent Small", "Casual Big"]

    def test_one_row_per_label(self, monkeypatch):
        monkeypatch.setattr(settings, "label_first_enabled", False)
        groups = [_group(id=1, page_count=30), _group(id=2, label="fiber crafts", page_count=20)]
        assert [g["id"] for g in offered_suggestions(groups, {})] == [1]

    def test_reads_floors_from_settings(self, monkeypatch):
        monkeypatch.setattr(settings, "label_first_enabled", False)
        monkeypatch.setattr(settings, "supercluster_suggestion_min_pages", 50)
        assert offered_suggestions([_group(page_count=20)], {}) == []
        monkeypatch.setattr(settings, "supercluster_suggestion_min_pages", 10)
        assert len(offered_suggestions([_group(page_count=20)], {})) == 1

    def test_label_first_flag_switches_taxonomy_offers_on(self, monkeypatch):
        tax = _group(source="taxonomy", topic="games", topic_similarity=None, label="Games")
        monkeypatch.setattr(settings, "label_first_enabled", False)
        assert offered_suggestions([tax], {}) == []
        monkeypatch.setattr(settings, "label_first_enabled", True)
        assert [g["label"] for g in offered_suggestions([tax], {})] == ["Games"]

    def test_defaults(self):
        assert settings.supercluster_suggestion_min_clusters == 2
        assert settings.supercluster_suggestion_min_pages == 15
