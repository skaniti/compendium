"""File log handler wiring (server audit + ops journal, task 4)."""

import json
import logging
import logging.handlers
import os
import stat

import pytest
from pythonjsonlogger import json as json_log

from backend.api.log_file import attach_file_handler


def _formatter():
    return json_log.JsonFormatter(
        fmt="%(asctime)s %(name)s %(levelname)s %(message)s",
        rename_fields={"asctime": "timestamp", "levelname": "level"},
    )


def _file_handlers(lg):
    return [h for h in lg.handlers if isinstance(h, logging.handlers.WatchedFileHandler)]


@pytest.fixture
def fresh_logger():
    lg = logging.getLogger("test_log_file_handler.fresh")
    lg.handlers = []
    lg.propagate = False
    lg.setLevel(logging.DEBUG)
    yield lg
    for h in list(lg.handlers):
        h.close()
    lg.handlers = []


def test_attaches_one_watched_handler_and_writes_json_line(tmp_path, fresh_logger):
    path = tmp_path / "sub" / "api.jsonl"
    fmt = _formatter()
    h = attach_file_handler(fresh_logger, str(path), fmt, logging.INFO)
    assert h is not None
    files = [x for x in fresh_logger.handlers if isinstance(x, logging.handlers.WatchedFileHandler)]
    assert files == [h]
    assert h.formatter is fmt
    assert h.level == logging.INFO

    fresh_logger.info("hello file")
    fresh_logger.debug("below level")
    h.flush()
    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["message"] == "hello file"
    assert rec["level"] == "INFO"
    assert "timestamp" in rec


def test_file_mode_is_0644_under_restrictive_umask(tmp_path, fresh_logger):
    path = tmp_path / "api.jsonl"
    old = os.umask(0o077)
    try:
        h = attach_file_handler(fresh_logger, str(path), _formatter(), logging.INFO)
        assert h is not None
        fresh_logger.info("x")
        h.flush()
    finally:
        os.umask(old)
    assert stat.S_IMODE(path.stat().st_mode) == 0o644


def test_empty_path_attaches_nothing(fresh_logger):
    assert attach_file_handler(fresh_logger, "", _formatter(), logging.INFO) is None
    assert not _file_handlers(fresh_logger)


def test_unwritable_path_warns_and_does_not_raise(tmp_path, fresh_logger, capsys):
    blocker = tmp_path / "afile"
    blocker.write_text("x")
    bad = blocker / "api.jsonl"  # parent is a file, not a dir
    warned = logging.getLogger("test_log_file_handler.warn")
    records = []
    warned.addHandler(type("H", (logging.Handler,), {"emit": lambda s, r: records.append(r)})())
    h = attach_file_handler(fresh_logger, str(bad), _formatter(), logging.INFO, warn_logger=warned)
    assert h is None
    assert not _file_handlers(fresh_logger)
    assert any(r.levelno == logging.WARNING for r in records)
