"""The capture path's gate prompts and the learning gate's model are named
constants (the Prompts dev view reads them), with no inline literals left."""

import inspect

from backend.api import main
from backend.prompts.templates import PROMPTS


def test_named_constants():
    assert main.SKIP_GATE_PROMPT == "skip_gate_v2_3"
    assert main.LEARNING_GATE_PROMPT == "learning_gate_v1"
    assert main.LEARNING_GATE_MODEL == "gpt-4o-mini"


def test_constants_name_registered_prompts():
    assert main.SKIP_GATE_PROMPT in PROMPTS
    assert main.LEARNING_GATE_PROMPT in PROMPTS


def test_call_sites_use_the_constants():
    src = inspect.getsource(main)
    assert src.count('"skip_gate_v2_3"') == 1, "only the constant's definition"
    assert src.count('"learning_gate_v1"') == 1, "only the constant's definition"
    assert 'model="gpt-4o-mini"' not in src
