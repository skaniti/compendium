"""Regression guard: the is_learning backfill must be importable from backend/.

The deployed image copies backend/ but NOT the top-level scripts/ dir, so the
nightly catch-up's learning pass (backend.services.catchup._classify_learning)
must import the backfill from backend.scripts. Importing it from top-level
scripts/ raised ModuleNotFoundError in the running container (2026-06-20),
which the catch-up swallowed -> classified_done=False every nightly cycle.
"""
import inspect


def test_learning_backfill_importable_from_backend_scripts():
    from backend.scripts.backfill_learning_classification import main

    assert inspect.iscoroutinefunction(main)


def test_catchup_imports_learning_from_backend_scripts():
    import backend.services.catchup as catchup

    src = inspect.getsource(catchup._classify_learning)
    assert "from backend.scripts.backfill_learning_classification" in src
    # guard against regression to the top-level scripts/ import that the
    # deployed image cannot resolve
    assert "from scripts.backfill_learning_classification" not in src
