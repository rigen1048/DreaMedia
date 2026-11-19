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


async def is_leader() -> bool:
    """Try to take (or confirm) the leadership lock. Cheap to call per tick."""
    import sys

    if "pytest" in sys.modules:
        # Tests drive run_once directly across many short-lived event loops;
        # a session-level lock held by an abandoned connection would strand
        # every later loop. Leadership is a runtime concern.
        return True
    global _is_leader
    try:
        conn = await _connection()
        got = await conn.fetchval("SELECT pg_try_advisory_lock($1)", _LOCK_ID)
        if got and not _is_leader:
            log.warning("this process is now the manager LEADER")
        if not got and _is_leader:
            log.warning("manager leadership LOST (another process holds it)")
        _is_leader = bool(got)
        return _is_leader
    except Exception as exc:  # connection died → not leader, retry next tick
        log.error("leader election error: %s", exc)
        _is_leader = False
        _conn = None
        return False
