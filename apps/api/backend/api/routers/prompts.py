"""Prompts dev-view routes.

GET    /api/prompts/summary                    active models, the registry by task, admin status
GET    /api/prompts/templates/{name}           one prompt's detail
PUT    /api/prompts/templates/{name}/override  save an override (admin context)
DELETE /api/prompts/templates/{name}/override  remove an override (admin context)
GET    /api/prompts/evals                      evaluation-harness runs (admin context)
GET    /api/prompts/evals/{run_id}             one run's detail (admin context)

Auth: verify_api_key on every route. The view is demo-visitable, but override
text and evaluation runs are deployment-local data, so only admin context
(an admin, or an admin acting as demo: the existing verify_admin_context gate)
receives them. Other roles get registry text and counts, never deployment-wide
data (the Pipeline R12 lesson). Writes go to settings.prompt_overrides_path,
outside the repo, never to the tracked overrides.json. Registered late in
main.py, after verify_api_key exists, like the other dev views.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel

from backend.api.main import get_current_claims, verify_admin_context, verify_api_key
from backend.prompts import override_store
from backend.prompts.templates import PROMPTS, _load_overrides
from backend.services import eval_runs, prompt_view

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prompts", tags=["Prompts"])

PromptName = Annotated[str, Path(pattern=r"^[a-z0-9_]{1,80}$")]
RunId = Annotated[str, Path(pattern=eval_runs.RUN_ID_PATTERN)]

NOT_CONFIGURED = "Prompt overrides are not configured on this deployment."
UNREADABLE = "The override file can't be read; fix or remove it on the server."
WRITE_FAILED = "The override file couldn't be written."


class OverrideBody(BaseModel):
    template: str


async def _admin_context(user_id: int, claims: dict) -> bool:
    """Same predicate as the verify_admin_context gate, as a boolean."""
    try:
        await verify_admin_context(user_id=user_id, claims=claims)
    except HTTPException:
        return False
    return True


def _known(name: str) -> None:
    if name not in PROMPTS:
        raise HTTPException(status_code=404, detail="prompt not found")


def _write_error(exc: Exception) -> HTTPException:
    if isinstance(exc, override_store.OverridesNotConfigured):
        return HTTPException(status_code=409, detail=NOT_CONFIGURED)
    if isinstance(exc, override_store.OverrideFileUnreadable):
        return HTTPException(status_code=409, detail=UNREADABLE)
    if isinstance(exc, override_store.InvalidTemplate):
        return HTTPException(status_code=422, detail=str(exc))
    logger.exception("prompt override write failed")
    return HTTPException(status_code=500, detail=WRITE_FAILED)


@router.get("/summary")
async def prompts_summary(
    user_id: Annotated[int, Depends(verify_api_key)],
    claims: Annotated[dict, Depends(get_current_claims)],
) -> dict:
    admin = await _admin_context(user_id, claims)
    overrides = _load_overrides()
    return {
        "models": prompt_view.build_models(),
        "unused_models": prompt_view.build_unused_models(),
        "tasks": prompt_view.build_tasks(overrides),
        "admin": (
            {
                "overrides": override_store.status(),
                "evals": {"configured": eval_runs.runs_dir() is not None},
            }
            if admin
            else None
        ),
    }


@router.get("/templates/{name}")
async def prompt_template(
    name: PromptName,
    user_id: Annotated[int, Depends(verify_api_key)],
    claims: Annotated[dict, Depends(get_current_claims)],
) -> dict:
    _known(name)
    return prompt_view.template_detail(
        name, _load_overrides(), await _admin_context(user_id, claims)
    )


@router.put("/templates/{name}/override")
async def save_override(
    name: PromptName,
    body: OverrideBody,
    user_id: int = Depends(verify_admin_context),
) -> dict:
    _known(name)
    try:
        result = override_store.save(name, body.template)
    except (
        override_store.OverridesNotConfigured,
        override_store.OverrideFileUnreadable,
        override_store.InvalidTemplate,
        OSError,
    ) as exc:
        raise _write_error(exc) from exc
    logger.info(
        "prompt override saved: %s by user %s (cleared=%s)", name, user_id, result["cleared"]
    )
    return {**prompt_view.template_detail(name, _load_overrides(), True), **result}


@router.delete("/templates/{name}/override")
async def reset_override(
    name: PromptName,
    user_id: int = Depends(verify_admin_context),
) -> dict:
    _known(name)
    try:
        removed = override_store.reset(name)
    except (
        override_store.OverridesNotConfigured,
        override_store.OverrideFileUnreadable,
        OSError,
    ) as exc:
        raise _write_error(exc) from exc
    logger.info("prompt override reset: %s by user %s (removed=%s)", name, user_id, removed)
    return {**prompt_view.template_detail(name, _load_overrides(), True), "removed": removed}


@router.get("/evals")
async def eval_runs_list(user_id: int = Depends(verify_admin_context)) -> dict:
    st = eval_runs.status()
    if not (st["configured"] and st["readable"]):
        return {**st, "runs": [], "skipped": 0}
    return {**st, **eval_runs.scan(eval_runs.runs_dir())}


@router.get("/evals/{run_id}")
async def eval_run_detail(run_id: RunId, user_id: int = Depends(verify_admin_context)) -> dict:
    root = eval_runs.runs_dir()
    detail = eval_runs.load_detail(root, run_id) if root is not None and root.is_dir() else None
    if detail is None:
        raise HTTPException(status_code=404, detail="run not found")
    return detail
