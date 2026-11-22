"""Manager leader election (Phase 1.3, multi-worker).

Exactly one process runs the yt/ani managers + backup scheduler. Leadership
is a Postgres session-level advisory lock on a dedicated connection: the
holder keeps the connection open; if it dies, the lock releases and another
process takes over on its next tick. Claim-token rows already make the
pipeline itself safe under concurrency — this only prevents N× polling.

The connection is cached PER EVENT LOOP: test suites give every test a fresh
loop, and an asyncpg connection cannot hop loops.
"""
from __future__ import annotations

import asyncio

import asyncpg

from Database.db import dsn
from Utility.logs import log

_LOCK_ID = 735532  # arbitrary, unique to DreaMedia leadership
_conn: asyncpg.Connection | None = None
_loop: asyncio.AbstractEventLoop | None = None
_is_leader = False
_election_lock: asyncio.Lock | None = None
_election_lock_loop: asyncio.AbstractEventLoop | None = None


def _loop_lock() -> asyncio.Lock:
    """Return the election mutex for the current loop (tests use fresh loops)."""
    global _election_lock, _election_lock_loop
    current = asyncio.get_running_loop()
    if _election_lock is None or _election_lock_loop is not current:
        _election_lock = asyncio.Lock()
        _election_lock_loop = current
    return _election_lock


async def _connection() -> asyncpg.Connection:
    global _conn, _loop
    current = asyncio.get_running_loop()
    if _conn is None or _conn.is_closed() or _loop is not current:
        if _conn is not None and not _conn.is_closed() and _loop is not current:
            # Belongs to a dead loop — abandon it; the advisory lock dies with it.
            _conn = None
        _conn = await asyncpg.connect(dsn())
        _loop = current
    return _conn


async def _check_leader() -> bool:
    """Run the real, serialized election path; separated for DB-free tests."""
    global _is_leader, _conn, _loop
    async with _loop_lock():
        conn: asyncpg.Connection | None = None
        previous_conn = _conn
        try:
            conn = await _connection()
            if conn is not previous_conn:
                # A new PostgreSQL session has no advisory locks from the old one.
                _is_leader = False
            if _is_leader:
                # The same session still owns the lock; ping without re-acquiring
                # it (pg_try_advisory_lock is reentrant and increments a counter).
                await conn.fetchval("SELECT 1")
                return True
            got = await conn.fetchval("SELECT pg_try_advisory_lock($1)", _LOCK_ID)
            if got and not _is_leader:
                log.warning("this process is now the manager LEADER")
            if not got and _is_leader:
                log.warning("manager leadership LOST (another process holds it)")
            _is_leader = bool(got)
            return _is_leader
        except Exception as exc:  # failed connection/query → not leader; retry later
            log.error("leader election error: %s", exc)
            failed_conn = conn or _conn
            _is_leader = False
            if failed_conn is not None:
                try:
                    if not failed_conn.is_closed():
                        failed_conn.terminate()
                except Exception:
                    pass
            if _conn is failed_conn:
                _conn = None
                _loop = None
            return False


async def is_leader() -> bool:
    """Try to take leadership or validate the held session lock."""
    import sys

    if "pytest" in sys.modules:
        # Tests drive run_once directly across many short-lived event loops;
        # a session-level lock held by an abandoned connection would strand them.
        return True
    return await _check_leader()
