"""page_labeller: request building, parsing, labelling, cost; prompt + llm plumbing.

The model is never called: ``FakeLLM`` (tests/_label_fixtures.py) or a mocked
Anthropic client stands in. Synthetic data only.
"""

import asyncio
import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.config.settings import settings
from backend.prompts.templates import (
    PROMPTS,
    get_prompt_metadata,
    get_prompt_raw,
    get_prompt_template,
    list_prompts,
)
from backend.services import page_labeller as pl
from backend.services.llm_service import MODEL_PRICING, MODEL_PROVIDERS, LLMProvider, LLMService
from tests._label_fixtures import FakeLLM, item


def _page(i, **over):
    p = {
        "id": i,
        "page_content_id": 1000 + i,
        "title": f"Synthetic page {i}",
        "url": f"https://p{i}.example.test/x",
        "domain": f"p{i}.example.test",
        "visited_at": "2026-03-15T10:00:00+00:00",
        "dwell_time_seconds": 42,
        "content_summary": "A synthetic   summary.",
        "extracted_text": "Some synthetic body text.",
    }
    p.update(over)
    return p


# --- prompt registry -------------------------------------------------------


def test_prompt_registered_verbatim_and_unformatted():
    text = PROMPTS["page_annotation_v2"]["template"]
    assert "{" not in text and "}" not in text
    assert text.startswith("You label web pages captured from one person's browsing")
    assert "subtopic: 2-6 words" in text and text.endswith("category + subtopic.\n")
    assert get_prompt_raw("page_annotation_v2") == text
    assert get_prompt_template("page_annotation_v2") == text
    assert settings.label_prompt_key == "page_annotation_v2"


def test_prompt_listing_metadata_shape():
    meta = get_prompt_metadata("page_annotation_v2")
    assert set(meta) == {"name", "techniques", "description"}
    assert any(p["name"] == "page_annotation_v2" for p in list_prompts())


# --- llm_service plumbing --------------------------------------------------


def test_models_registered_with_list_prices():
    assert MODEL_PROVIDERS["claude-haiku-5-5"] == LLMProvider.ANTHROPIC
    assert MODEL_PROVIDERS["claude-sonnet-5-5"] == LLMProvider.ANTHROPIC
    assert MODEL_PRICING["claude-haiku-5-5"] == {"input": 0.001, "output": 0.005}
    assert MODEL_PRICING["claude-sonnet-5-5"] == {"input": 0.003, "output": 0.015}


def _anthropic_service(captured):
    svc = LLMService.__new__(LLMService)
    svc._openai_client = None
    svc._hf_headers = None

    async def create(**kwargs):
        captured.append(kwargs)
        return SimpleNamespace(
            content=[SimpleNamespace(text="{}")],
            usage=SimpleNamespace(input_tokens=1000, output_tokens=200),
        )

    svc._anthropic_client = SimpleNamespace(messages=SimpleNamespace(create=create))
    return svc


def test_anthropic_default_request_is_unchanged():
    captured = []
    svc = _anthropic_service(captured)
    resp = asyncio.run(
        svc.complete("hi", model="claude-haiku-4-5-20251001", system_prompt="sys", max_tokens=50)
    )
    assert captured == [
        {
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 50,
            "temperature": 0.7,
            "messages": [{"role": "user", "content": "hi"}],
            "system": "sys",
        }
    ]
    assert resp.cost_usd == pytest.approx((1000 * 0.0008 + 200 * 0.004) / 1000)


def test_anthropic_extra_kwargs_are_merged():
    captured = []
    svc = _anthropic_service(captured)
    extra = {"thinking": {"type": "disabled"}, "output_config": {"format": {"type": "x"}}}
    resp = asyncio.run(svc.complete("hi", model="claude-haiku-5-5", extra_kwargs=extra))
    assert captured[0]["thinking"] == {"type": "disabled"}
    assert captured[0]["output_config"] == {"format": {"type": "x"}}
    assert captured[0]["model"] == "claude-haiku-5-5"
    assert resp.cost_usd == pytest.approx((1000 * 0.001 + 200 * 0.005) / 1000)


# --- request building ------------------------------------------------------


def test_build_page_input_mirrors_analyst_format():
    p = _page(
        1,
        url="https://x.example.test/" + "a" * 400,
        content_summary="s" * 500,
        extracted_text="t " * 600,
    )
    out = pl.build_page_input(p).split("\n")
    assert out[0] == "title: Synthetic page 1"
    assert out[1] == "url: " + ("https://x.example.test/" + "a" * 400)[:300]
    assert out[2] == "domain: p1.example.test"
    assert out[3] == "visited: 2026-03-15  dwell_seconds: 42"
    assert out[4] == "summary: " + "s" * 300
    assert out[5].startswith("text: t t t") and len(out[5]) == len("text: ") + 700


def test_build_page_input_drops_status_summary_and_text_duplicate():
    p = _page(1, content_summary="Domain skipped by rule", extracted_text="")
    assert "summary:" not in pl.build_page_input(p)
    body = "same opening words " * 20
    p = _page(1, content_summary=body[:200], extracted_text=body)
    block = pl.build_page_input(p)
    assert "summary:" not in block and "text:" in block
    p = _page(1, title=None, visited_at=None, content_summary=None, extracted_text=None)
    assert pl.build_page_input(p).split("\n") == [
        "title: ",
        "url: https://p1.example.test/x",
        "domain: p1.example.test",
        "visited:   dwell_seconds: 42",
    ]


def test_build_request_shape():
    system, user = pl.build_request([_page(7), _page(9)])
    assert system == get_prompt_raw(settings.label_prompt_key)
    assert user.startswith(
        "Label each of the 2 pages below. Return items in the same order, each with its page_id.\n\n"
        "### page_id: 7\ntitle: Synthetic page 7"
    )
    assert "\n\n### page_id: 9\n" in user


def _use_overrides(monkeypatch, tmp_path, mapping):
    path = tmp_path / "overrides.json"
    path.write_text(json.dumps(mapping), encoding="utf-8")
    monkeypatch.setattr(settings, "prompt_overrides_path", str(path))


def test_labeller_version_follows_settings(monkeypatch):
    fp = pl.prompt_fingerprint()
    assert pl.labeller_version() == f"claude-haiku-5-5@page_annotation_v2+{fp}"
    monkeypatch.setattr(settings, "label_model", "claude-sonnet-5-5")
    assert pl.labeller_version() == f"claude-sonnet-5-5@page_annotation_v2+{fp}"


def test_prompt_fingerprint_is_short_stable_hex():
    fp = pl.prompt_fingerprint()
    assert len(fp) == pl.PROMPT_FINGERPRINT_LEN and int(fp, 16) >= 0
    assert fp == pl.prompt_fingerprint()


def test_prompt_override_changes_labeller_version(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "prompt_overrides_path", "")
    generic = pl.labeller_version()
    _use_overrides(monkeypatch, tmp_path, {"page_annotation_v2": "A synthetic private prompt."})
    private = pl.labeller_version()
    assert private != generic
    assert private.startswith("claude-haiku-5-5@page_annotation_v2+")
    system, _ = pl.build_request([_page(7)])
    assert system == "A synthetic private prompt."
    _use_overrides(monkeypatch, tmp_path, {"page_annotation_v2": "A second synthetic prompt."})
    assert pl.labeller_version() not in (generic, private)
    _use_overrides(monkeypatch, tmp_path, {"something_else": "x"})
    assert pl.labeller_version() == generic  # override for another prompt: no effect


# --- parse_labels ----------------------------------------------------------


def test_parse_plain_wrapper_and_normalisation():
    text = json.dumps(
        {
            "items": [
                item(
                    1,
                    confidence=7,
                    flags=["non_english", "non_english"],
                    entity="  ",
                    language="en",
                )
            ]
        }
    )
    got = pl.parse_labels(text, [1])
    assert got[1]["confidence"] == 1.0
    assert got[1]["flags"] == ["non_english"]
    assert got[1]["entity"] is None
    assert got[1]["category"] == "science_nature"
    assert (
        pl.parse_labels(json.dumps({"items": [item(1, confidence=-3)]}), [1])[1]["confidence"]
        == 0.0
    )


def test_parse_code_fence_and_single_item_and_list():
    body = json.dumps({"items": [item(1), item(2)]})
    assert set(pl.parse_labels(f"```json\n{body}\n```", [1, 2])) == {1, 2}
    assert set(pl.parse_labels(f"```\n{body}\n```\n", [1, 2])) == {1, 2}
    assert set(pl.parse_labels(json.dumps(item(5)), [5])) == {5}
    assert set(pl.parse_labels(json.dumps([item(1), item(2)]), [1, 2])) == {1, 2}
    # string ids are accepted
    assert set(pl.parse_labels(json.dumps({"items": [item("3")]}), [3])) == {3}


def test_parse_drops_bad_items_keeps_rest(caplog):
    items = [
        item(1),
        item(2, category="not_a_category"),
        item(3, content_kind="nonsense"),
        item(4, knowledge_value="maybe"),
        item(5, flags=["made_up"]),
        item(6, subtopic=""),
        item(7, subtopic="x" * 81),
        {k: v for k, v in item(8).items() if k != "page_id"},
        item(99),  # extra id
        item(1, subtopic="duplicate"),
    ]
    with caplog.at_level(logging.WARNING):
        got = pl.parse_labels(json.dumps({"items": items}), [1, 2, 3, 4, 5, 6, 7, 8])
    assert set(got) == {1}
    assert got[1]["subtopic"] == "Synthetic shelf"
    assert "unknown category" in caplog.text and "unexpected page_id 99" in caplog.text


def test_parse_missing_page_id_with_single_expected():
    no_id = {k: v for k, v in item(1).items() if k != "page_id"}
    assert set(pl.parse_labels(json.dumps({"items": [no_id]}), [42])) == {42}


def test_parse_truncated_json_raises():
    full = json.dumps({"items": [item(1), item(2)]})
    with pytest.raises(pl.LabelParseError):
        pl.parse_labels(full[: len(full) // 2], [1, 2])
    with pytest.raises(pl.LabelParseError):
        pl.parse_labels("", [1])


def test_enums_match_schema():
    props = pl.BATCH_SCHEMA["properties"]["items"]["items"]["properties"]
    assert len(pl.TAXONOMY) == 26 and len(set(pl.TAXONOMY)) == 26
    assert props["category"]["enum"] == list(pl.TAXONOMY)
    assert props["content_kind"]["enum"] == list(pl.CONTENT_KINDS)
    assert props["flags"]["items"]["enum"] == list(pl.FLAGS)
    assert pl.BATCH_SCHEMA["additionalProperties"] is False


# --- label_pages -----------------------------------------------------------


def test_label_pages_chunks_dedupes_and_sums():
    pages = [
        _page(i, page_content_id=1000 + (i + 1) // 2) for i in range(1, 21)
    ]  # 10 unique contents
    llm = FakeLLM()
    run = asyncio.run(pl.label_pages(pages, user_id=1, llm=llm))
    assert run.requests == 2 and run.failed_requests == 0
    assert len(llm.calls) == 2
    assert sorted(len(c["prompt"].split("### page_id:")) - 1 for c in llm.calls) == [2, 8]
    assert len(run.labels) == 10
    assert set(run.labels) == {1000 + k for k in range(1, 11)}
    assert run.input_tokens == 1200 and run.output_tokens == 200
    assert run.cost_usd == pytest.approx(0.0022)
    call = llm.calls[0]
    assert call["model"] == "claude-haiku-5-5" and call["temperature"] == 0
    assert call["max_tokens"] in (220 * 8 + 400, 220 * 2 + 400)
    assert call["system_prompt"] == get_prompt_raw("page_annotation_v2")
    assert call["extra_kwargs"]["thinking"] == {"type": "disabled"}
    fmt = call["extra_kwargs"]["output_config"]["format"]
    assert fmt["type"] == "json_schema" and fmt["schema"] is pl.BATCH_SCHEMA


def test_label_pages_failed_requests_do_not_affect_others():
    pages = [_page(i) for i in range(1, 25)]  # 3 requests

    def handler(idx, prompt):
        import re

        ids = [int(x) for x in re.findall(r"### page_id: (\d+)", prompt)]
        if ids[0] == 1:
            return RuntimeError("boom")
        if ids[0] == 9:
            return json.dumps({"items": [item(i) for i in ids]})[:60]  # truncated
        return json.dumps({"items": [item(i) for i in ids]})

    run = asyncio.run(pl.label_pages(pages, user_id=1, llm=FakeLLM(handler)))
    assert run.requests == 3 and run.failed_requests == 2
    assert set(run.labels) == {1000 + i for i in range(17, 25)}


def test_label_pages_request_timeout_fails_only_that_request(monkeypatch):
    monkeypatch.setattr(pl, "REQUEST_TIMEOUT_S", 0.05)
    pages = [_page(i) for i in range(1, 17)]  # 2 requests

    class SlowFirst(FakeLLM):
        async def complete(self, prompt, **kwargs):
            if "### page_id: 1\n" in prompt:
                await asyncio.sleep(5)
            return await super().complete(prompt, **kwargs)

    run = asyncio.run(pl.label_pages(pages, user_id=1, llm=SlowFirst()))
    assert run.requests == 2 and run.failed_requests == 1
    assert set(run.labels) == {1000 + i for i in range(9, 17)}


def test_label_pages_empty_and_all_invalid():
    assert asyncio.run(pl.label_pages([], user_id=1, llm=FakeLLM())).requests == 0
    llm = FakeLLM(lambda i, p: json.dumps({"items": [item(1, category="zzz")]}))
    run = asyncio.run(pl.label_pages([_page(1)], user_id=1, llm=llm))
    assert run.labels == {} and run.failed_requests == 1


def test_label_pages_sonnet_thinking_variant(monkeypatch):
    monkeypatch.setattr(settings, "label_model", "claude-sonnet-5-5")
    llm = FakeLLM()
    asyncio.run(pl.label_pages([_page(1)], user_id=1, llm=llm))
    assert llm.calls[0]["extra_kwargs"]["thinking"] == {"type": "between_tools"}


def test_label_pages_never_builds_real_client_when_llm_given(monkeypatch):
    boom = MagicMock(side_effect=AssertionError("LLMService constructed"))
    monkeypatch.setattr("backend.services.llm_service.LLMService", boom)
    asyncio.run(pl.label_pages([_page(1)], user_id=1, llm=FakeLLM()))
    boom.assert_not_called()


# --- estimate_cost ---------------------------------------------------------


def test_estimate_cost_scales_measured_rates():
    est = pl.estimate_cost(8)
    assert est["pages"] == 8 and est["requests"] == 1
    assert est["input_tokens"] == 6114 and est["output_tokens"] == 1005
    assert est["usd_list"] == pytest.approx((6114 * 0.001 + 1005 * 0.005) / 1000)
    assert est["usd_measured"] == pytest.approx(0.0008)
    big = pl.estimate_cost(800)
    assert big["requests"] == 100 and big["input_tokens"] == 611400
    assert big["usd_measured"] == pytest.approx(0.08)
    assert pl.estimate_cost(9)["requests"] == 2
    assert pl.estimate_cost(9, batch_size=3)["requests"] == 3
    z = pl.estimate_cost(0)
    assert z["requests"] == 0 and z["usd_list"] == 0.0


# --- run_coro_blocking -----------------------------------------------------


def test_run_coro_blocking_inside_and_outside_a_loop():
    async def f():
        return 5

    assert pl.run_coro_blocking(f()) == 5

    async def outer():
        return pl.run_coro_blocking(f())

    assert asyncio.run(outer()) == 5


# --- label_content_ids (DB) ------------------------------------------------


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        connect(settings.test_database_url).close()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")
class TestLabelContentIds:
    @pytest.fixture(autouse=True)
    def _clean(self):
        from tests import _label_fixtures as fx

        fx.truncate()
        user = fx.make_user()
        cap = fx.make_capture(user)
        self.fx = fx
        self.user = user["id"]
        self.cids = [fx.make_page(user, cap, n, minute=i)[1] for i, n in enumerate("abc")]
        yield

    def _fake(self, kinds=None):
        def handler(idx, prompt):
            import re

            ids = [int(x) for x in re.findall(r"### page_id: (\d+)", prompt)]
            return json.dumps(
                {
                    "items": [
                        item(i, content_kind=(kinds or {}).get(n, "article_reference"))
                        for n, i in enumerate(ids)
                    ]
                }
            )

        return FakeLLM(handler)

    def _patch_llm(self, monkeypatch, llm):
        monkeypatch.setattr("backend.services.llm_service.LLMService", lambda: llm)

    def test_labels_stored_kind_written_one_cost_event(self, monkeypatch):
        llm = self._fake({0: "auth_login"})
        self._patch_llm(monkeypatch, llm)
        run = asyncio.run(pl.label_content_ids(self.cids, user_id=self.user))
        assert run.requests == 1 and set(run.labels) == set(self.cids)
        rows = self.fx.sql(
            "SELECT page_content_id, labeller_version, user_id, source FROM page_labels"
        )
        assert sorted(r[0] for r in rows) == sorted(self.cids)
        assert {(r[1], r[2], r[3]) for r in rows} == {(pl.labeller_version(), self.user, "model")}
        kinds = dict(self.fx.sql("SELECT id, content_kind FROM page_content"))
        assert sorted(kinds.values()) == ["article_reference", "article_reference", "auth_login"]
        ev = self.fx.sql(
            "SELECT event_type, model, input_tokens, output_tokens, cost_usd, metadata, user_id"
            " FROM cost_events"
        )
        assert len(ev) == 1
        etype, model, tin, tout, cost, meta, uid = ev[0]
        assert (etype, model, tin, tout, uid) == (
            "page_labelling",
            "claude-haiku-5-5",
            600,
            100,
            self.user,
        )
        assert float(cost) == pytest.approx(0.0011)
        assert meta == {
            "pages": 3,
            "requests": 1,
            "labeller_version": pl.labeller_version(),
        }

    def test_second_call_skips_already_labelled(self, monkeypatch):
        llm = self._fake()
        self._patch_llm(monkeypatch, llm)
        asyncio.run(pl.label_content_ids(self.cids, user_id=self.user))
        run = asyncio.run(pl.label_content_ids(self.cids, user_id=self.user))
        assert run.requests == 0 and len(llm.calls) == 1
        assert self.fx.sql("SELECT COUNT(*) FROM cost_events")[0][0] == 1

    def test_missing_label_leaves_content_kind_null_and_failed_request_is_isolated(
        self, monkeypatch
    ):
        monkeypatch.setattr(settings, "label_batch_size", 2)
        order = []

        def handler(idx, prompt):
            import re

            ids = [int(x) for x in re.findall(r"### page_id: (\d+)", prompt)]
            order.append(ids)
            if len(ids) == 1:
                return "{not json"
            return json.dumps({"items": [item(i) for i in ids]})

        self._patch_llm(monkeypatch, FakeLLM(handler))
        run = asyncio.run(pl.label_content_ids(self.cids, user_id=self.user))
        assert run.requests == 2 and run.failed_requests == 1 and len(run.labels) == 2
        kinds = [r[0] for r in self.fx.sql("SELECT content_kind FROM page_content ORDER BY id")]
        assert kinds.count(None) == 1 and kinds.count("article_reference") == 2
        assert self.fx.sql("SELECT COUNT(*) FROM page_labels")[0][0] == 2

    def test_fail_open_when_llm_cannot_be_built_or_db_fails(self, monkeypatch, caplog):
        def boom():
            raise RuntimeError("no key")

        monkeypatch.setattr("backend.services.llm_service.LLMService", boom)
        with caplog.at_level(logging.ERROR):
            run = asyncio.run(pl.label_content_ids(self.cids, user_id=self.user))
        assert run.labels == {} and "label_content_ids failed" in caplog.text
        assert self.fx.sql("SELECT COUNT(*) FROM page_labels")[0][0] == 0

    def test_cost_event_failure_keeps_labels(self, monkeypatch):
        self._patch_llm(monkeypatch, self._fake())
        from backend.db import trends_repo

        monkeypatch.setattr(trends_repo, "insert_cost_event", MagicMock(side_effect=RuntimeError))
        run = asyncio.run(pl.label_content_ids(self.cids, user_id=self.user))
        assert len(run.labels) == 3
        assert self.fx.sql("SELECT COUNT(*) FROM page_labels")[0][0] == 3
