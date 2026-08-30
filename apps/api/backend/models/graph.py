"""Knowledge graph models for the compendium visualization."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class TopicTag(BaseModel):
    """A topic tag linking a display label to a graph node."""

    label: str = Field(..., description="Display text (e.g. 'Black Holes')")
    node_id: str = Field(..., description="Links to GraphNode.id (e.g. 'black_holes')")


class GraphNode(BaseModel):
    """A node in the knowledge graph representing a topic or page."""

    id: str = Field(..., description="Unique node identifier")
    label: str = Field(..., description="Display label for the node")
    level: int = Field(
        0,
        description="Node depth: 1=page (flat model). 0-3 range kept for backward compat.",
        ge=0,
        le=3,
    )
    kind: str = Field(
        "cluster",
        description=(
            "Page-grouping kind. "
            "'cluster' -- page belongs to a multi-page HDBSCAN cluster "
            "(parent_id is the real cluster slug). "
            "'singleton' -- page is a featured starfield singleton (HDBSCAN "
            "noise selected by outlier_score + spatial diversity; rendered "
            "with page-title label and lighter LOD; not LLM-named). "
            "parent_id is a per-page faux-cluster slug '_solo_<page_id>' "
            "so the force layout scatters it instead of bucketing. "
            "'unclustered' -- page didn't cluster and wasn't featured. "
            "parent_id is also a per-page faux-cluster slug "
            "'_solo_<page_id>' but rendered without a label, contributing "
            "to nebula visual density without cluttering it. "
            "Frontend uses this to differentiate LOD/rendering."
        ),
    )
    parent_id: Optional[str] = Field(None, description="Parent node ID")
    children_ids: list[str] = Field(default_factory=list, description="Child node IDs")
    page_urls: list[str] = Field(default_factory=list, description="URLs associated with this node")
    capture_ids: list[str] = Field(
        default_factory=list, description="Captures where this node was explored"
    )
    visit_count: int = Field(1, description="Number of times this topic has been visited", ge=1)
    first_visited_at: Optional[str] = Field(
        None,
        description="ISO-8601 timestamp of the earliest visit to this page. "
        "Used by the frontend time-window filter to show/hide nodes.",
    )
    x: Optional[float] = Field(None, description="X position hint for layout stability")
    y: Optional[float] = Field(None, description="Y position hint for layout stability")
    outlier_score: Optional[float] = Field(
        None,
        description=(
            "HDBSCAN outlier_score for singleton-kind nodes (higher = more "
            "outlier-like). NULL for cluster/unclustered kinds. The frontend "
            "may use this to vary singleton rendering intensity."
        ),
    )


class GraphEdge(BaseModel):
    """An edge connecting two nodes in the knowledge graph."""

    source_id: str = Field(..., description="Source node ID")
    target_id: str = Field(..., description="Target node ID")
    edge_type: str = Field(
        "parent_child",
        description="Edge type: parent_child or cross_link",
    )
    weight: float = Field(1.0, description="Edge weight (higher = stronger connection)", ge=0)


class PageRecord(BaseModel):
    """A flat record of a page in the continuous browsing history.

    One record per page per export batch. If the same page appears in two
    batches, there are two PageRecords. The diary computes time windows
    from these records at render time.
    """

    node_id: str = Field(..., description="Graph node slug for this page")
    cluster_id: str = Field(..., description="Parent cluster slug")
    cluster_name: str = Field(..., description="Human-readable cluster name")
    timestamp: datetime = Field(..., description="When this page was processed (batch timestamp)")
    source_batch_id: str = Field(..., description="Processed file stem that contributed this page")


class KnowledgeGraph(BaseModel):
    """The full knowledge graph containing nodes and edges.

    Page history is stored separately in SQLite via PageStore.
    """

    nodes: list[GraphNode] = Field(default_factory=list, description="All graph nodes")
    edges: list[GraphEdge] = Field(default_factory=list, description="All graph edges")

    def get_node(self, node_id: str) -> Optional[GraphNode]:
        """Find a node by ID."""
        for node in self.nodes:
            if node.id == node_id:
                return node
        return None

    def get_children(self, node_id: str) -> list[GraphNode]:
        """Get direct children of a node."""
        node = self.get_node(node_id)
        if not node:
            return []
        return [n for n in self.nodes if n.id in node.children_ids]

    def get_subtree(self, node_id: str) -> list[GraphNode]:
        """Get all descendants of a node (BFS)."""
        result = []
        queue = [node_id]
        visited = set()
        while queue:
            current_id = queue.pop(0)
            if current_id in visited:
                continue
            visited.add(current_id)
            node = self.get_node(current_id)
            if node:
                result.append(node)
                queue.extend(node.children_ids)
        return result

    def to_d3_json(self) -> dict:
        """Convert to the JSON shape D3 force layout expects.

        Returns:
            {
                "nodes": [{"id": ..., "label": ..., "level": ..., ...}],
                "links": [{"source": ..., "target": ..., "type": ..., "weight": ...}],
                "clusters": [{"id": ..., "name": ..., "page_ids": [...]}]
            }
        """
        d3_nodes = []
        for node in self.nodes:
            d3_node = {
                "id": node.id,
                "label": node.label,
                "level": node.level,
                "kind": node.kind,
                "visit_count": node.visit_count,
                "parent_id": node.parent_id,
                "children_ids": node.children_ids,
                "capture_ids": node.capture_ids,
                "page_urls": node.page_urls,
                "first_visited_at": node.first_visited_at,
            }
            if node.x is not None:
                d3_node["x"] = node.x
            if node.y is not None:
                d3_node["y"] = node.y
            if node.outlier_score is not None:
                d3_node["outlier_score"] = node.outlier_score
            d3_nodes.append(d3_node)

        d3_links = [
            {
                "source": edge.source_id,
                "target": edge.target_id,
                "type": edge.edge_type,
                "weight": edge.weight,
            }
            for edge in self.edges
        ]

        # Derive clusters from page parent_ids for D3 hull rendering
        cluster_pages: dict[str, list[str]] = {}
        for node in self.nodes:
            if node.parent_id:
                cluster_pages.setdefault(node.parent_id, []).append(node.id)

        # cluster.name is the human-readable display label. For per-page
        # solo faux-clusters (parent_id="_solo_<page_id>") there is no
        # meaningful cluster -- the title-case of the slug would render
        # as "Solo 6845" in any consumer that displays cluster.name. Emit
        # an empty name so consumers can branch on its truthiness or fall
        # back to the page title via cluster.page_ids[0]. Real clusters
        # keep their slug-derived name; the to_d3_elements enrichment in
        # frontend/dash/utils/graph_data.py overwrites cluster.name from
        # the DB cluster_name for matched real clusters.
        clusters = [
            {
                "id": cid,
                "name": "" if cid.startswith("_solo_") else cid.replace("_", " ").title(),
                "page_ids": pids,
            }
            for cid, pids in cluster_pages.items()
        ]

        return {"nodes": d3_nodes, "links": d3_links, "clusters": clusters}
