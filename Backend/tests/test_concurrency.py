"""P0/P1 review: restore-gate cleanup in every outcome + atomic admin guards."""
import asyncio
import time

import pytest
from returns.result import Success

from Admin import restore, settings
from Admin.users import delete_user, set_role
from Auth import auth
from Database.db import get_pool


async def _gate() -> str:
    return await settings.get_typed("restore_active")


async def _admins() -> int:
    pool = await get_pool()
    async with pool.acquire() as con:
        return int(await con.fetchval("SELECT count(*) FROM users WHERE role = 'admin'") or 0)


async def test_restore_gate_released_on_missing_dump():
    """P0: pre-snapshot failure path — gate returns to 0."""
    await settings.set_value("restore_active", "0")
    result = await restore.start_restore("dreamedia-19990101-000000-000000.dump")
    assert not isinstance(result, Success)
    assert await _gate() == "0", f"gate stuck at {await _gate()}"


async def test_restore_gate_released_after_real_restore():
    """P0: full cycle — dump → restore → gate is 0 at the end (the case that
    used to leave the app read-only forever)."""
    from Admin.backup import run_backup

    dump = await run_backup()
    assert isinstance(dump, Success), f"backup failed: {dump}"
    filename = dump.unwrap().rsplit("/", 1)[-1]
    result = await restore.start_restore(filename)
    assert isinstance(result, Success), f"start_restore failed: {result}"
    # wait for the background task to finish
    for _ in range(120):
        if not restore.restore_in_progress():
            break
        await asyncio.sleep(1)
    assert not restore.restore_in_progress(), "restore never finished"
    assert await _gate() == "0", "gate stayed 1 after a successful restore (P0)"


async def test_concurrent_last_admin_transitions():
    """P1: with exactly two admins, concurrent demote+delete must not reach
    zero admins. Other admins are parked for the test and restored after."""
    import uuid

    tag = uuid.uuid4().hex[:6]
    a = (await auth.signup(f"p1a{tag}", "admin pass one")).unwrap()["user_id"]
    b = (await auth.signup(f"p1b{tag}", "admin pass two")).unwrap()["user_id"]
    pool = await get_pool()
    async with pool.acquire() as con:
        await con.execute("UPDATE users SET role = 'admin' WHERE id = ANY($1)", [a, b])
        parked = [r["id"] for r in await con.fetch(
            "SELECT id FROM users WHERE role = 'admin' AND id != ALL($1)", [a, b]
        )]
        await con.execute(
            "UPDATE users SET role = 'user' WHERE id = ANY($1)", parked
        )
        assert int(await con.fetchval("SELECT count(*) FROM users WHERE role = 'admin'")) == 2

    try:
        # Demote A and delete B simultaneously — without the advisory lock
        # both observe count=2 and the system lands on 0 admins.
        await asyncio.gather(
            set_role(a, a, "user"),
            delete_user(a, b),
            return_exceptions=True,
        )
        assert await _admins() >= 1, "last-admin race: system reached ZERO admins"
    finally:
        async with pool.acquire() as con:
            await con.execute("UPDATE users SET role = 'admin' WHERE id = ANY($1)", parked)
