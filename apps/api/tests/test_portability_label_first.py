"""Portability-benchmark label-first pieces: batch I/O, LLM shelf state machine, threshold driver."""

import json

import numpy as np

from evaluation.clustering.portability import batch_io, llm_shelves as ls, thresholds as th


def _msg(text, i=10, o=5):
    return {"content": [{"type": "text", "text": text}], "usage": {"input_tokens": i, "output_tokens": o}}


def test_label_request_shape_and_parse(tmp_path):
    rows = [{"id": k, "title": f"t{k}", "url": f"https://p.example.test/{k}", "text": "x" * 400} for k in range(10)]
    out = tmp_path / "req.jsonl"
    stats = batch_io.write_label_requests(rows, out, "lab")
    assert stats == {"requests": 2, "pages": 10}
    lines = [json.loads(line) for line in out.read_text().splitlines()]
    p = lines[0]["params"]
    assert "temperature" not in p and "tool_choice" not in p
    assert p["output_config"]["format"]["type"] == "json_schema"
    assert p["max_tokens"] == 220 * 8 + 400
    item = {
        "page_id": 0, "category": "science_nature", "subtopic": "Galaxy clusters", "entity": None,
        "specificity": "narrow_topic", "content_kind": "article_reference", "knowledge_value": "keep",
        "evidence_level": "text", "language": "en", "flags": [], "private_sensitive": False,
        "confidence": 0.9,
    }
    res = tmp_path / "res.jsonl"
    res.write_text(json.dumps({"custom_id": "lab_000000", "result": {"type": "succeeded",
                   "message": _msg(json.dumps({"items": [item]}))}}) + "\n")
    parsed = batch_io.parse_label_results(res, {"lab_000000": [0, 1], "lab_000001": [2]})
    assert set(parsed["labels"]) == {0}
    assert parsed["failed_requests"] == ["lab_000001"]
    assert parsed["missing_pages"] == 2


def test_llm_shelves_group_then_place_with_omission_retry():
    st = ls.ShelfState("fixed")
    items = [(1, "food_cooking", "Bread baking"), (2, "food_cooking", "bread baking"),
             (3, "food_cooking", "Sourdough starters"), (4, "food_cooking", "Knife sharpening")]
    reqs, jobs = ls.build_requests(st, items, "w1")
    assert len(reqs) == 1 and next(iter(jobs.values()))["op"] == "group"
    assert len(next(iter(jobs.values()))["strings"]) == 3  # memo by normalised string
    cid = reqs[0]["custom_id"]
    # the model leaves label 3 out: it stays unplaced and is retried by the next wave
    ls.apply_result(st, jobs[cid], json.dumps({"shelves": [{"name": "Bread baking", "members": [1, 2]}]}))
    assert st.assign(items)[1] == st.assign(items)[3] != -1
    assert st.assign(items)[4] == -1
    reqs, jobs = ls.build_requests(st, items, "w2")
    assert [j["op"] for j in jobs.values()] == ["place"]
    sid = st.assign(items)[1]
    assert f"[{sid}] Bread baking" in reqs[0]["params"]["messages"][0]["content"]
    ls.apply_result(st, next(iter(jobs.values())), json.dumps(
        {"items": [{"i": 1, "shelf_id": None, "new_shelf": "Kitchen knives", "category_id": None}]}))
    a = st.assign(items)
    assert a[4] not in (-1, sid)
    assign, sup = ls.cluster_assignment(st, items, min_cluster_size=3)
    assert assign[1] == assign[2] == assign[3] and assign[4] == -1 and sup[1] == "food_cooking"
    assert ls.ShelfState.from_json(json.loads(json.dumps(st.to_json()))).assign(items) == a


def test_llm_shelves_induced_lists_all_shelves():
    st = ls.ShelfState("induced")
    items = [(1, "science_nature", "Galaxy clusters"), (2, "food_cooking", "Bread baking")]
    reqs, jobs = ls.build_requests(st, items, "w1")
    ls.apply_result(st, next(iter(jobs.values())), json.dumps({"categories": [
        {"name": "Astronomy", "shelves": [{"name": "Galaxies", "members": [1]}]},
        {"name": "Cooking", "shelves": [{"name": "Breads", "members": [2]}]}]}))
    assert st.categories == ["Astronomy", "Cooking"]
    reqs, jobs = ls.build_requests(st, items + [(3, "science_nature", "Dwarf galaxies")], "w2")
    text = reqs[0]["params"]["messages"][0]["content"]
    assert "Galaxies" in text and "Breads" in text


def test_threshold_driver_snapshots_and_ask_cache():
    rng = np.random.default_rng(0)
    base = rng.normal(size=(3, 16))
    vec = {"a": base[0], "a2": base[0] + 0.05 * rng.normal(size=16), "b": base[1], "c": base[2]}

    def embed(texts):
        return np.vstack([vec[t] / np.linalg.norm(vec[t]) for t in texts])

    items = [(i, {"category": "science_nature", "subtopic": s}) for i, s in enumerate(["a", "a2", "b", "c"])]
    order = {i: i for i in range(4)}
    asker = th.AskCache()
    snaps = th.run_canonicaliser(items, embed, {}, 0.95, -1.0, asker, (2, 4), order)
    so2, _, _ = snaps[2]
    so4, shelves4, timing = snaps[4]
    assert set(so2) == {0, 1} and set(so4) == {0, 1, 2, 3}
    assert all(so4[k] == v for k, v in so2.items())  # nested sizes: earlier pages unchanged
    assert asker.pending and asker.defaulted == asker.asked  # unknown prompts answer no
    assert timing["asked"] == asker.asked
    yes = {k: True for k in asker.pending}
    snaps = th.run_canonicaliser(items, embed, {}, 0.95, -1.0, th.AskCache(yes), (4,), order)
    assert len(set(snaps[4][0].values())) < len(set(so4.values()))
