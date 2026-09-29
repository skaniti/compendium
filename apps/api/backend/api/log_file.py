"""Optional JSON file log handler for the API (LOG_FILE_PATH)."""

import logging
import logging.handlers
import os
from pathlib import Path

_default_logger = logging.getLogger(__name__)

_FILE_MODE = 0o644


class _Mode644WatchedFileHandler(logging.handlers.WatchedFileHandler):
    """WatchedFileHandler that creates files 0644 regardless of umask.

    Watched (reopen on rename/unlink) so logrotate works with either
    ``copytruncate`` or rename-style rotation.
    """

    def _open(self):
        fd = os.open(
            self.baseFilename,
            os.O_WRONLY | os.O_CREAT | os.O_APPEND,
            _FILE_MODE,
        )
        try:
            # os.open's mode is masked by umask; force it on fresh creation.
            os.fchmod(fd, _FILE_MODE)
        except OSError:
            pass
        return os.fdopen(fd, self.mode, encoding=self.encoding, errors=self.errors)


def attach_file_handler(
    target: logging.Logger,
    path: str,
    formatter: logging.Formatter,
    level: int,
    warn_logger: logging.Logger | None = None,
) -> logging.Handler | None:
    """Attach a JSON file handler to ``target`` when ``path`` is non-empty.

    Never raises: on failure a WARNING is logged and None is returned so the
    API keeps running on stdout logging alone.
    """
    if not path:
        return None
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        handler = _Mode644WatchedFileHandler(path, encoding="utf-8")
    except Exception as exc:  # noqa: BLE001 - startup must not crash
        (warn_logger or _default_logger).warning(
            "log file disabled: cannot open %s (%s)", path, exc
        )
        return None
    handler.setFormatter(formatter)
    handler.setLevel(level)
    target.addHandler(handler)
    return handler
