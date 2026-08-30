"""Tests for backend.services.chat_importer.parser."""
from __future__ import annotations

import json
from pathlib import Path

from backend.services.chat_importer.parser import (
    linearize_conversation,
    parse_export_shard,
)
from backend.services.chat_importer.schema import RawConversation


def _node(
    node_id: str,
    parent: str | None,
    children: list[str],
    *,
    role: str | None = None,
    parts: list | None = None,
    model_slug: str | None = None,
    content_type: str = "text",
    create_time: float | None = 1700000100.0,
) -> dict:
    """Build a mapping-node dict in the ChatGPT export shape."""
    msg = None
    if role is not None or parts is not None:
        msg = {
            "id": node_id,
            "author": {"role": role} if role else None,
            "content": {"content_type": content_type, "parts": parts or [""]},
            "create_time": create_time,
            "metadata": {"model_slug": model_slug} if model_slug else None,
        }
    return {"id": node_id, "parent": parent, "children": children, "message": msg}


def _conv(
    *,
    conv_id: str = "conv-1",
    title: str | None = "Test",
    create_time: float | None = 1700000000.0,
    mapping: dict | None = None,
    current_node: str | None = None,
) -> dict:
    return {
        "id": conv_id,
        "conversation_id": conv_id,
        "title": title,
        "create_time": create_time,
        "mapping": mapping or {},
        "current_node": current_node,
    }


def test_basic_linearization():
    mapping = {
        "n1": _node("n1", None, ["n2"], role="user", parts=["Hi"]),
        "n2": _node("n2", "n1", ["n3"], role="assistant", parts=["Hello"]),
        "n3": _node("n3", "n2", [], role="user", parts=["What is 2+2?"]),
    }
    raw = RawConversation.model_validate(_conv(mapping=mapping, current_node="n3"))
    norm = linearize_conversation(raw)
    assert norm is not None
    assert [m.role for m in norm.messages] == ["user", "assistant", "user"]
    assert [m.text for m in norm.messages] == ["Hi", "Hello", "What is 2+2?"]


def test_drops_branch():
    """current_node walks one branch only; siblings are excluded."""
    mapping = {
        "root": _node("root", None, ["a", "b"], role="user", parts=["root"]),
        "a": _node("a", "root", [], role="assistant", parts=["branch A discarded"]),
        "b": _node("b", "root", ["b2"], role="assistant", parts=["branch B kept"]),
        "b2": _node("b2", "b", [], role="user", parts=["follow B"]),
    }
    raw = RawConversation.model_validate(_conv(mapping=mapping, current_node="b2"))
    norm = linearize_conversation(raw)
    assert norm is not None
    texts = [m.text for m in norm.messages]
    assert texts == ["root", "branch B kept", "follow B"]
    assert "branch A discarded" not in texts


def test_skips_no_current_node():
    raw = RawConversation.model_validate(_conv(current_node=None))
    assert linearize_conversation(raw) is None


def test_skips_no_create_time():
    mapping = {"n": _node("n", None, [], role="user", parts=["hi"])}
    raw = RawConversation.model_validate(
        _conv(create_time=None, mapping=mapping, current_node="n")
    )
    assert linearize_conversation(raw) is None


def test_skips_empty_text_messages():
    mapping = {
        "empty": _node("empty", None, ["sub"], role="system", parts=[""]),
        "sub": _node("sub", "empty", [], role="user", parts=["actual"]),
    }
    raw = RawConversation.model_validate(_conv(mapping=mapping, current_node="sub"))
    norm = linearize_conversation(raw)
    assert norm is not None
    assert [m.text for m in norm.messages] == ["actual"]


def test_unknown_role_falls_back():
    mapping = {"n": _node("n", None, [], role="weird-role", parts=["text"])}
    raw = RawConversation.model_validate(_conv(mapping=mapping, current_node="n"))
    norm = linearize_conversation(raw)
    assert norm is not None
    assert norm.messages[0].role == "unknown"


def test_multimodal_skips_image_dicts():
    """parts can mix str and dict (image refs); only string parts kept."""
    mapping = {
        "n": _node(
            "n", None, [], role="assistant",
            parts=["First text", {"content_type": "image_asset_pointer"}, "Second text"],
            content_type="multimodal_text",
        ),
    }
    raw = RawConversation.model_validate(_conv(mapping=mapping, current_node="n"))
    norm = linearize_conversation(raw)
    assert norm is not None
    txt = norm.messages[0].text
    assert "First text" in txt and "Second text" in txt
    assert "image_asset_pointer" not in txt


def test_voice_mode_audio_transcription():
    """audio_transcription content_type carries the transcribed text in parts."""
    mapping = {
        "n": _node(
            "n", None, [], role="assistant",
            parts=["Transcribed text from voice."],
            content_type="audio_transcription",
        ),
    }
    raw = RawConversation.model_validate(_conv(mapping=mapping, current_node="n"))
    norm = linearize_conversation(raw)
    assert norm is not None
    assert norm.messages[0].text == "Transcribed text from voice."


def test_model_slug_propagates():
    mapping = {
        "n": _node("n", None, [], role="assistant", parts=["text"], model_slug="gpt-5-thinking"),
    }
    raw = RawConversation.model_validate(_conv(mapping=mapping, current_node="n"))
    norm = linearize_conversation(raw)
    assert norm is not None
    assert norm.messages[0].model_slug == "gpt-5-thinking"


def test_cycle_breaks_without_infinite_loop():
    """Defensive: parent cycle in mapping must not infinite-loop."""
    mapping = {
        "a": _node("a", "b", ["b"], role="user", parts=["A"]),
        "b": _node("b", "a", ["a"], role="assistant", parts=["B"]),
    }
    raw = RawConversation.model_validate(_conv(mapping=mapping, current_node="a"))
    norm = linearize_conversation(raw)
    assert norm is not None
    assert len(norm.messages) <= 2


def test_parse_export_shard_skips_invalid(tmp_path: Path):
    """Invalid entries in a shard are skipped without aborting the run."""
    shard = tmp_path / "conversations-test.json"
    valid = _conv(
        mapping={"n": _node("n", None, [], role="user", parts=["hello"])},
        current_node="n",
    )
    invalid = "not-a-conversation"  # not a dict; validation fails
    shard.write_text(json.dumps([valid, invalid]))
    convs = list(parse_export_shard(shard))
    assert len(convs) == 1
    assert convs[0].messages[0].text == "hello"


def test_title_truncated_to_500_chars():
    long_title = "X" * 1000
    mapping = {"n": _node("n", None, [], role="user", parts=["hi"])}
    raw = RawConversation.model_validate(
        _conv(title=long_title, mapping=mapping, current_node="n")
    )
    norm = linearize_conversation(raw)
    assert norm is not None
    assert len(norm.title) == 500


def test_missing_title_replaced_with_placeholder():
    mapping = {"n": _node("n", None, [], role="user", parts=["hi"])}
    raw = RawConversation.model_validate(_conv(title=None, mapping=mapping, current_node="n"))
    norm = linearize_conversation(raw)
    assert norm is not None
    assert norm.title == "(untitled)"
