"""Extension v2 phase 2: live watch sessions (ext_live_sessions).

While the user watches, the extension upserts one row every few seconds
over the websocket lane. On pause/ended the row merges into the real
cursor (AniStore.set_progress — the backward-allowed path, never the
forward-only D44 cursor) and is deleted. On power loss the row survives;
the boot sweep merges every leftover row, so DreaMedia always knows the
last watched position (design: Extension/Docs/extension-design.md §7).
"""
from __future__ import annotations

import logging
from typing import Optional

from returns.result import Failure, Result, Success

from Database.ani_store import AniStore
from Database.db import get_pool

log = logging.getLogger("dreamedia.ext.live")

_ani = AniStore()


async def upsert_position(
    user_id: int, entry_id: int, season: int, episode: int, position_seconds: int
) -> Result[bool, str]:
    if season < 1 or episode < 0 or position_seconds < 0:
        return Failure("invalid live position")
    pool = await get_pool()
    async with pool.acquire() as con:
        # Ownership + FK in one: the insert references ani_entries(id) and
        # the WHERE guard keeps another user's entry_id out.
        result = await con.execute(
            "INSERT INTO ext_live_sessions (user_id, entry_id, season, episode, position_seconds) "
            "SELECT $1, e.id, $3, $4, $5 FROM ani_entries e "
            "WHERE e.id = $2 AND e.user_id = $1 "
            "ON CONFLICT (user_id, entry_id) DO UPDATE SET "
            "season = EXCLUDED.season, episode = EXCLUDED.episode, "
            "position_seconds = EXCLUDED.position_seconds, updated_at = now()",
            user_id, entry_id, season, episode, position_seconds,
        )
    if not result.endswith("1"):
        return Failure("entry not found")
    return Success(True)


async def _merge_and_delete(con, user_id: int, entry_id: int) -> Optional[Failure]:
    """Merge one live row into the real cursor, then delete it. Runs inside
    the caller's connection/transaction when given."""
    row = await con.fetchrow(
        "SELECT season, episode, position_seconds FROM ext_live_sessions "
        "WHERE user_id = $1 AND entry_id = $2",
        user_id, entry_id,
    )
    if row is None:
        return None
    merged = await _ani.set_progress(
        user_id, entry_id, row["season"], row["episode"], row["position_seconds"]
    )
    if isinstance(merged, Failure):
        log.warning(
            "live merge failed user=%s entry=%s: %s — keeping the row",
            user_id, entry_id, merged.failure(),
        )
        return merged
    await con.execute(
        "DELETE FROM ext_live_sessions WHERE user_id = $1 AND entry_id = $2",
        user_id, entry_id,
    )
    return None


async def end_session(
    user_id: int, entry_id: int, season: int, episode: int, position_seconds: int
) -> Result[bool, str]:
    """Pause/ended: record the final position, then it becomes the real cursor."""
    upserted = await upsert_position(user_id, entry_id, season, episode, position_seconds)
    if isinstance(upserted, Failure):
        return upserted
    pool = await get_pool()
    async with pool.acquire() as con:
        failed = await _merge_and_delete(con, user_id, entry_id)
    if failed is not None:
        return failed
    return Success(True)


async def sweep_all() -> int:
    """Boot recovery: any live row means the last shutdown was unclean (or
    the tab died). Merge every row into its cursor; rows whose merge fails
    stay for inspection. Returns the number merged."""
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch("SELECT user_id, entry_id FROM ext_live_sessions")
    merged = 0
    for r in rows:
        async with pool.acquire() as con:
            failed = await _merge_and_delete(con, r["user_id"], r["entry_id"])
        if failed is None:
            merged += 1
    if rows:
        log.info("live-session sweep: merged %s/%s leftover row(s)", merged, len(rows))
    return merged
