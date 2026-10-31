"""Manual todo cards (D47) — create cards, paste video links, check off."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from returns.result import Failure

from App.deps import current_user_id
from Database.card_store import CardStore
from Orchestrator.Yt.Fetch.convert import resolve_video

router = APIRouter(prefix="/yt/cards", tags=["yt-cards"])
_store = CardStore()


class CardBody(BaseModel):
    name: str


class ItemBody(BaseModel):
    link: str


class DoneBody(BaseModel):
    done: bool


@router.get("")
async def list_cards(user_id: int = Depends(current_user_id)):
    return {"cards": await _store.list_cards(user_id)}


@router.post("")
async def create_card(body: CardBody, user_id: int = Depends(current_user_id)):
    result = await _store.create_card(user_id, body.name)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, "card_id": result.unwrap()}


@router.post("/{card_id}/delete")
async def delete_card(card_id: int, user_id: int = Depends(current_user_id)):
    result = await _store.delete_card(user_id, card_id)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/{card_id}/items")
async def add_item(card_id: int, body: ItemBody, user_id: int = Depends(current_user_id)):
    """Paste a video link — the backend resolves title/thumbnail itself (D47)."""
    info = await asyncio.to_thread(resolve_video, body.link)
    if isinstance(info, Failure):
        return {"ok": False, "error": info.failure()}
    video = info.unwrap()
    result = await _store.add_item(
        user_id, card_id, video.video_id, video.url, video.title, video.thumbnail
    )
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, "item_id": result.unwrap(), "title": video.title}


@router.post("/items/{item_id}/done")
async def set_done(item_id: int, body: DoneBody, user_id: int = Depends(current_user_id)):
    result = await _store.set_item_done(user_id, item_id, body.done)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/items/{item_id}/delete")
async def delete_item(item_id: int, user_id: int = Depends(current_user_id)):
    result = await _store.delete_item(user_id, item_id)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}
