"""Admin endpoints (D26): runtime settings, backups, restore, users.

The admin page talks to the backend over GraphQL for everything that is
ordinary data (settings, backups list, users, roles). Three things cannot be
GraphQL and live here as REST, deliberately and narrowly:

- `POST /admin/restore/upload` — multipart file upload of a dump
- `GET  /admin/backups/{file}` — binary download of a dump
- `GET  /admin/restore/status` — progress polling; GraphQL mutations are
  503'd while a restore runs, so the one endpoint that must answer during a
  restore cannot be a mutation.

Everything below still requires the admin role.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from returns.result import Failure

from Admin import backup, restore, settings, users
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


@router.get("/backups")
async def list_backups(_: int = Depends(require_admin)):
    """Available restore points, newest first."""
    return {"backups": await restore.list_backups()}


@router.get("/backups/{filename}")
async def download_backup(filename: str, _: int = Depends(require_admin)):
    """Download a dump. A dump holds every user's encrypted content, so this
    is admin-only and named exactly; no directory listing, no traversal."""
    target = await restore.resolve_backup(filename)
    if isinstance(target, Failure):
        return {"ok": False, "error": target.failure()}
    return FileResponse(
        target.unwrap(), media_type="application/octet-stream", filename=filename
    )


class RestoreBody(BaseModel):
    filename: str


@router.post("/restore")
async def restore_backup(body: RestoreBody, _: int = Depends(require_admin)):
    """DESTRUCTIVE: restore a named dump into the live database.

    Returns as soon as the job is accepted; poll `/admin/restore/status`.
    """
    result = await restore.start_restore(body.filename)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, "started": result.unwrap()}


@router.post("/restore/upload")
async def upload_restore(file: UploadFile = File(...), _: int = Depends(require_admin)):
    """Stage an uploaded dump. It is validated before it gets a real name;
    restoring it is a separate, explicit step."""
    result = await restore.stage_upload(file.file, file.filename or "")
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.get("/restore/status")
async def restore_status(_: int = Depends(require_admin)):
    return {"ok": True, **restore.restore_status()}


class RoleBody(BaseModel):
    role: str


@router.get("/users")
async def list_users(_: int = Depends(require_admin)):
    return {"users": await users.list_users()}


@router.post("/users/{user_id}/role")
async def set_role(user_id: int, body: RoleBody, actor: int = Depends(require_admin)):
    result = await users.set_role(actor, user_id, body.role)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, "role": result.unwrap()}
