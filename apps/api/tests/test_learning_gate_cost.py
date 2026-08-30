from unittest.mock import patch, MagicMock
import backend.api.main as main


def test_record_learning_gate_cost_emits_cost_event():
    resp = MagicMock(input_tokens=20, output_tokens=1, cost_usd=0.0001, latency_ms=120.0)
    with patch("backend.db.trends_repo.insert_cost_event") as ins:
        main._record_learning_gate_cost(resp, page_url="https://x.test/a")
    ins.assert_called_once()
    kwargs = ins.call_args.kwargs
    assert kwargs["event_type"] == "learning_gate"
    assert kwargs["model"] == "gpt-4o-mini"
    assert kwargs["input_tokens"] == 20
    assert kwargs["cost_usd"] == 0.0001


def test_record_learning_gate_cost_never_raises():
    resp = MagicMock(input_tokens=1, output_tokens=1, cost_usd=0.0, latency_ms=None)
    with patch("backend.db.trends_repo.insert_cost_event", side_effect=RuntimeError("db")):
        main._record_learning_gate_cost(resp, page_url="https://x.test/a")  # must swallow
