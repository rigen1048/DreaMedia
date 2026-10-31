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
    canon_only: Optional[bool] = None        # D43 display flag (no filler data)


class CursorBody(BaseModel):
    season: int
    episode: Optional[int] = None
    position_seconds: Optional[int] = None   # in-episode xx:xx:xx (D44)


class RangeBody(BaseModel):
    from_season: int
    to_season: int


class EventsSeenBody(BaseModel):
    event_ids: list[int]
    seen: bool = True


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
    result = await _store.update_entry(
        user_id, entry_id,
        label=body.label, label_reason=body.label_reason,
        list_kind=body.list_kind, notify_release=body.notify_release,
        active=body.active, canon_only=body.canon_only,
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


@router.post("/entries/{entry_id}/cursor")
async def set_cursor(entry_id: int, body: CursorBody, user_id: int = Depends(current_user_id)):
    """D44 linear cursor: forward-only, fragmentation rejected by the store."""
    result = await _store.set_cursor(
        user_id, entry_id, body.season, body.episode, body.position_seconds
    )
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/entries/{entry_id}/range")
async def mark_range(entry_id: int, body: RangeBody, user_id: int = Depends(current_user_id)):
    """'I watched from season X to Y' in one action (D43 Easy Completion)."""
    result = await _store.mark_range(user_id, entry_id, body.from_season, body.to_season)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/entries/{entry_id}/watched-all")
async def mark_all(entry_id: int, user_id: int = Depends(current_user_id)):
    result = await _store.mark_all_watched(user_id, entry_id)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/events/seen")
async def mark_events_seen(body: EventsSeenBody, user_id: int = Depends(current_user_id)):
    changed = await _store.mark_events_seen(user_id, body.event_ids, body.seen)
    return {"ok": True, "changed": changed}
