"""Integration test: exercises real `claude -p` subprocess (NOT mocked).

Runs only when RUN_DQ_INTEGRATION=1 is set in the environment. Skipped otherwise.

This test:
- Costs real Max-200 subscription quota (~$3-5 per run under current pricing).
- Takes several minutes (claude -p with a 25KB prompt).
- Requires `claude` on PATH and your subscription to be active.

Run command:
    RUN_DQ_INTEGRATION=1 uv run pytest tests/test_dq_agent_integration.py -xvs

Expected duration: 2-7 minutes
Expected cost: $3-5 of subscription quota

Gate at the module level so the whole file is skipped when the env var is absent.
"""

import os

import pytest

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DQ_INTEGRATION") != "1",
    reason="set RUN_DQ_INTEGRATION=1 to run (spawns real claude -p, costs subscription quota)",
)


def test_investigate_returns_structured_payload():
    """Invoke DQAgent.investigate() with NO pre-detected candidates against the dev DB.

    Asserts:
      - result is a dict with keys: trigger, findings, total_cost_usd
      - findings is a list (possibly empty -- S1 may legitimately find nothing in dev data)
      - NO 'error' key present (a truthy error means permission denials or crashes)
      - total_cost_usd > 0 (proves CC actually ran; subscription auth still reports cost)
    """
    from backend.api.main import get_default_user_id
    from backend.services.dq_agent import DQAgent

    user_id = get_default_user_id()
    agent = DQAgent(user_id=user_id)
    result = agent.investigate(trigger="manual")

    assert "error" not in result or not result["error"], (
        f"CC returned error: {result.get('error')}"
    )
    assert isinstance(result.get("findings"), list), (
        f"findings must be a list, got {type(result.get('findings'))}"
    )
    assert result.get("total_cost_usd", 0) > 0, (
        "total_cost_usd must be > 0 (proves CC actually executed)"
    )
