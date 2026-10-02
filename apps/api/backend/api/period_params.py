"""Query-parameter helpers shared by the period-scoped dev-view routers."""

from __future__ import annotations

from fastapi import HTTPException, Query
from psycopg2 import DataError
from psycopg2.errors import InvalidParameterValue

from backend.db import period


def tz_param(tz: str = Query("UTC")) -> str:
    """The viewer's IANA zone; an unknown name is a 422."""
    try:
        period.validate_tz(tz)
    except ValueError:
        raise HTTPException(status_code=422, detail="invalid time zone") from None
    return tz


def guard_tz(fn, *args, **kwargs):
    """Run a repo call; a zone name Postgres doesn't know is a 422, not a 500."""
    try:
        return fn(*args, **kwargs)
    except (InvalidParameterValue, DataError):
        raise HTTPException(status_code=422, detail="invalid time zone") from None
