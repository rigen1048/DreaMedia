"""Yt Feed — read endpoints (D16). What the frontend displays."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from App.deps import current_user_id
from Database.pg_store import PgStore

router = APIRouter(prefix="/yt/feed", tags=["yt-feed"])
_store = PgStore()


@router.get("/videos")
async def videos(user_id: int = Depends(current_user_id), limit: int = Query(100, le=500)):
    return {"videos": await _store.feed(user_id, limit)}


@router.get("/sidebar")
async def sidebar(user_id: int = Depends(current_user_id)):
    return await _store.sidebar(user_id)


@router.get("/channels")
async def channels(
    user_id: int = Depends(current_user_id), include_blocked: bool = Query(False)
):
    """Management listing; blocked channels only on demand (D22)."""
    return {"channels": await _store.channels_view(user_id, include_blocked)}
