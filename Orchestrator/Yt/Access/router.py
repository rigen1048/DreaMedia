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
    link: str                      # rss_id | playlist_id | channel_url
    channel_name: str
    channel_url: str
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
    if body.kind in ("tracking", "wordscan"):
        result = await _store.add_tracking(
            user_id, body.link, body.channel_name, body.channel_url,
            kind=body.kind, words=body.words,
        )
    elif body.kind == "playlist":
        result = await _store.add_playlist(user_id, body.link, body.channel_name, body.channel_url)
    elif body.kind == "random":
        result = await _store.add_random(user_id, body.channel_name, body.channel_url, body.rank)
    else:
        return {"ok": False, "error": f"unknown kind: {body.kind}"}
    if isinstance(result, Failure):
        return {"ok": False, "error": result.failure()}
    return {"ok": True, "channel_id": result.unwrap()}


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
