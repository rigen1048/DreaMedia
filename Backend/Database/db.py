"""Connection pool + migration runner (asyncpg).

asyncpg pools are bound to their creation event loop. Production runs one
loop, so this is a simple singleton; tests (pytest-asyncio, one loop per
test) get a fresh pool per loop via the loop-identity check in get_pool.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import asyncpg

_SCHEMA_PATH = Path(__file__).with_name("schema.sql")
# Trust-auth Postgres (this dev host) ignores the password; the docker
# compose Postgres requires it (matches compose.yaml POSTGRES_PASSWORD).
_DEFAULT_DSN = "postgresql://dreamedia:dreamedia-local-dev@127.0.0.1:5432/dreamedia"

_pool: asyncpg.Pool | None = None
_pool_loop: asyncio.AbstractEventLoop | None = None


def dsn() -> str:
    return os.environ.get("DREAMEDIA_PG_DSN", _DEFAULT_DSN)


async def get_pool() -> asyncpg.Pool:
    global _pool, _pool_loop
    loop = asyncio.get_running_loop()
    if _pool is None or _pool_loop is not loop:
        # Different loop → the old pool is unusable; drop the reference
        # without terminating (its loop may already be closed).
        _pool = await asyncpg.create_pool(dsn=dsn(), min_size=1, max_size=8)
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
