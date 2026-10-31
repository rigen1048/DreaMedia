"""Yt Access — write endpoints (D16). Everything that mutates user data.

All mutations are POST (HydraWatch's GET-mutation RPC style is dead, D25
discussion). Labels per D17/D22; category ops include the D22 life-phase
switch; CSV import/export via Polars (D10).
"""
from __future__ import annotations

import io
from typing import List, Optional

import polars as pl
from fastapi import APIRouter, Depends, Response, UploadFile
from pydantic import BaseModel
from returns.result import Failure

from App.deps import current_user_id
from Database.pg_store import PgStore

router = APIRouter(prefix="/yt/access", tags=["yt-access"])
_store = PgStore()


class SubscribeBody(BaseModel):
    kind: str                      # tracking | wordscan | playlist | random
    link: str                      # ANY accepted link — we resolve it (P1)
    words: Optional[List[str]] = None
    rank: str = "week"             # random only


class LabelBody(BaseModel):
    label: str                     # none | reserved | blocked
    reason: Optional[str] = None


class AssignBody(BaseModel):
    domain: str
    subdomain: Optional[str] = None


class CategoryActiveBody(BaseModel):
    domain: str
    subdomain: Optional[str] = None
    active: bool


@router.post("/subscribe")
async def subscribe(body: SubscribeBody, user_id: int = Depends(current_user_id)):
    """Link-only subscribe (P1): we resolve channel handles/URLs ourselves.
    Playlist subs paste a playlist link; everything else is a channel link."""
    import asyncio

    from Orchestrator.Yt.Fetch.convert import parse_playlist_id, resolve_channel

    if body.kind == "playlist":
        playlist_id = parse_playlist_id(body.link)
        if not playlist_id:
            return {"ok": False, "error": "could not extract a playlist id from that link"}
        info = await asyncio.to_thread(resolve_channel, body.link.split("?")[0])
        if isinstance(info, Failure):
            name, url, logo = "Playlist", body.link, None
        else:
            name, url, logo = info.unwrap().name, info.unwrap().url, info.unwrap().logo
        result = await _store.add_playlist(user_id, playlist_id, name, url, logo=logo)
    elif body.kind in ("tracking", "wordscan", "random"):
        info = await asyncio.to_thread(resolve_channel, body.link)
        if isinstance(info, Failure):
            return {"ok": False, "error": info.failure()}
        resolved = info.unwrap()
        if body.kind in ("tracking", "wordscan"):
            result = await _store.add_tracking(
                user_id, resolved.rss_id, resolved.name, resolved.url,
                kind=body.kind, words=body.words, logo=resolved.logo,
            )
        else:
            result = await _store.add_random(user_id, resolved.name, resolved.url, body.rank, logo=resolved.logo)
    else:
        return {"ok": False, "error": f"unknown kind: {body.kind}"}
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, "channel_id": result.unwrap()}


class SeenBody(BaseModel):
    video_ids: List[int]
    seen: bool = True


class SwitchModeBody(BaseModel):
    kind: str
    words: Optional[List[str]] = None
    rank: Optional[str] = None


class ActiveBody(BaseModel):
    active: bool


class CategoryBody(BaseModel):
    domain: str
    subdomain: Optional[str] = None


class RenameBody(BaseModel):
    domain: str
    new_name: str
    subdomain: Optional[str] = None


@router.post("/videos/seen")
async def mark_seen(body: SeenBody, user_id: int = Depends(current_user_id)):
    changed = await _store.mark_videos_seen(user_id, body.video_ids, body.seen)
    return {"ok": True, "changed": changed}


@router.post("/channels/{channel_id}/mode")
async def switch_mode(channel_id: int, body: SwitchModeBody, user_id: int = Depends(current_user_id)):
    result = await _store.switch_mode(user_id, channel_id, body.kind, body.words, body.rank)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/channels/{channel_id}/active")
async def set_active(channel_id: int, body: ActiveBody, user_id: int = Depends(current_user_id)):
    result = await _store.set_channel_active(user_id, channel_id, body.active)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.get("/categories")
async def list_categories(user_id: int = Depends(current_user_id)):
    return await _store.list_categories(user_id)


@router.post("/categories")
async def create_category(body: CategoryBody, user_id: int = Depends(current_user_id)):
    result = await _store.create_category(user_id, body.domain, body.subdomain)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/categories/rename")
async def rename_category(body: RenameBody, user_id: int = Depends(current_user_id)):
    result = await _store.rename_category(user_id, body.domain, body.new_name, body.subdomain)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/categories/delete")
async def delete_category(body: CategoryBody, user_id: int = Depends(current_user_id)):
    result = await _store.delete_category(user_id, body.domain, body.subdomain)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/channels/{channel_id}/label")
async def set_label(channel_id: int, body: LabelBody, user_id: int = Depends(current_user_id)):
    result = await _store.set_label(user_id, channel_id, body.label, body.reason)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/channels/{channel_id}/assign")
async def assign(channel_id: int, body: AssignBody, user_id: int = Depends(current_user_id)):
    result = await _store.assign_category(user_id, channel_id, body.domain, body.subdomain)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/category/active")
async def category_active(body: CategoryActiveBody, user_id: int = Depends(current_user_id)):
    """D22 life-phase switch at category level (cascades domain → subdomains)."""
    result = await _store.set_category_active(user_id, body.domain, body.subdomain, body.active)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


@router.post("/channels/{channel_id}/delete")
async def delete(channel_id: int, user_id: int = Depends(current_user_id)):
    result = await _store.delete_channel(user_id, channel_id)
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, **result.unwrap()}


# ---------------- CSV (Polars, D10) ----------------
@router.post("/csv/import")
async def csv_import(file: UploadFile, user_id: int = Depends(current_user_id)):
    if not (file.filename or "").lower().endswith(".csv"):
        return {"ok": False, "error": "only .csv files are accepted"}
    raw = await file.read()
    try:
        df = pl.read_csv(io.BytesIO(raw))
    except Exception as e:
        return {"ok": False, "error": f"CSV parse failed: {e}"}

    def _col(*names: str) -> Optional[str]:
        lower = {c.lower(): c for c in df.columns}
        for n in names:
            if n.lower() in lower:
                return lower[n.lower()]
        return None

    id_col = _col("Channel ID", "channel_id", "id")
    url_col = _col("Channel URL", "url", "link")
    name_col = _col("Channel title", "title", "name", "channel_name")
    if not all([id_col, url_col, name_col]):
        return {"ok": False, "error": f"required columns missing (got {df.columns})"}

    imported, skipped = 0, 0
    for row in df.iter_rows(named=True):
        rss_id = str(row[id_col]).strip()
        name = str(row[name_col]).strip()
        url = str(row[url_col]).strip()
        if not rss_id or not name or not url:
            skipped += 1
            continue
        result = await _store.add_tracking(user_id, rss_id, name, url)
        if isinstance(result, Failure):
            skipped += 1
        else:
            imported += 1
    return {"ok": True, "imported": imported, "skipped": skipped}


@router.get("/csv/export")
async def csv_export(user_id: int = Depends(current_user_id)):
    channels = await _store.channels_view(user_id, include_blocked=True)
    df = pl.DataFrame(
        {
            "Channel ID": [c["rss_id"] or "" for c in channels],
            "Channel URL": [c["url"] for c in channels],
            "Channel title": [c["name"] for c in channels],
            "Domains": [c["domain"] for c in channels],
            "Sub Domains": [c["subdomain"] for c in channels],
        }
    )
    return Response(
        df.write_csv(),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=dreamedia-yt-export.csv"},
    )
