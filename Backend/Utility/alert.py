"""Alerts: backend-driven messages to the frontend's bell icon (D60/D61).

Alerts exist for UNHAPPY PATHS ONLY — "we think the channel got deleted",
"we cannot access the internet", "last seen video may got deleted". The
feed is frontend-driven pull from the media tables (yt_videos, ani_events);
pipelines must never write feed items here.

The PostgreSQL `alerts` table is the single source of truth for alert
history, bell hydration, and read state. Rows are encrypted with the
owning user's vault key; a locked vault (D9) skips the alert rather than
storing plaintext.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Optional

from Database import vault
from Database.crypto import encrypt
from Database.db import get_pool
from Utility.logs import log

async def send_alert(
    user_id: int,
    media: str,
    kind: str,
    payload: Dict[str, Any],
    *,
    title: Optional[str] = None,
    message: Optional[str] = None,
    level: str = "info",
    url: Optional[str] = None,
) -> Optional[int]:
    """Store one alert in PostgreSQL. Never raises; returns its row id or None."""
    key = await vault.get(user_id)
    if key is None:
        log.warning("alert skipped (vault locked, D9): user=%s %s", user_id, kind)
        return None
    record = {
        "title": title or payload.get("title") or kind.replace("_", " ").title(),
        "message": message or payload.get("message") or "",
        "level": level,
        "url": url,
        "payload": payload,
    }
    blob = encrypt(key, json.dumps(record, default=str))
    try:
        pool = await get_pool()
        async with pool.acquire() as con:
            row = await con.fetchrow(
                "INSERT INTO alerts (user_id, media, kind, payload_enc) "
                "VALUES ($1, $2, $3, $4) RETURNING id, created_at",
                user_id,
                media,
                kind,
                blob,
            )
            return row["id"]
    except Exception:
        log.exception("alert: DB persist failed")
    return None


# --------------------------------------------------------------------------
# Outage throttling — one alert per outage, not one per failing poll
# --------------------------------------------------------------------------
# Process-local set of (user_id, kind) pairs currently "in outage". The
# first failure alerts; repeats are silent until clear_outage() marks
# recovery — a channel that stays deleted for a month produces ONE alert,
# not a bell full of duplicates. Resets on process restart: a boot during
# an ongoing outage alerts once again, which is correct (fresh process,
# fresh signal).
_ACTIVE_OUTAGES: set[tuple[int, str]] = set()


async def alert_outage(
    user_id: int,
    media: str,
    kind: str,
    payload: Dict[str, Any],
    **kwargs: Any,
) -> Optional[int]:
    """send_alert, but only once per (user, kind) until clear_outage()."""
    key = (user_id, kind)
    if key in _ACTIVE_OUTAGES:
        return None
    row_id = await send_alert(user_id, media, kind, payload, **kwargs)
    if row_id is not None:
        _ACTIVE_OUTAGES.add(key)
    return row_id


def clear_outage(user_id: int, *kinds: str) -> None:
    """Mark recovery: the next failure of these kinds may alert again."""
    for kind in kinds:
        _ACTIVE_OUTAGES.discard((user_id, kind))
