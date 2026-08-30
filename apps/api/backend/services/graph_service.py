"""PostgreSQL persistence for the knowledge graph."""

from backend.db import graph_repo
from backend.db.connection import set_current_user_id
from backend.models.graph import KnowledgeGraph


def load_graph(user_id: int | None = None) -> KnowledgeGraph:
    """Load the knowledge graph from the graph_cache table.

    Returns an empty graph if no cache exists yet.
    If user_id is None, uses the default dev user.
    Sets the RLS context so connections outside request scope work correctly.
    """
    if user_id is None:
        from backend.api.main import get_default_user_id

        user_id = get_default_user_id()

    set_current_user_id(user_id)
    cached = graph_repo.load_graph_cache(user_id)
    if cached is None:
        return KnowledgeGraph()

    return KnowledgeGraph.model_validate(cached)


def save_graph(graph: KnowledgeGraph, user_id: int | None = None) -> None:
    """Persist the knowledge graph to the graph_cache table."""
    if user_id is None:
        from backend.api.main import get_default_user_id

        user_id = get_default_user_id()

    set_current_user_id(user_id)
    graph_repo.save_graph_cache(user_id, graph.model_dump())
