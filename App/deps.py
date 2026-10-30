"""Shared request dependencies: session auth (D27) + role checks (D26)."""
from __future__ import annotations

from fastapi import Cookie, Depends, HTTPException

from Auth import auth

SESSION_COOKIE = "dreamedia"


async def current_user_id(dreamedia: str | None = Cookie(default=None)) -> int:
    if not dreamedia:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user_id = await auth.resolve_session(dreamedia)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    return user_id


async def require_admin(user_id: int = Depends(current_user_id)) -> int:
    from Database.db import get_pool

    pool = await get_pool()
    async with pool.acquire() as con:
        role = await con.fetchval("SELECT role FROM users WHERE id = $1", user_id)
    if role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user_id
