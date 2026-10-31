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

_sessions: dict[str, tuple[int, float]] = {}  # token -> (user_id, expires_at)
_sessions_lock = asyncio.Lock()


def _validate(username: str, password: str) -> str | None:
    if not USERNAME_RE.match(username or ""):
        return "Username must be 3-32 chars: letters, digits, _ or -"
    if len(password or "") < MIN_PASSWORD_LEN:
        return f"Password must be at least {MIN_PASSWORD_LEN} characters"
    return None


async def _issue_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    async with _sessions_lock:
        _sessions[token] = (user_id, time.time() + SESSION_TTL_SECONDS)
    return token


async def resolve_session(token: str) -> int | None:
    """Token → user_id with sliding TTL, or None."""
    async with _sessions_lock:
        entry = _sessions.get(token)
        if not entry:
            return None
        user_id, expires = entry
        if time.time() > expires:
            del _sessions[token]
            return None
        _sessions[token] = (user_id, time.time() + SESSION_TTL_SECONDS)
    return user_id


async def logout(token: str) -> None:
    async with _sessions_lock:
        entry = _sessions.pop(token, None)
    if entry:
        # If the user has no other live session, lock their vault key.
        async with _sessions_lock:
            still_in = any(uid == entry[0] for uid, _ in _sessions.values())
        if not still_in:
            await vault.drop(entry[0])


async def signup(username: str, password: str) -> Result[dict, str]:
    if err := _validate(username, password):
        return Failure(err)
    pool = await get_pool()
    async with pool.acquire() as con:
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
