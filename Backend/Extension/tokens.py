"""Per-user extension tokens: raw token shown once, sha256 hash stored."""
from __future__ import annotations

import hashlib
import secrets
from typing import Optional

from Database.db import get_pool

_PREFIX = "dm_"


def _hash(raw: str) -> bytes:
    return hashlib.sha256(raw.encode()).digest()


async def issue_token(user_id: int) -> str:
    """Rotate + return the raw token (shown to the user exactly once)."""
    raw = _PREFIX + secrets.token_hex(24)
    pool = await get_pool()
    async with pool.acquire() as con:
        await con.execute(
            "UPDATE users SET ext_token_hash = $2 WHERE id = $1", user_id, _hash(raw)
        )
    return raw


async def revoke_token(user_id: int) -> None:
    pool = await get_pool()
    async with pool.acquire() as con:
        await con.execute("UPDATE users SET ext_token_hash = NULL WHERE id = $1", user_id)


async def user_for_token(raw: str) -> Optional[int]:
    if not raw or not raw.startswith(_PREFIX):
        return None
    pool = await get_pool()
    async with pool.acquire() as con:
        return await con.fetchval(
            "SELECT id FROM users WHERE ext_token_hash = $1", _hash(raw)
        )
