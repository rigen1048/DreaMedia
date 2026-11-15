"""Admin GraphQL surface (D26): settings, backups, users, restore control.

The admin page is part of the app, so it speaks the same single GraphQL API
as everything else. Only three operations cannot: the multipart dump upload,
the dump download, and restore-progress polling (mutations are 503'd during a
restore, so progress must be a GET). Those live in Admin/router.py.

Every resolver here re-checks the role against the database — the UI hides
the page, but hiding is not authorisation.
"""
from __future__ import annotations

from typing import List, Optional

import strawberry
from returns.result import Failure
from strawberry.types import Info

from Admin import backup, restore, settings, users
from Config.Hardcoded.limits import MIN_BACKUPS_KEPT
from Database.db import get_pool


async def _require_admin(info: Info) -> int:
    from Auth import auth

    request = info.context["request"]
    token = request.cookies.get("dreamedia")
    user_id = await auth.resolve_session(token or "")
    if user_id is None:
        raise ValueError("not authenticated")
    pool = await get_pool()
    async with pool.acquire() as con:
        role = await con.fetchval("SELECT role FROM users WHERE id = $1", user_id)
    if role != "admin":
        raise ValueError("Admin only")
    return user_id


@strawberry.type
class AdminBackup:
    file: str
    size: int
    mtime: int


@strawberry.type
class AdminSetting:
    key: str
    value: str
    floor: Optional[str]
    kind: str


@strawberry.type
class AdminUser:
    id: int
    username: str
    role: str
    created_at: str


@strawberry.type
class RestoreStatus:
    phase: str
    active: bool
    file: Optional[str]
    started_at: Optional[float]
    finished_at: Optional[float]
    snapshot: Optional[str]
    error: Optional[str]
    message: Optional[str]
    sessions_dropped: int


@strawberry.type
class AdminOverview:
    backup_count: int
    latest_backup_file: Optional[str]
    latest_backup_at: Optional[int]
    keep_latest: int
    frequency_hours: int
    backup_dir: str
    user_count: int
    admin_count: int
    restore: RestoreStatus


def _restore_status() -> RestoreStatus:
    state = restore.restore_status()
    return RestoreStatus(
        phase=str(state.get("phase") or "idle"),
        active=bool(state.get("active")),
        file=state.get("file"),
        started_at=state.get("startedAt"),
        finished_at=state.get("finishedAt"),
        snapshot=state.get("snapshot"),
        error=state.get("error"),
        message=state.get("message"),
        sessions_dropped=int(state.get("sessionsDropped") or 0),
    )


@strawberry.type
class AdminQuery:
    @strawberry.field
    async def admin_overview(self, info: Info) -> AdminOverview:
        await _require_admin(info)
        backups = await restore.list_backups()
        values = await settings.get_all()
        listed = await users.list_users()
        return AdminOverview(
            backup_count=len(backups),
            latest_backup_file=backups[0]["file"] if backups else None,
            latest_backup_at=backups[0]["mtime"] if backups else None,
            keep_latest=int(values.get("backup_keep_latest") or MIN_BACKUPS_KEPT),
            frequency_hours=int(values.get("backup_frequency_hours") or 24),
            backup_dir=str(values.get("backup_dir") or "./backups"),
            user_count=len(listed),
            admin_count=sum(1 for user in listed if user["role"] == "admin"),
            restore=_restore_status(),
        )

    @strawberry.field
    async def admin_backups(self, info: Info) -> List[AdminBackup]:
        await _require_admin(info)
        return [
            AdminBackup(file=row["file"], size=int(row["size"]), mtime=int(row["mtime"]))
            for row in await restore.list_backups()
        ]

    @strawberry.field
    async def admin_settings(self, info: Info) -> List[AdminSetting]:
        await _require_admin(info)
        return [
            AdminSetting(
                key=row["key"], value=row["value"], floor=row["floor"], kind=row["kind"]
            )
            for row in await settings.describe()
        ]

    @strawberry.field
    async def admin_users(self, info: Info) -> List[AdminUser]:
        await _require_admin(info)
        return [
            AdminUser(
                id=row["id"], username=row["username"], role=row["role"],
                created_at=row["createdAt"],
            )
            for row in await users.list_users()
        ]


@strawberry.type
class AdminMutation:
    @strawberry.field
    async def admin_set_setting(self, info: Info, key: str, value: str) -> str:
        await _require_admin(info)
        result = await settings.set_value(key, value)
        if isinstance(result, Failure):
            raise ValueError(result.failure())
        return result.unwrap()

    @strawberry.field
    async def admin_run_backup(self, info: Info) -> str:
        await _require_admin(info)
        result = await backup.run_backup()
        if isinstance(result, Failure):
            raise ValueError(result.failure())
        return result.unwrap()

    @strawberry.field
    async def admin_start_restore(self, info: Info, filename: str) -> bool:
        await _require_admin(info)
        result = await restore.start_restore(filename)
        if isinstance(result, Failure):
            raise ValueError(result.failure())
        return True

    @strawberry.field
    async def admin_set_user_role(self, info: Info, user_id: int, role: str) -> str:
        actor = await _require_admin(info)
        result = await users.set_role(actor, user_id, role)
        if isinstance(result, Failure):
            raise ValueError(result.failure())
        return result.unwrap()

    @strawberry.field
    async def admin_delete_user(self, info: Info, user_id: int) -> bool:
        actor = await _require_admin(info)
        result = await users.delete_user(actor, user_id)
        if isinstance(result, Failure):
            raise ValueError(result.failure())
        return True

    @strawberry.field
    async def admin_reset_password(self, info: Info, user_id: int, password: str) -> bool:
        await _require_admin(info)
        result = await users.reset_password(user_id, password)
        if isinstance(result, Failure):
            raise ValueError(result.failure())
        return True
