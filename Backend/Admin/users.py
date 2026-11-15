"""Admin user management (D26 follow-up).

The role is assigned only once, at signup ("first user is admin"). On a box
that is seeded, restored, or simply older than the person who forgot the
admin password, that leaves nobody able to reach the admin page — the exact
lockout found during the frontend audit. These functions are the way out:

- list users with role and creation date
- promote/demote, refusing to demote the last admin
- delete a user (never yourself, never the last admin), cascading their data
- reset a password without knowing the old one (admin override)

Every mutation that changes who someone is drops that user's sessions, so a
demoted admin cannot keep acting on a stale cookie.
"""
from __future__ import annotations

from typing import Any, Dict, List

from returns.result import Failure, Result, Success

from Auth import auth
from Database.db import get_pool

ROLES = ("admin", "user")


async def list_users() -> List[Dict[str, Any]]:
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT id, username, role, created_at FROM users ORDER BY id"
        )
    return [
        {
            "id": row["id"],
            "username": row["username"],
            "role": row["role"],
            "createdAt": row["created_at"].isoformat(),
        }
        for row in rows
    ]


async def _admin_count(con) -> int:
    return int(await con.fetchval("SELECT count(*) FROM users WHERE role = 'admin'") or 0)


async def set_role(actor_id: int, user_id: int, role: str) -> Result[str, str]:
    if role not in ROLES:
        return Failure(f"role must be one of {', '.join(ROLES)}")
    pool = await get_pool()
    async with pool.acquire() as con:
        row = await con.fetchrow("SELECT role FROM users WHERE id = $1", user_id)
        if row is None:
            return Failure("user not found")
        if row["role"] == role:
            return Success(role)
        if row["role"] == "admin" and role != "admin" and await _admin_count(con) <= 1:
            return Failure("the last admin cannot be demoted — promote someone else first")
        await con.execute("UPDATE users SET role = $2 WHERE id = $1", user_id, role)
    await auth.drop_user_sessions(user_id)
    return Success(role)


async def delete_user(actor_id: int, user_id: int) -> Result[int, str]:
    if actor_id == user_id:
        return Failure("you cannot delete the account you are signed in with")
    pool = await get_pool()
    async with pool.acquire() as con:
        row = await con.fetchrow("SELECT role FROM users WHERE id = $1", user_id)
        if row is None:
            return Failure("user not found")
        if row["role"] == "admin" and await _admin_count(con) <= 1:
            return Failure("the last admin cannot be deleted")
        await con.execute("DELETE FROM users WHERE id = $1", user_id)
    await auth.drop_user_sessions(user_id)
    return Success(user_id)


async def reset_password(user_id: int, password: str) -> Result[int, str]:
    problem = auth.password_problem(password)
    if problem:
        return Failure(problem)
    pool = await get_pool()
    async with pool.acquire() as con:
        exists = await con.fetchval("SELECT 1 FROM users WHERE id = $1", user_id)
        if not exists:
            return Failure("user not found")
        await con.execute(
            "UPDATE users SET argon2_hash = $2 WHERE id = $1",
            user_id, auth.hash_password(password),
        )
    await auth.drop_user_sessions(user_id)
    return Success(user_id)


async def promote_bootstrap(username: str) -> Result[str, str]:
    """CLI path (scripts/admin.py) for a box with no reachable admin."""
    pool = await get_pool()
    async with pool.acquire() as con:
        row = await con.fetchrow("SELECT id FROM users WHERE username = $1", username)
        if row is None:
            return Failure(f"no such user: {username}")
        await con.execute("UPDATE users SET role = 'admin' WHERE id = $1", row["id"])
    return Success(username)
