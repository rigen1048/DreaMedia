"""Ani Feed — read endpoints (D16/D18)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from App.deps import current_user_id
from Database.ani_store import AniStore

router = APIRouter(prefix="/ani/feed", tags=["ani-feed"])
_store = AniStore()


@router.get("/events")
async def events(
    user_id: int = Depends(current_user_id), include_seen: bool = Query(False)
):
    """Notification division (D18): the 7 event kinds with awaited tier (D21)."""
    return {"events": await _store.events_feed(user_id, include_seen)}


@router.get("/management")
async def management(user_id: int = Depends(current_user_id)):
    """User Management division (D18/D23): per-season ep counts + totals."""
    return {"entries": await _store.management_view(user_id)}
