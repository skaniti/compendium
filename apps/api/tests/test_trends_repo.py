"""Tests for trends_repo helpers (pure query-layer unit tests)."""

from unittest.mock import MagicMock, patch


def test_get_agent_tool_mix_unnests_tools_used_array():
    """metadata->'tools_used' is a JSON array; query returns aggregated counts."""
    from backend.db.trends_repo import get_agent_tool_mix

    fake_rows = [
        ("search_compendium", 48),
        ("get_cluster_info", 31),
        ("list_clusters", 14),
        ("get_page_detail", 7),
    ]
    with patch("backend.db.trends_repo.get_conn") as mock_get_conn:
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = fake_rows
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
        mock_get_conn.return_value.__enter__.return_value = mock_conn

        result = get_agent_tool_mix(user_id=1)

    assert {r["tool"] for r in result} == {
        "search_compendium", "get_cluster_info", "list_clusters", "get_page_detail",
    }
    assert sum(r["count"] for r in result) == 100


def test_get_agent_tool_mix_empty_when_no_agent_events():
    """When no rows have metadata.tools_used, result is empty list."""
    from backend.db.trends_repo import get_agent_tool_mix
    with patch("backend.db.trends_repo.get_conn") as mock_get_conn:
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = []
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
        mock_get_conn.return_value.__enter__.return_value = mock_conn
        assert get_agent_tool_mix(user_id=1) == []


def test_get_agent_tool_mix_accepts_since_filter():
    """Passing a `since` datetime adds a time-window filter to the query."""
    from datetime import datetime, timezone, timedelta
    from backend.db.trends_repo import get_agent_tool_mix
    with patch("backend.db.trends_repo.get_conn") as mock_get_conn:
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = []
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
        mock_get_conn.return_value.__enter__.return_value = mock_conn
        get_agent_tool_mix(user_id=1, since=datetime.now(timezone.utc) - timedelta(days=30))
    # The execute call should have received the 30d timestamp as a parameter
    executed_args = mock_cursor.execute.call_args
    assert executed_args is not None
    # Params tuple is the second positional arg; should have at least 2 elements (user_id, since)
    assert len(executed_args[0][1]) >= 2


def test_get_agent_iteration_distribution_groups_by_iterations():
    from backend.db.trends_repo import get_agent_iteration_distribution

    fake_rows = [
        (1, 57),
        (2, 28),
        (3, 9),
        (4, 3),
        (5, 3),
    ]
    with patch("backend.db.trends_repo.get_conn") as mock_get_conn:
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = fake_rows
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
        mock_get_conn.return_value.__enter__.return_value = mock_conn

        result = get_agent_iteration_distribution(user_id=1)

    iters = {r["iterations"] for r in result}
    assert iters == {1, 2, 3, 4, 5}
    one_step = next(r for r in result if r["iterations"] == 1)
    assert one_step["count"] == 57


def test_get_agent_iteration_distribution_empty_when_no_agent_events():
    from backend.db.trends_repo import get_agent_iteration_distribution
    with patch("backend.db.trends_repo.get_conn") as mock_get_conn:
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = []
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
        mock_get_conn.return_value.__enter__.return_value = mock_conn
        assert get_agent_iteration_distribution(user_id=1) == []


def test_get_daily_latency_averages_per_day():
    from backend.db.trends_repo import get_daily_latency

    fake_rows = [
        ("2026-04-22", 520.5, 8),
        ("2026-04-23", 610.2, 12),
    ]
    with patch("backend.db.trends_repo.get_conn") as mock_get_conn:
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = fake_rows
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
        mock_get_conn.return_value.__enter__.return_value = mock_conn

        result = get_daily_latency(user_id=1)

    assert len(result) == 2
    assert result[0]["day"] == "2026-04-22"
    assert result[0]["avg_latency_ms"] == 520.5
    assert result[0]["call_count"] == 8


def test_get_daily_latency_empty_when_no_events():
    from backend.db.trends_repo import get_daily_latency
    with patch("backend.db.trends_repo.get_conn") as mock_get_conn:
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = []
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
        mock_get_conn.return_value.__enter__.return_value = mock_conn
        assert get_daily_latency(user_id=1) == []
