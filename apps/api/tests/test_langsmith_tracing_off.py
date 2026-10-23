"""Tests must never send LangSmith traces (conftest forces tracing off)."""

import os

import pytest


@pytest.mark.parametrize("var", ["LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING", "LANGCHAIN_TRACING"])
def test_tracing_env_is_false_during_run(var):
    assert os.environ[var] == "false"


def test_settings_tracing_is_off():
    from backend.config.settings import settings

    assert settings.langchain_tracing_v2 is False


def test_agent_traceable_is_a_passthrough():
    from backend.services.agent import traceable

    def fn():
        return 1

    assert traceable("x")(fn) is fn


def test_langsmith_sdk_tracing_is_disabled():
    from langsmith.utils import tracing_is_enabled

    assert not tracing_is_enabled()
