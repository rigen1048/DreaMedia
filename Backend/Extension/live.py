"""Extension v2 phase 2: race-safe live watch sessions.

Each client event carries a millisecond timestamp. A per-entry watermark is
locked and advanced in the same transaction as the live row/cursor write, so
late progress packets cannot resurrect or overwrite a session after pause or
ended. Older extension clients omit the timestamp; those writes receive an
increasing server-side timestamp while holding the same lock.
"""
from __future__ import annotations

import logging
import time
from typing import Optional, Union

from returns.result import Failure, Result, Success

from Database.db import get_pool

log = logging.getLogger("dreamedia.ext.live")
EventTime = Optional[Union[int, str]]


def _parse_event_time(value: EventTime) -> Optional[int]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError("invalid live event timestamp")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValueError("invalid live event timestamp") from None
    if parsed < 0:
        raise ValueError("invalid live event timestamp")
    return parsed


async def _lock_watermark(con, user_id: int, entry_id: int, season: Optional[int] = None):
    """Validate ownership (and optionally season), create the fence lazily,
    and lock it until the caller's transaction completes."""
    valid = await con.fetchval(
        "SELECT 1 FROM ani_entries e WHERE e.id = $2 AND e.user_id = $1 "
        "AND ($3::INTEGER IS NULL OR EXISTS ("
        "SELECT 1 FROM ani_seasons s WHERE s.entry_id = e.id AND s.season_no = $3))",
        user_id, entry_id, season,
    )
    if valid is None:
        return None
    await con.execute(
        "INSERT INTO ext_live_watermarks (user_id, entry_id, last_event_ms) "
        "SELECT $1, e.id, COALESCE((EXTRACT(EPOCH FROM l.updated_at) * 1000)::BIGINT, 0) "
        "FROM ani_entries e LEFT JOIN ext_live_sessions l "
        "ON l.user_id = $1 AND l.entry_id = e.id "
        "WHERE e.id = $2 AND e.user_id = $1 "
        "ON CONFLICT (user_id, entry_id) DO NOTHING",
        user_id, entry_id,
    )
    return await con.fetchrow(
        "SELECT last_event_ms FROM ext_live_watermarks "
        "WHERE user_id = $1 AND entry_id = $2 FOR UPDATE",
        user_id, entry_id,
    )


def _next_event_time(requested: Optional[int], last_event_ms: int) -> int:
    if requested is None:
        return max(int(time.time() * 1000), last_event_ms + 1)
    return requested


async def _save_live_position(con, user_id: int, entry_id: int, season: int,
                              episode: int, position_seconds: int) -> None:
    await con.execute(
        "INSERT INTO ext_live_sessions (user_id, entry_id, season, episode, position_seconds) "
        "VALUES ($1, $2, $3, $4, $5) "
        "ON CONFLICT (user_id, entry_id) DO UPDATE SET "
        "season = EXCLUDED.season, episode = EXCLUDED.episode, "
        "position_seconds = EXCLUDED.position_seconds, updated_at = now()",
        user_id, entry_id, season, episode, position_seconds,
    )


async def upsert_position(
    user_id: int, entry_id: int, season: int, episode: int,
    position_seconds: int, event_time_ms: EventTime = None,
) -> Result[bool, str]:
    if season < 1 or episode < 0 or position_seconds < 0:
        return Failure("invalid live position")
    try:
        requested_event_ms = _parse_event_time(event_time_ms)
    except ValueError as error:
        return Failure(str(error))

    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            state = await _lock_watermark(con, user_id, entry_id, season)
            if state is None:
                return Failure("entry or season not found")
            last_event_ms = int(state["last_event_ms"])
            event_ms = _next_event_time(requested_event_ms, last_event_ms)
            if event_ms <= last_event_ms:
                # Delayed progress from before a pause/end; it must not
                # recreate a session which the final event already closed.
                return Success(True)
            await con.execute(
                "UPDATE ext_live_watermarks SET last_event_ms = $3 "
                "WHERE user_id = $1 AND entry_id = $2",
                user_id, entry_id, event_ms,
            )
            await _save_live_position(con, user_id, entry_id, season, episode, position_seconds)
    return Success(True)


async def _merge_cursor(con, user_id: int, entry_id: int, season: int,
                        episode: int, position_seconds: int) -> Optional[Failure]:
    """Apply AniStore.set_progress semantics on the caller's connection."""
    entry = await con.fetchrow(
        "SELECT list FROM ani_entries WHERE id = $1 AND user_id = $2 FOR UPDATE",
        entry_id, user_id,
    )
    if entry is None:
        return Failure("entry not found")
    season_exists = await con.fetchval(
        "SELECT 1 FROM ani_seasons WHERE entry_id = $1 AND season_no = $2",
        entry_id, season,
    )
    if season_exists is None:
        return Failure(f"season {season} not in this entry's chain")
    await con.execute(
        "UPDATE ani_entries SET cursor_season = $3, cursor_episode = $4, "
        "cursor_position_seconds = $5 WHERE id = $1 AND user_id = $2",
        entry_id, user_id, season, episode, position_seconds,
    )
    if entry["list"] == "next_sequel":
        await con.execute(
            "UPDATE ani_entries SET list = 'watching' WHERE id = $1 AND user_id = $2",
            entry_id, user_id,
        )
    await con.execute(
        "UPDATE ani_seasons SET watched = "
        "(season_no < $2) OR "
        "(season_no = $2 AND episodes_total IS NOT NULL AND $3 >= episodes_total) "
        "WHERE entry_id = $1",
        entry_id, season, episode,
    )
    return None


async def end_session(
    user_id: int, entry_id: int, season: int, episode: int,
    position_seconds: int, event_time_ms: EventTime = None,
) -> Result[bool, str]:
    """Atomically record the final position, merge it, and close the row."""
    if season < 1 or episode < 0 or position_seconds < 0:
        return Failure("invalid live position")
    try:
        requested_event_ms = _parse_event_time(event_time_ms)
    except ValueError as error:
        return Failure(str(error))

    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            state = await _lock_watermark(con, user_id, entry_id, season)
            if state is None:
                return Failure("entry or season not found")
            last_event_ms = int(state["last_event_ms"])
            event_ms = _next_event_time(requested_event_ms, last_event_ms)
            if event_ms <= last_event_ms:
                # A delayed end event is also stale; do not move the cursor.
                return Success(True)
            await con.execute(
                "UPDATE ext_live_watermarks SET last_event_ms = $3 "
                "WHERE user_id = $1 AND entry_id = $2",
                user_id, entry_id, event_ms,
            )
            await _save_live_position(con, user_id, entry_id, season, episode, position_seconds)
            failed = await _merge_cursor(con, user_id, entry_id, season, episode, position_seconds)
            if failed is not None:
                # Retain the latest row for recovery/inspection if the merge
                # cannot be completed; the watermark still fences older writes.
                log.warning(
                    "live merge failed user=%s entry=%s: %s — keeping the row",
                    user_id, entry_id, failed.failure(),
                )
                return failed
            await con.execute(
                "DELETE FROM ext_live_sessions WHERE user_id = $1 AND entry_id = $2",
                user_id, entry_id,
            )
    return Success(True)


async def _merge_and_delete(con, user_id: int, entry_id: int) -> tuple[bool, Optional[Failure]]:
    """Merge one leftover row while its watermark is locked by the caller."""
    state = await _lock_watermark(con, user_id, entry_id)
    if state is None:
        return False, Failure("entry not found")
    row = await con.fetchrow(
        "SELECT season, episode, position_seconds FROM ext_live_sessions "
        "WHERE user_id = $1 AND entry_id = $2 FOR UPDATE",
        user_id, entry_id,
    )
    if row is None:
        return False, None
    failed = await _merge_cursor(
        con, user_id, entry_id, row["season"], row["episode"], row["position_seconds"]
    )
    if failed is not None:
        log.warning(
            "live sweep merge failed user=%s entry=%s: %s — keeping the row",
            user_id, entry_id, failed.failure(),
        )
        return False, failed
    await con.execute(
        "DELETE FROM ext_live_sessions WHERE user_id = $1 AND entry_id = $2",
        user_id, entry_id,
    )
    return True, None


async def sweep_all() -> int:
    """Merge leftover live rows into cursors; rows whose merge fails stay."""
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch("SELECT user_id, entry_id FROM ext_live_sessions")
    merged = 0
    for row in rows:
        async with pool.acquire() as con:
            async with con.transaction():
                did_merge, failed = await _merge_and_delete(con, row["user_id"], row["entry_id"])
        if did_merge and failed is None:
            merged += 1
    if rows:
        log.info("live-session sweep: merged %s/%s leftover row(s)", merged, len(rows))
    return merged
