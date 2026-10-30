"""Admin-editable deployment settings (D26), with hardcoded floors (D2/D13).

.env seeds the defaults at first boot; the settings table is the live
value; an admin changes it at runtime. Floors from Config/Hardcoded can
never be overridden by .env or admin — that's the D2 deal.
"""
from __future__ import annotations

import os

from returns.result import Failure, Result, Success

from Config.Hardcoded.limits import MIN_BACKUPS_KEPT
from Database.db import get_pool

_DEFAULTS = {
    "backup_dir": ("BACKUP_DIR", "./backups"),
    "backup_keep_latest": ("BACKUP_KEEP_LATEST", "5"),
    "backup_frequency_hours": ("BACKUP_FREQUENCY_HOURS", "24"),
}

# key -> (type, floor) — floors are the untouchable part of D2.
_FLOORS: dict[str, tuple[type, float | None]] = {
    "backup_dir": (str, None),
    "backup_keep_latest": (int, MIN_BACKUPS_KEPT),
    "backup_frequency_hours": (int, 1),
}


async def seed_defaults() -> None:
    """Insert .env-sourced defaults for keys that don't exist yet."""
    pool = await get_pool()
    async with pool.acquire() as con:
        for key, (env_var, fallback) in _DEFAULTS.items():
            await con.execute(
                "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
                key,
                os.environ.get(env_var, fallback),
            )


async def get_all() -> dict[str, str]:
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch("SELECT key, value FROM settings")
    return {r["key"]: r["value"] for r in rows}


async def get_typed(key: str):
    values = await get_all()
    raw = values.get(key)
    if raw is None:
        return None
    typ, _ = _FLOORS.get(key, (str, None))
    return typ(raw)


async def set_value(key: str, value: str) -> Result[str, str]:
    """Admin set — floors enforced, so a foot-gun value is rejected."""
    if key not in _FLOORS:
        return Failure(f"Unknown setting: {key}")
    typ, floor = _FLOORS[key]
    try:
        typed = typ(value)
    except (TypeError, ValueError):
        return Failure(f"Invalid value for {key}: {value!r}")
    if floor is not None and typed < floor:
        return Failure(
            f"{key} cannot be below {floor} (hardcoded floor — Config/Hardcoded/limits.py)"
        )
    pool = await get_pool()
    async with pool.acquire() as con:
        await con.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) "
            "ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()",
            key,
            str(typed),
        )
    return Success(str(typed))
