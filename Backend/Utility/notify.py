"""Backend → frontend message lane (D15/D24).

Two deliberately separate lanes:
1. Durable history in the `notifications` table (per-user, encrypted
   payload). It survives a missed push and is readable through GraphQL.
2. Push to the frontend's REST receiver (`FRONTEND_NOTIFY_URL`). The
   frontend owns that endpoint; the bell displays only messages that came
   through it, so the bell can never show feed rows.

Notification scoping (feature completion): delivery is gated by the owning
domain, subdomain, and channel/entry. Muting a domain silences every
channel under it without touching their individual flags. Producers call
the `notify_yt_video` / `notify_ani_release` helpers, which apply the gate;
the raw `notify()` stays unconditional for operational messages.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx

from Database import vault
from Database.crypto import encrypt
from Database.db import get_pool
from Utility.logs import log

_NOTIFY_URL = os.environ.get("FRONTEND_NOTIFY_URL")
_NOTIFY_TOKEN = os.environ.get("FRONTEND_NOTIFY_TOKEN", "")


async def notify(
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
    """Store + push. Never raises: a notification must not break the
    pipeline that produced it. Returns the stored row id (or None)."""
    key = await vault.get(user_id)
    if key is None:
        log.warning("notify skipped (vault locked, D9): user=%s %s", user_id, kind)
        return None
    record = {
        "title": title or payload.get("title") or kind.replace("_", " ").title(),
        "message": message or payload.get("message") or "",
        "level": level,
        "url": url,
        "payload": payload,
    }
    blob = encrypt(key, json.dumps(record, default=str))
    row_id = None
    created_at = datetime.now(timezone.utc).isoformat()
    try:
        pool = await get_pool()
        async with pool.acquire() as con:
            row = await con.fetchrow(
                "INSERT INTO notifications (user_id, media, kind, payload_enc) "
                "VALUES ($1, $2, $3, $4) RETURNING id, created_at",
                user_id, media, kind, blob,
            )
            row_id = row["id"]
            created_at = row["created_at"].isoformat()
    except Exception:
        log.exception("notify: DB persist failed")

    target = _NOTIFY_URL
    if not target:
        return row_id
    body = {
        "id": f"{user_id}-{row_id}" if row_id is not None else f"{user_id}-{created_at}",
        "rowId": row_id,
        "userId": user_id,
        "media": media,
        "kind": kind,
        "title": record["title"],
        "message": record["message"],
        "level": level,
        "url": url,
        "createdAt": created_at,
        "payload": payload,
    }
    headers = {"X-Dreamedia-Token": _NOTIFY_TOKEN} if _NOTIFY_TOKEN else {}
    pushed = False
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.post(target, json=body, headers=headers)
            pushed = resp.status_code < 400
    except Exception as exc:
        log.warning("notify push failed: %s", exc)
    if pushed and row_id is not None:
        try:
            pool = await get_pool()
            async with pool.acquire() as con:
                await con.execute("UPDATE notifications SET pushed = TRUE WHERE id = $1", row_id)
        except Exception:
            pass
    return row_id


# --------------------------------------------------------------------------
# Producers — scoped helpers used by the pipelines
# --------------------------------------------------------------------------
_KIND_LABEL = {
    "tracking": "Track",
    "wordscan": "WordScan",
    "random": "Random",
    "playlist": "Playlist",
}


async def notify_yt_video(
    user_id: int,
    channel_id: int,
    channel_name: str,
    mode: str,
    video: Dict[str, Any],
    domain: str = "uncategorized",
    subdomain: str = "uncategorized",
) -> None:
    """One new YouTube video. Respects domain/subdomain/channel mute flags."""
    from Database.pg_store import PgStore

    try:
        if not await PgStore().notify_enabled(user_id, channel_id):
            return
    except Exception:
        log.exception("notify gate failed for channel %s", channel_id)
        return
    mode_label = _KIND_LABEL.get(mode, mode.title())
    await notify(
        user_id,
        "yt",
        f"{mode}_video",
        {
            "channelId": channel_id,
            "channel": channel_name,
            "mode": mode,
            "videoId": video.get("video_id") or video.get("id"),
            "title": video.get("title"),
            "url": video.get("url"),
            "thumbnail": video.get("thumbnail"),
            "domain": domain,
            "subdomain": subdomain,
        },
        title=video.get("title") or "New video",
        message=f"{channel_name} · {mode_label}",
        url=video.get("url"),
    )


_ANI_RELEASE_KINDS = {
    "next_episode_date": "New episode",
    "next_sequel_date": "Sequel announced",
    "new_anime_date": "New anime announced",
    "episode_postponed": "Episode postponed",
    "next_sequel": "Next sequel",
    "release_confirmed": "Release confirmed",
    "release_changed": "Release changed",
}


async def notify_ani_release(
    user_id: int,
    entry_id: int,
    title: str,
    season_no: Optional[int],
    kind: str,
    payload: Dict[str, Any],
) -> None:
    """Anime release/change notification, gated by entry + category flags."""
    from Database.ani_store import AniStore

    try:
        if not await AniStore().notify_enabled(user_id, entry_id):
            return
    except Exception:
        log.exception("ani notify gate failed for entry %s", entry_id)
        return
    label = _ANI_RELEASE_KINDS.get(kind, kind.replace("_", " ").title())
    await notify(
        user_id,
        "ani",
        kind,
        {
            "entryId": entry_id,
            "title": title,
            "season": season_no,
            **payload,
        },
        title=title,
        message=label + (f" · Season {season_no}" if season_no else ""),
        level="release",
    )
