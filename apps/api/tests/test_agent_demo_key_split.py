"""Which OpenAI key an agent session bills to.

Agent chat is the only LLM path a plain-demo session can still reach, and
it is deliberately left open (it is the demo's headline feature). Its
slowapi limits key on source IP, so they bound a single visitor rather
than aggregate spend. Billing demo sessions to a separate key lets a
provider-side budget cap bound the PUBLIC credential without capping the
owner's own usage on the same deployment.

These tests pin the routing itself -- a silent misroute would either
bill the demo to the uncapped key (no protection) or bill the owner to
the capped one (chat dies when the demo budget runs out).
"""

from unittest.mock import patch

import pytest

from backend.services.agent import CompendiumAgent


@pytest.fixture
def agent():
    """An agent instance without triggering __init__'s client construction."""
    a = object.__new__(CompendiumAgent)
    a.user_id = 42
    return a


class TestKeyRouting:
    def test_demo_user_gets_demo_key(self, agent):
        with patch("backend.config.settings.settings") as s, patch(
            "backend.db.auth_repo.get_role", return_value="demo"
        ):
            s.openai_api_key = "shared"
            s.openai_api_key_demo = "demo-scoped"
            from backend.services import agent as agent_mod

            with patch.object(agent_mod, "settings", s):
                assert agent._resolve_openai_key() == "demo-scoped"

    @pytest.mark.parametrize("role", ["admin", "user", None])
    def test_non_demo_users_get_shared_key(self, agent, role):
        """The owner's own usage must stay on the uncapped key."""
        from backend.services import agent as agent_mod

        with patch("backend.db.auth_repo.get_role", return_value=role):
            with patch.object(agent_mod, "settings") as s:
                s.openai_api_key = "shared"
                s.openai_api_key_demo = "demo-scoped"
                assert agent._resolve_openai_key() == "shared"

    def test_unset_demo_key_falls_back(self, agent):
        """Unconfigured deployments behave exactly as before the split."""
        from backend.services import agent as agent_mod

        with patch.object(agent_mod, "settings") as s:
            s.openai_api_key = "shared"
            s.openai_api_key_demo = None
            # No role lookup should even be attempted.
            with patch("backend.db.auth_repo.get_role") as gr:
                assert agent._resolve_openai_key() == "shared"
                gr.assert_not_called()

    def test_role_lookup_failure_falls_back_not_raises(self, agent):
        """A DB hiccup must not take chat down -- fall back to the shared key."""
        from backend.services import agent as agent_mod

        with patch.object(agent_mod, "settings") as s:
            s.openai_api_key = "shared"
            s.openai_api_key_demo = "demo-scoped"
            with patch("backend.db.auth_repo.get_role", side_effect=RuntimeError("db down")):
                assert agent._resolve_openai_key() == "shared"
