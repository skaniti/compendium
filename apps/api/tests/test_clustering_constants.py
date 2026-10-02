"""The clustering parameters the Clusters dev view displays are named constants
that the pipeline itself uses (no inline literals left to drift)."""

import inspect

from backend.services import clustering_service as cs


def test_named_constants():
    assert cs.NAMING_TEMPERATURE == 0.3
    assert cs.NAMING_MAX_TOKENS == 30
    assert cs.NAMING_SAMPLE_SIZE == 10
    assert cs.MAX_EDGES_PER_CLUSTER == 3
    assert cs.MIN_CLUSTER_SIZE_DIVISOR == 150


def test_call_sites_use_the_constants():
    body = inspect.getsource(cs).replace(cs.__doc__ or "", "")
    for literal in (
        "temperature=0.3",
        '"temperature": 0.3',
        "max_tokens=30",
        '"max_tokens": 30',
        "cluster_pages[:10]",
        "// 150",
        "MAX_EDGES_PER_CLUSTER = 3\n            ",
    ):
        assert literal not in body, literal
