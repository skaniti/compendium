"""Pure spend / supercluster shaping for the Overview view (no DB)."""

from backend.services import overview_summary as os_


def test_purpose_map_and_unknown_is_other():
    assert os_.purpose_of("skip_gate") == "gates"
    assert os_.purpose_of("skip_gate_deterministic") == "gates"
    assert os_.purpose_of("learning_gate") == "gates"
    assert os_.purpose_of("regate") == "gates"
    for t in (
        "cluster_naming",
        "group_naming",
        "clustering_embedding",
        "topic_verify",
        "keyword_expansion",
        "embedding_gist",
    ):
        assert os_.purpose_of(t) == "clustering"
    assert os_.purpose_of("agent_query") == "chat"
    assert os_.purpose_of("skip_category_backfill") == "other"
    assert os_.purpose_of("brand_new_thing") == "other"


def test_labels():
    assert os_.event_label("agent_query") == "Chat answers"
    assert os_.event_label("brand_new_thing") == "Brand New Thing"
    assert dict(os_.PURPOSES) == {
        "gates": "Skip & learning gates",
        "clustering": "Clustering & naming",
        "chat": "Chat",
        "other": "Other",
    }


def test_build_spend_groups_orders_and_rounds():
    rows = [
        ("agent_query", 0.2321, 250),
        ("skip_gate", 0.59324159, 2900),
        ("learning_gate", 0.0168, 100),
        ("skip_gate_deterministic", 0.0, 12),
        ("cluster_naming", 0.1475, 40),
    ]
    s = os_.build_spend(rows, all_time_usd=2.5)
    assert [p["key"] for p in s["purposes"]] == ["gates", "clustering", "chat"]
    gates = s["purposes"][0]
    assert gates["calls"] == 2900 + 100 + 12
    assert gates["usd"] == round(0.59324159 + 0.0168, 6)
    assert [t["key"] for t in gates["event_types"]] == [
        "skip_gate",
        "learning_gate",
        "skip_gate_deterministic",
    ]
    assert gates["event_types"][0]["usd"] == 0.593242
    assert s["calls"] == 2900 + 100 + 12 + 40 + 250
    assert s["usd"] == round(0.59324159 + 0.0168 + 0.1475 + 0.2321, 6)
    assert s["all_time_usd"] == 2.5


def test_build_spend_empty():
    assert os_.build_spend([], all_time_usd=0.0) == {
        "usd": 0.0,
        "calls": 0,
        "all_time_usd": 0.0,
        "purposes": [],
    }


def test_zero_cost_calls_still_listed():
    s = os_.build_spend([("skip_gate_deterministic", 0.0, 5)], all_time_usd=0.0)
    assert s["purposes"][0]["key"] == "gates" and s["purposes"][0]["calls"] == 5 and s["usd"] == 0.0


def test_graph_superclusters_count_topic_labels_only():
    sc_map = {"a": "Cooking", "b": "Cooking", "c": "Physics", "d": "Suggested Group", "e": None}
    assert os_.count_graph_superclusters(sc_map, ["Cooking", "Physics", "Unused"]) == 2
    assert os_.count_graph_superclusters({}, ["Cooking"]) == 0
