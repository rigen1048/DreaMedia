"""Admin endpoints (D26): runtime settings + backups. Admin role required."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from returns.result import Failure

from Admin import backup, settings
from App.deps import require_admin

router = APIRouter(prefix="/admin", tags=["admin"])


class SettingBody(BaseModel):
    value: str


@router.get("/settings")
async def get_settings(_: int = Depends(require_admin)):
    return {"settings": await settings.get_all()}


@router.post("/settings/{key}")
async def set_setting(key: str, body: SettingBody, _: int = Depends(require_admin)):
    result = await settings.set_value(key, body.value)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, key: result.unwrap()}


@router.post("/backup")
async def run_backup(_: int = Depends(require_admin)):
    result = await backup.run_backup()
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, "file": result.unwrap()}
