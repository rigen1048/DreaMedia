"""In-memory key vault (D9).

Keys enter at successful login and live only in process memory — never
disk, never the DB. The scheduler decrypts from here. After an app
restart a user's pipeline pauses until their next login (accepted D9).
"""
from __future__ import annotations

import asyncio

_keys: dict[int, bytes] = {}
_lock = asyncio.Lock()


async def put(user_id: int, key: bytes) -> None:
    async with _lock:
        _keys[user_id] = key


async def get(user_id: int) -> bytes | None:
    return _keys.get(user_id)


async def drop(user_id: int) -> None:
    async with _lock:
        _keys.pop(user_id, None)


def is_unlocked(user_id: int) -> bool:
    return user_id in _keys
