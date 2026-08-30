"""Tests for knowledge graph Pydantic models."""

import json

import pytest

from backend.models.graph import (
    GraphEdge,
    GraphNode,
    KnowledgeGraph,
    TopicTag,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_nodes():
    """A small hierarchy: root -> 2 topics -> 2 leaves."""
    root = GraphNode(id="root", label="Knowledge", level=0)
    topic_a = GraphNode(
        id="topic_a",
        label="Black Holes",
        level=1,
        parent_id="root",
        capture_ids=["s1"],
        visit_count=3,
    )
    topic_b = GraphNode(
        id="topic_b",
        label="Coffee Culture",
        level=1,
        parent_id="root",
        capture_ids=["s2"],
        visit_count=1,
    )
    leaf_a1 = GraphNode(
        id="leaf_a1",
        label="Event Horizon",
        level=2,
        parent_id="topic_a",
        page_urls=["https://en.wikipedia.org/wiki/Event_horizon"],
        capture_ids=["s1"],
    )
    leaf_a2 = GraphNode(
        id="leaf_a2",
        label="Hawking Radiation",
        level=2,
        parent_id="topic_a",
        page_urls=["https://en.wikipedia.org/wiki/Hawking_radiation"],
        capture_ids=["s1"],
    )
    # Wire up children
    root.children_ids = ["topic_a", "topic_b"]
    topic_a.children_ids = ["leaf_a1", "leaf_a2"]
    return [root, topic_a, topic_b, leaf_a1, leaf_a2]


@pytest.fixture
def sample_edges():
    return [
        GraphEdge(source_id="root", target_id="topic_a"),
        GraphEdge(source_id="root", target_id="topic_b"),
        GraphEdge(source_id="topic_a", target_id="leaf_a1"),
        GraphEdge(source_id="topic_a", target_id="leaf_a2"),
        GraphEdge(
            source_id="topic_a",
            target_id="topic_b",
            edge_type="cross_link",
            weight=0.3,
        ),
    ]


@pytest.fixture
def sample_graph(sample_nodes, sample_edges):
    return KnowledgeGraph(
        nodes=sample_nodes,
        edges=sample_edges,
    )


# ---------------------------------------------------------------------------
# Model creation
# ---------------------------------------------------------------------------


class TestModelCreation:
    def test_node_defaults(self):
        node = GraphNode(id="n1", label="Test")
        assert node.level == 0
        assert node.parent_id is None
        assert node.children_ids == []
        assert node.visit_count == 1
        assert node.x is None

    def test_edge_defaults(self):
        edge = GraphEdge(source_id="a", target_id="b")
        assert edge.edge_type == "parent_child"
        assert edge.weight == 1.0

    def test_topic_tag_creation(self):
        tag = TopicTag(label="Black Holes", node_id="black_holes")
        assert tag.label == "Black Holes"
        assert tag.node_id == "black_holes"

    def test_topic_tag_serialization(self):
        tag = TopicTag(label="Physics", node_id="physics")
        d = tag.model_dump()
        assert d == {"label": "Physics", "node_id": "physics"}
        restored = TopicTag.model_validate(d)
        assert restored == tag

    def test_empty_graph(self):
        graph = KnowledgeGraph()
        assert graph.nodes == []
        assert graph.edges == []


# ---------------------------------------------------------------------------
# JSON round-trip
# ---------------------------------------------------------------------------


class TestJsonRoundTrip:
    def test_graph_serialization(self, sample_graph):
        json_str = sample_graph.model_dump_json()
        restored = KnowledgeGraph.model_validate_json(json_str)
        assert len(restored.nodes) == len(sample_graph.nodes)
        assert len(restored.edges) == len(sample_graph.edges)

    def test_graph_dict_roundtrip(self, sample_graph):
        d = sample_graph.model_dump()
        restored = KnowledgeGraph.model_validate(d)
        assert restored.nodes[0].id == sample_graph.nodes[0].id

    def test_json_parseable(self, sample_graph):
        """Ensure model_dump_json produces valid JSON."""
        raw = sample_graph.model_dump_json()
        parsed = json.loads(raw)
        assert "nodes" in parsed
        assert "edges" in parsed


# ---------------------------------------------------------------------------
# Helper methods
# ---------------------------------------------------------------------------


class TestHelperMethods:
    def test_get_node_found(self, sample_graph):
        node = sample_graph.get_node("topic_a")
        assert node is not None
        assert node.label == "Black Holes"

    def test_get_node_not_found(self, sample_graph):
        assert sample_graph.get_node("nonexistent") is None

    def test_get_children(self, sample_graph):
        children = sample_graph.get_children("topic_a")
        assert len(children) == 2
        labels = {c.label for c in children}
        assert labels == {"Event Horizon", "Hawking Radiation"}

    def test_get_children_leaf(self, sample_graph):
        """Leaf nodes have no children."""
        children = sample_graph.get_children("leaf_a1")
        assert children == []

    def test_get_subtree(self, sample_graph):
        subtree = sample_graph.get_subtree("topic_a")
        ids = {n.id for n in subtree}
        assert ids == {"topic_a", "leaf_a1", "leaf_a2"}

    def test_get_subtree_root(self, sample_graph):
        subtree = sample_graph.get_subtree("root")
        assert len(subtree) == 5  # root + 2 topics + 2 leaves


# ---------------------------------------------------------------------------
# D3 JSON output
# ---------------------------------------------------------------------------


class TestD3Json:
    def test_d3_json_shape(self, sample_graph):
        d3 = sample_graph.to_d3_json()
        assert "nodes" in d3
        assert "links" in d3
        assert isinstance(d3["nodes"], list)
        assert isinstance(d3["links"], list)

    def test_d3_node_fields(self, sample_graph):
        d3 = sample_graph.to_d3_json()
        node = d3["nodes"][0]
        assert "id" in node
        assert "label" in node
        assert "level" in node
        assert "visit_count" in node

    def test_d3_link_fields(self, sample_graph):
        d3 = sample_graph.to_d3_json()
        link = d3["links"][0]
        assert "source" in link
        assert "target" in link
        assert "type" in link
        assert "weight" in link

    def test_d3_node_count(self, sample_graph):
        d3 = sample_graph.to_d3_json()
        assert len(d3["nodes"]) == 5

    def test_d3_link_count(self, sample_graph):
        d3 = sample_graph.to_d3_json()
        assert len(d3["links"]) == 5

    def test_d3_position_hints(self):
        """Nodes with x/y should include them in D3 output."""
        node = GraphNode(id="n1", label="Test", x=100.5, y=200.3)
        graph = KnowledgeGraph(nodes=[node])
        d3 = graph.to_d3_json()
        assert d3["nodes"][0]["x"] == 100.5
        assert d3["nodes"][0]["y"] == 200.3

    def test_d3_no_position_hints(self):
        """Nodes without x/y should omit them from D3 output."""
        node = GraphNode(id="n1", label="Test")
        graph = KnowledgeGraph(nodes=[node])
        d3 = graph.to_d3_json()
        assert "x" not in d3["nodes"][0]
        assert "y" not in d3["nodes"][0]
