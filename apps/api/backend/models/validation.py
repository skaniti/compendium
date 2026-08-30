"""Request models for the archive-validation endpoints."""

from typing import Literal

from pydantic import BaseModel, Field


class ValidateArchiveRequest(BaseModel):
    """Label an archive decision correct / incorrect / skip."""

    label: Literal["correct", "incorrect", "skip"]
    note: str | None = Field(default=None, max_length=500)
