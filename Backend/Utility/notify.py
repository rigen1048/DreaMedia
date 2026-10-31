"""Unhappy-path notifications (D15/D24).

Two lanes, both best-effort:
1. Persisted in the notifications table (per-user, encrypted payload) —
   history survives a missed push and is readable via the supergraph.
2. Pushed to the frontend's single notification API (FRONTEND_NOTIFY_URL
   env var; absent → push skipped silently, the table row remains).
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict

import httpx

from Database import vault
from Database.crypto import encrypt
from Database.db import get_pool
from Utility.logs import log

_NOTIFY_URL = os.environ.get("FRONTEND_NOTIFY_URL")


async def notify(user_id: int, media: str, kind: str, payload: Dict[str, Any]) -> None:
    """Store + (optionally) push. Never raises: notifications must not
    break the pipeline that produced them."""
    key = await vault.get(user_id)
    if key is None:
        log.warning("notify skipped (vault locked, D9): user=%s %s", user_id, kind)
        return
    blob = encrypt(key, json.dumps(payload, default=str))

    row_id = None
    try:
        pool = await get_pool()
        async with pool.acquire() as con:
            row_id = await con.fetchval(
                "INSERT INTO notifications (user_id, media, kind, payload_enc) "
                "VALUES ($1, $2, $3, $4) RETURNING id",
                user_id, media, kind, blob,
            )
    except Exception:
        log.exception("notify: DB persist failed")

    if not _NOTIFY_URL:
        return
    try:
        async with httpx.AsyncClient(http2=True, timeout=5.0) as client:
            resp = await client.post(
                _NOTIFY_URL,
                json={"user_id": user_id, "media": media, "kind": kind, "payload": payload},
            )
            pushed = resp.status_code < 400
    except Exception as e:
        pushed = False
        log.warning("notify push failed: %s", e)

    if pushed and row_id is not None:
        try:
            pool = await get_pool()
            async with pool.acquire() as con:
                await con.execute("UPDATE notifications SET pushed = TRUE WHERE id = $1", row_id)
        except Exception:
            pass
