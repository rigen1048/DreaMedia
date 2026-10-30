"""Ani Access — write endpoints (D16/D18/D20)."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from returns.result import Failure, Success

from App.deps import current_user_id
from Database.ani_store import AniStore
from Orchestrator.Ani.Fetch.ani_track import ani_fetch

router = APIRouter(prefix="/ani/access", tags=["ani-access"])
_store = AniStore()


class TrackBody(BaseModel):
    title: str
    list_kind: str = "watching"      # watchlist | confirmed | watching


class EntryUpdateBody(BaseModel):
    label: Optional[str] = None              # none | completed | blocked
    label_reason: Optional[str] = None
    list_kind: Optional[str] = None
    notify_release: Optional[bool] = None    # D20 manual activation
    active: Optional[bool] = None            # "loved S1, not continuing"
    last_watched_episode: Optional[int] = None


class WatchedBody(BaseModel):
    watched: bool


@router.post("/track")
async def track(body: TrackBody, user_id: int = Depends(current_user_id)):
    """Add an anime: live chain fetch → entry + season cache + schedule."""
    fetch = await ani_fetch(body.title)
    if isinstance(fetch, Failure):
        return {"ok": False, "error": fetch.failure()}
    payload = fetch.unwrap()
    first = payload[0][1]
    result = await _store.add_entry(
        user_id, int(first["id"]), body.title, first.get("thumbnail"), payload, body.list_kind
    )
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, "entry_id": result.unwrap(), "seasons": len(payload[0])}


@router.post("/entries/{entry_id}")
async def update_entry(entry_id: int, body: EntryUpdateBody, user_id: int = Depends(current_user_id)):
    import time

    result = await _store.update_entry(
        user_id, entry_id,
        label=body.label, label_reason=body.label_reason,
        list_kind=body.list_kind, notify_release=body.notify_release,
        active=body.active, last_watched_episode=body.last_watched_episode,
        last_watched_at=int(time.time()) if body.last_watched_episode is not None else None,
    )
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/entries/{entry_id}/seasons/{season_no}/watched")
async def set_watched(
    entry_id: int, season_no: int, body: WatchedBody, user_id: int = Depends(current_user_id)
):
    result = await _store.set_season_watched(user_id, entry_id, season_no, body.watched)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/entries/{entry_id}/delete")
async def delete_entry(entry_id: int, user_id: int = Depends(current_user_id)):
    result = await _store.delete_entry(user_id, entry_id)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}
