"""Backend-side authentication (D27).

Flow:
  signup → validate → Argon2id hash → INSERT user (first user = admin)
  login  → verify hash → derive encryption key → vault.put (D9)
       → issue CSPRNG session token (HydraWatch's Math.random is dead)

Sessions are in-memory, sliding-TTL. They die with the process — same
lifecycle as the vault (D9), so nothing sensitive ever touches disk.
"""
from __future__ import annotations

import asyncio
import re
import secrets
import time

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError
from returns.result import Failure, Result, Success

from Config.Hardcoded.limits import SESSION_TTL_SECONDS
from Database import vault
from Database.crypto import derive_key
from Database.db import get_pool

_hasher = PasswordHasher()  # argon2id, OWASP defaults

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_-]{3,32}$")
MIN_PASSWORD_LEN = 6

# Phase 1 (multi-worker): sessions live in Postgres (sessions table), not
# process memory — any worker authenticates any request, and a backend
# restart no longer logs everyone out. The vault stays in-memory (D9).


def _validate(username: str, password: str) -> str | None:
    if not USERNAME_RE.match(username or ""):
        return "Username must be 3-32 chars: letters, digits, _ or -"
    if len(password or "") < MIN_PASSWORD_LEN:
        return f"Password must be at least {MIN_PASSWORD_LEN} characters"
    return None


async def _issue_session(user_id: int) -> str:
    from Database.db import get_pool

    token = secrets.token_urlsafe(32)
    pool = await get_pool()
    async with pool.acquire() as con:
        await con.execute(
            "INSERT INTO sessions (token, user_id, expires_at) "
            "VALUES ($1, $2, now() + make_interval(secs => $3))",
            token, user_id, SESSION_TTL_SECONDS,
        )
    return token


async def resolve_session(token: str) -> int | None:
    """Token → user_id with sliding TTL (DB-backed, worker-agnostic)."""
    from Database.db import get_pool

    pool = await get_pool()
    async with pool.acquire() as con:
        user_id = await con.fetchval(
            "UPDATE sessions SET expires_at = now() + make_interval(secs => $2) "
            "WHERE token = $1 AND expires_at > now() RETURNING user_id",
            token, SESSION_TTL_SECONDS,
        )
        if user_id is None:
            await con.execute("DELETE FROM sessions WHERE token = $1", token)
    return user_id


async def logout(token: str) -> None:
    from Database.db import get_pool

    pool = await get_pool()
    async with pool.acquire() as con:
        user_id = await con.fetchval(
            "DELETE FROM sessions WHERE token = $1 RETURNING user_id", token
        )
        if user_id is not None:
            still_in = await con.fetchval(
                "SELECT 1 FROM sessions WHERE user_id = $1 LIMIT 1", user_id
            )
            if not still_in:
                await vault.drop(user_id)


async def drop_all_sessions() -> int:
    """Invalidate every live session and lock every vault key.

    Called after a database restore: the users table may now describe a
    different world, so cookies issued against the old one must not survive.
    The admin who ran the restore is logged out too — deliberately.
    """
    from Database.db import get_pool

    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch("DELETE FROM sessions RETURNING user_id")
    for row in {r["user_id"] for r in rows}:
        await vault.drop(row)
    return len(rows)


async def drop_user_sessions(user_id: int) -> int:
    """Invalidate one user's sessions (role change, password reset, delete)."""
    from Database.db import get_pool

    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "DELETE FROM sessions WHERE user_id = $1 RETURNING token", user_id
        )
    if rows:
        await vault.drop(user_id)
    return len(rows)


def hash_password(password: str) -> str:
    """Argon2id hash for admin-driven password resets."""
    return _hasher.hash(password)


def password_problem(password: str) -> str | None:
    """Same rule as signup, exposed so admin resets cannot weaken it."""
    if len(password or "") < MIN_PASSWORD_LEN:
        return f"Password must be at least {MIN_PASSWORD_LEN} characters"
    return None


async def signup(username: str, password: str) -> Result[dict, str]:
    if err := _validate(username, password):
        return Failure(err)
    pool = await get_pool()
    async with pool.acquire() as con:
        # Bootstrap is serialized by an advisory lock: two concurrent
        # signups must not both see an empty users table and both become
        # admin (2026 review race). Lock first, then re-check everything.
        await con.execute("SELECT pg_advisory_xact_lock(735531)")
        exists = await con.fetchval(
            "SELECT 1 FROM users WHERE username = $1", username
        )
        if exists:
            return Failure("User already exists")
        # First registered user becomes admin (D26 needs an admin).
        user_count = await con.fetchval("SELECT count(*) FROM users")
        role = "admin" if user_count == 0 else "user"
        row = await con.fetchrow(
            "INSERT INTO users (username, argon2_hash, role) VALUES ($1, $2, $3) "
            "RETURNING id, role",
            username,
            _hasher.hash(password),
            role,
        )
    user_id = row["id"]
    await vault.put(user_id, derive_key(password, username))
    token = await _issue_session(user_id)
    return Success({"user_id": user_id, "username": username, "role": row["role"], "token": token})


async def login(username: str, password: str) -> Result[dict, str]:
    if err := _validate(username, password):
        return Failure(err)
    pool = await get_pool()
    async with pool.acquire() as con:
        row = await con.fetchrow(
            "SELECT id, argon2_hash, role FROM users WHERE username = $1", username
        )
    if not row:
        return Failure("Invalid credentials")
    try:
        _hasher.verify(row["argon2_hash"], password)
    except (VerifyMismatchError, VerificationError):
        return Failure("Invalid credentials")
    user_id = row["id"]
    await vault.put(user_id, derive_key(password, username))
    token = await _issue_session(user_id)
    return Success({"user_id": user_id, "username": username, "role": row["role"], "token": token})
