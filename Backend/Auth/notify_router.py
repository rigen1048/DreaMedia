"""PostgreSQL-backed notification API used by the frontend header bell."""
from __future__ import annotations

import json
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from App.deps import current_user_id
from Database import vault
from Database.crypto import decrypt
from Database.db import get_pool

router = APIRouter(prefix="/notifications", tags=["notifications"])


def _bell_message(row: Any, user_id: int, key: bytes) -> Dict[str, Any]:
    decoded = json.loads(decrypt(key, row["payload_enc"]) or "{}")
    record = decoded if isinstance(decoded, dict) else {}
    payload = record.get("payload")
    if not isinstance(payload, dict):
        payload = record

    title = record.get("title") or record.get("channel") or row["kind"].replace("_", " ").title()
    message = record.get("message") or ""
    if not message and record.get("channel"):
        message = f"{record['channel']} · {record.get('mode', row['kind'])}"
    elif not message and record.get("season"):
        message = f"Season {record['season']}"

    created_at = row["created_at"]
    return {
        "id": row["id"],
        "rowId": row["id"],
        "userId": user_id,
        "media": row["media"],
        "kind": row["kind"],
        "title": str(title),
        "message": str(message),
        "level": str(record.get("level") or "info"),
        "url": record.get("url"),
        "createdAt": created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at),
        "payload": payload,
        "seen": bool(row["seen"]),
    }


@router.get("")
async def list_notifications(
    user_id: int = Depends(current_user_id),
    limit: int = Query(default=100, ge=1, le=300),
) -> Dict[str, Any]:
    key = await vault.get(user_id)
    if key is None:
        raise HTTPException(
            status_code=423,
            detail="Vault is locked; sign in again to unlock notifications.",
        )
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT id, media, kind, payload_enc, seen, created_at "
            "FROM notifications WHERE user_id = $1 "
            "ORDER BY created_at DESC, id DESC LIMIT $2",
            user_id, limit,
        )
    return {"notifications": [_bell_message(row, user_id, key) for row in rows]}


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
            user_id,
            body.ids,
            body.seen,
        )
    return {"ok": True, "changed": int(result.split()[-1])}
