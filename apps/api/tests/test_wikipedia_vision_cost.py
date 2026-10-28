"""Wikipedia image-description (vision) calls are recorded as cost events.

The fetcher's GPT-4o vision pass was never written to ``cost_events``, so the
Overview spend view under-reported what the pipeline actually spent.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from backend.api import main
from backend.services import content_fetcher


def _fake_wiki_page():
    page = MagicMock()
    page.exists.return_value = True
    page.title = "Example article"
    page.summary = "An example article."
    page.text = "Example article text."
    page.sections = []
    page.categories = {}
    return page


def _vision_result(n):
    desc = SimpleNamespace(description=f"picture {n}", content_type="photo", relevance="high")
    resp = SimpleNamespace(
        model="gpt-4o", input_tokens=900, output_tokens=60, cost_usd=0.003, latency_ms=800.0
    )
    return desc, resp


@pytest.mark.asyncio
async def test_each_successful_vision_call_reports_its_cost():
    images = [SimpleNamespace(url=f"https://img.test/{i}.jpg", thumb_url=None) for i in range(3)]
    outcomes = [_vision_result(0), RuntimeError("vision down"), _vision_result(2)]

    async def fake_describe(image_url, **_kw):
        out = outcomes[int(image_url.rsplit("/", 1)[1][0])]
        if isinstance(out, BaseException):
            raise out
        return out

    async def fake_images(_title, limit=3):
        return images

    seen = []
    with (
        patch.object(content_fetcher.wikipediaapi, "Wikipedia") as wiki_cls,
        patch.object(content_fetcher.httpx, "get", side_effect=RuntimeError("no network")),
        patch("backend.services.multimodal.fetch_wikipedia_images", side_effect=fake_images),
        patch("backend.services.multimodal.describe_image_in_context", side_effect=fake_describe),
    ):
        wiki_cls.return_value.page.return_value = _fake_wiki_page()
        await content_fetcher.fetch_wikipedia_content(
            "https://en.wikipedia.org/wiki/Example",
            llm=object(),
            on_llm_cost=seen.append,
        )

    assert [r.cost_usd for r in seen] == [0.003, 0.003]


def test_record_vision_cost_emits_cost_event():
    resp = SimpleNamespace(
        model="gpt-4o", input_tokens=900, output_tokens=60, cost_usd=0.003, latency_ms=800.0
    )
    with patch("backend.db.trends_repo.insert_cost_event") as ins:
        main._record_vision_cost(resp, page_url="https://en.wikipedia.org/wiki/Example")
    ins.assert_called_once()
    kwargs = ins.call_args.kwargs
    assert kwargs["event_type"] == "wiki_image_vision"
    assert kwargs["model"] == "gpt-4o"
    assert kwargs["input_tokens"] == 900
    assert kwargs["output_tokens"] == 60
    assert kwargs["cost_usd"] == 0.003
    assert kwargs["metadata"] == {"page_url": "https://en.wikipedia.org/wiki/Example"}


def test_record_vision_cost_never_raises():
    resp = SimpleNamespace(
        model="gpt-4o", input_tokens=1, output_tokens=1, cost_usd=0.0, latency_ms=None
    )
    with patch("backend.db.trends_repo.insert_cost_event", side_effect=RuntimeError("db")):
        main._record_vision_cost(resp, page_url="https://en.wikipedia.org/wiki/Example")


def test_vision_event_has_a_spend_label():
    from backend.services.overview_summary import event_label

    assert event_label("wiki_image_vision") == "Wikipedia image descriptions"
