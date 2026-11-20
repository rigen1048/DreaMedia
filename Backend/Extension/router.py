"""Extension endpoints (D55): subscribe-from-page, playlist add, watch progress.

Every route requires X-DreaMedia-Token. Kept deliberately small and stable —
the extension is released software that can't ride our internal refactors.
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from returns.result import Failure

from Database.ani_store import AniStore
from Database.card_store import CardStore
from Database.pg_store import PgStore
from Extension.store import ExtDomainStore
from Extension.tokens import user_for_token

router = APIRouter(prefix="/ext", tags=["extension"])

_yt = PgStore()
_ani = AniStore()
_cards = CardStore()


async def ext_user(x_dreamedia_token: str = Header(default="")) -> int:
    user_id = await user_for_token(x_dreamedia_token)
    if user_id is None:
        raise HTTPException(401, "invalid extension token")
    return user_id


def _locked(result) -> None:
    """Writes need the vault key, which only exists while the user has a live
    web session (D9). The extension token identifies the user; it is NOT key
    material — that would defeat per-user encryption."""
    if isinstance(result, Failure) and "vault" in str(result.failure()):
        raise HTTPException(
            423, "vault locked — log into DreaMedia once to unlock your data, then retry"
        )


@router.get("/ping")
async def ping(user_id: int = Depends(ext_user)):
    return {"ok": True, "user_id": user_id}


class SubscribeBody(BaseModel):
    kind: str = "tracking"
    link: str
    words: Optional[List[str]] = None
    rank: Optional[str] = None
    domain: Optional[str] = None
    subdomain: Optional[str] = None


@router.post("/subscribe")
async def subscribe(body: SubscribeBody, user_id: int = Depends(ext_user)):
    """HydraTracker capability: subscribe from any YouTube page, no CSV ever."""
    import asyncio

    from Orchestrator.Yt.Fetch.convert import parse_playlist_id, resolve_channel

    if body.kind == "playlist":
        playlist_id = parse_playlist_id(body.link)
        if not playlist_id:
            raise HTTPException(400, "could not extract a playlist id from that link")
        info = await asyncio.to_thread(resolve_channel, body.link.split("?")[0])
        if isinstance(info, Failure):
            name, url, logo = "Playlist", body.link, None
        else:
            name, url, logo = info.unwrap().name, info.unwrap().url, info.unwrap().logo
        result = await _yt.add_playlist(user_id, playlist_id, name, url, logo=logo)
    elif body.kind in ("tracking", "wordscan"):
        info = await asyncio.to_thread(resolve_channel, body.link)
        if isinstance(info, Failure):
            raise HTTPException(400, info.failure())
        resolved = info.unwrap()
        result = await _yt.add_tracking(
            user_id, resolved.rss_id, resolved.name, resolved.url,
            kind=body.kind, words=body.words, logo=resolved.logo,
        )
    elif body.kind == "random":
        info = await asyncio.to_thread(resolve_channel, body.link)
        if isinstance(info, Failure):
            raise HTTPException(400, info.failure())
        resolved = info.unwrap()
        result = await _yt.add_random(
            user_id, resolved.name, resolved.url, body.rank or "week", logo=resolved.logo
        )
    else:
        raise HTTPException(400, f"unknown kind: {body.kind}")

    _locked(result)
    if isinstance(result, Failure):
        raise HTTPException(400, result.failure())
    channel_id = result.unwrap()

    if body.domain:
        await _yt.assign_category(user_id, channel_id, body.domain, body.subdomain)
    return {"ok": True, "channel_id": channel_id}


@router.get("/cards")
async def cards(user_id: int = Depends(ext_user)):
    return {"cards": await _cards.list_cards(user_id)}


class CardBody(BaseModel):
    name: str


@router.post("/cards")
async def create_card(body: CardBody, user_id: int = Depends(ext_user)):
    result = await _cards.create_card(user_id, body.name)
    _locked(result)
    if isinstance(result, Failure):
        raise HTTPException(400, result.failure())
    return {"id": result.unwrap()}


class ItemsBody(BaseModel):
    links: List[str]


@router.post("/cards/{card_id}/items")
async def add_items(card_id: int, body: ItemsBody, user_id: int = Depends(ext_user)):
    """Paste video links — resolved (title/thumb) once at add-time (D47)."""
    import asyncio

    from Orchestrator.Yt.Fetch.convert import resolve_video

    added = 0
    errors: List[str] = []
    for link in body.links:
        info = await asyncio.to_thread(resolve_video, link)
        if isinstance(info, Failure):
            errors.append(f"{link}: {info.failure()}")
            continue
        video = info.unwrap()
        result = await _cards.add_item(
            user_id, card_id, video.video_id, video.url, video.title, video.thumbnail
        )
        _locked(result)
        if isinstance(result, Failure):
            errors.append(f"{link}: {result.failure()}")
        else:
            added += 1
    return {"added": added, "requested": len(body.links), "errors": errors}


# ---- extension v2 phase 1: domain allowlist ----

@router.get("/domains")
async def domains(user_id: int = Depends(ext_user)):
    """Enabled allowlist for content-script registration. Requires the vault
    (domain names are ciphertext) — 423 when locked; the extension keeps its
    last cached copy then."""
    rows = await ExtDomainStore().list_domains(user_id, enabled_only=True)
    if any(r["domain"] is None for r in rows):
        raise HTTPException(
            423, "vault locked — log into DreaMedia once to unlock your data, then retry"
        )
    return {"domains": rows}


class DomainBody(BaseModel):
    domain: str
    media: str = "ani"


@router.post("/domains")
async def add_domain(body: DomainBody, user_id: int = Depends(ext_user)):
    """Popup's 'Enable DreaMedia on this site' button."""
    result = await ExtDomainStore().add_domain(user_id, body.domain, body.media)
    _locked(result)
    if isinstance(result, Failure):
        raise HTTPException(400, result.failure())
    return {"ok": True, **result.unwrap()}


@router.get("/ani/entries")
async def ani_entries(user_id: int = Depends(ext_user)):
    """Entries the popup can bind a tab to (id, title, seasons, cursor)."""
    view = await _ani.management_view(user_id)
    return {
        "entries": [
            {
                "id": e.get("id"), "title": e.get("title"),
                "seasons": [
                    sn.get("season_no") for sn in e.get("seasons", []) if isinstance(sn, dict)
                ],
                "cursor_season": e.get("cursor_season"),
                "cursor_episode": e.get("cursor_episode"),
            }
            for e in view
        ]
    }


class ProgressBody(BaseModel):
    entry_id: int
    season: int
    episode: Optional[int] = None
    position_seconds: Optional[int] = None


@router.post("/progress")
async def progress(body: ProgressBody, user_id: int = Depends(ext_user)):
    """Site-agnostic watch progress (D55): the content script reports the
    video's timestamp; the popup chose which entry this tab is bound to."""
    result = await _ani.set_cursor(
        user_id, body.entry_id, body.season, body.episode, body.position_seconds
    )
    _locked(result)
    if isinstance(result, Failure):
        raise HTTPException(400, result.failure())
    return {"ok": True}
