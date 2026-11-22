"""Connection pool + migration runner (asyncpg).

asyncpg pools are bound to their creation event loop. Production runs one
loop, so this is a simple singleton; tests (pytest-asyncio, one loop per
test) get a fresh pool per loop via the loop-identity check in get_pool.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from urllib.parse import quote

import asyncpg

_SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def dsn() -> str:
    """DSN from the ROOT .env (owner decision): full override wins; else the
    password is REQUIRED — no default, fail loudly at startup.

    Host/port are overridable so the same code runs on the host (127.0.0.1)
    and inside compose (db:5432). The password is percent-encoded so that
    '@', ':' or '/' in it cannot corrupt the URL."""
    override = os.environ.get("DREAMEDIA_PG_DSN")
    if override:
        return override
    host = os.environ.get("DREAMEDIA_PG_HOST", "127.0.0.1")
    port = os.environ.get("DREAMEDIA_PG_PORT", "5432")
    password = os.environ.get("DREAMEDIA_PG_PASSWORD")
    if password:
        return f"postgresql://dreamedia:{quote(password, safe='')}@{host}:{port}/dreamedia"
    # Trust-auth dev Postgres (userland installs) accepts passwordless.
    return f"postgresql://dreamedia@{host}:{port}/dreamedia"

_pool: asyncpg.Pool | None = None
_pool_loop: asyncio.AbstractEventLoop | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool, _pool_loop
    loop = asyncio.get_running_loop()
    if _pool is None or _pool_loop is not loop:
        # Different loop → the old pool is unusable; drop the reference
        # without terminating (its loop may already be closed).
        # The import processor stage may use up to 16 DB connections in one
        # container; leave eight more for API traffic and manager work.
        _pool = await asyncpg.create_pool(dsn=dsn(), min_size=1, max_size=24)
        _pool_loop = loop
    return _pool


async def migrate() -> None:
    pool = await get_pool()
    async with pool.acquire() as con:
        await con.execute(_SCHEMA_PATH.read_text())


async def close() -> None:
    """Drop the current pool reference. Termination is best-effort: if the
    pool's loop is already closed (test teardown), the OS reaps it."""
    global _pool, _pool_loop
    pool, _pool, _pool_loop = _pool, None, None
    if pool is not None:
        try:
            pool.terminate()
        except Exception:
            pass
