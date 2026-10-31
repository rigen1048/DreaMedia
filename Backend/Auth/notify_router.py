"""Notifications reader (D24): hydrates the frontend bell on load.
Push is the frontend's receiver endpoint; this is the history lane."""
from __future__ import annotations

import json
from typing import Any, Dict, List

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from App.deps import current_user_id
from Database import vault
from Database.crypto import decrypt
from Database.db import get_pool

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
async def list_notifications(user_id: int = Depends(current_user_id)) -> Dict[str, Any]:
    key = await vault.get(user_id)
    if key is None:
        return {"notifications": []}
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT id, media, kind, payload_enc, pushed, seen, created_at "
            "FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
            user_id,
        )
    return {
        "notifications": [
            {
                "id": r["id"], "media": r["media"], "kind": r["kind"],
                "payload": json.loads(decrypt(key, r["payload_enc"]) or "{}"),
                "pushed": r["pushed"], "seen": r["seen"],
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]
    }


class SeenBody(BaseModel):
    ids: List[int]
    seen: bool = True


@router.post("/seen")
async def mark_seen(body: SeenBody, user_id: int = Depends(current_user_id)) -> Dict[str, Any]:
    if not body.ids:
        return {"ok": True, "changed": 0}
    pool = await get_pool()
    async with pool.acquire() as con:
        result = await con.execute(
            "UPDATE notifications SET seen = $3 WHERE user_id = $1 AND id = ANY($2)",
            user_id, body.ids, body.seen,
        )
    return {"ok": True, "changed": int(result.split()[-1])}
