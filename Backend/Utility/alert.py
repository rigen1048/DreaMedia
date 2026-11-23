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
