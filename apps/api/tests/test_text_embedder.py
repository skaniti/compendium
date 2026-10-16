"""text_embedder routing, normalisation and cost event (OpenAI and SBERT mocked)."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np

from backend.services import text_embedder


def _resp(vectors, tokens):
    return SimpleNamespace(
        data=[SimpleNamespace(index=i, embedding=v) for i, v in enumerate(vectors)],
        usage=SimpleNamespace(total_tokens=tokens),
    )


def test_openai_path_normalises_and_records_cost(monkeypatch):
    monkeypatch.setattr(
        text_embedder.settings, "clustering_embedding_model", "text-embedding-3-small"
    )
    client = MagicMock()
    client.embeddings.create.return_value = _resp([[3.0, 4.0], [0.0, 2.0]], 10)
    with (
        patch("openai.OpenAI", return_value=client),
        patch("backend.db.trends_repo.insert_cost_event") as cost,
    ):
        out = text_embedder.embed_texts(["a", "b"], user_id=7)
    assert np.allclose(out, [[0.6, 0.8], [0.0, 1.0]])
    kwargs = cost.call_args.kwargs
    assert kwargs["event_type"] == "shelf_embedding" and kwargs["user_id"] == 7
    assert kwargs["input_tokens"] == 10


def test_openai_batches_of_512_and_no_cost_without_user(monkeypatch):
    monkeypatch.setattr(
        text_embedder.settings, "clustering_embedding_model", "text-embedding-3-small"
    )
    client = MagicMock()
    client.embeddings.create.side_effect = lambda model, input: _resp([[1.0, 0.0]] * len(input), 1)
    with (
        patch("openai.OpenAI", return_value=client),
        patch("backend.db.trends_repo.insert_cost_event") as cost,
    ):
        out = text_embedder.embed_texts([f"s{i}" for i in range(1000)])
    assert out.shape == (1000, 2)
    assert client.embeddings.create.call_count == 2
    cost.assert_not_called()


def test_sbert_path(monkeypatch):
    monkeypatch.setattr(text_embedder.settings, "clustering_embedding_model", "all-MiniLM-L6-v2")
    model = MagicMock()
    model.encode.return_value = np.array([[2.0, 0.0], [0.0, 5.0]])
    with patch("backend.services.sbert_loader.get_sbert_model", return_value=model):
        out = text_embedder.embed_texts(["a", "b"], user_id=1)
    assert np.allclose(out, np.eye(2))
    assert text_embedder.embedder_key() == "all-MiniLM-L6-v2"


def test_empty_input_makes_no_call(monkeypatch):
    with patch("backend.services.sbert_loader.get_sbert_model") as m:
        assert text_embedder.embed_texts([]).shape[0] == 0
    m.assert_not_called()
