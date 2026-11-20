"""P0/P1 review: restore-gate cleanup in every outcome + atomic admin guards."""
import asyncio
import time

import pytest
from returns.result import Failure, Success

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


async def _run_backup_file() -> str:
    """Take a real backup and return the dump file name (feeds restore tests)."""
    from Admin.backup import run_backup

    dump = await run_backup()
    assert isinstance(dump, Success), f"backup failed: {dump}"
    return dump.unwrap().rsplit("/", 1)[-1]


async def _wait_finished() -> None:
    for _ in range(120):
        if not restore.restore_in_progress():
            return
        await asyncio.sleep(1)
    raise AssertionError("restore task never finished")


class _FakeProc:
    """Fake subprocess: returncode + communicate(), mimicking a real process."""

    def __init__(self, returncode: int, stderr: bytes = b""):
        self.returncode = returncode
        self._stderr = stderr

    async def communicate(self):
        return b"", self._stderr


def _script_pg_restore(monkeypatch, rollback_ok: bool) -> None:
    """asyncio.create_subprocess_exec fake: pg_dump (snapshot) runs for real,
    pg_restore is scripted — the restore call fails, the rollback call
    succeeds iff rollback_ok."""
    real = asyncio.create_subprocess_exec
    state = {"restore_seen": False}

    async def fake(*args, **kwargs):
        if "--clean" in args:  # pg_restore invocation
            if not state["restore_seen"]:
                state["restore_seen"] = True
                return _FakeProc(1, b"pg_restore: corrupt archive")
            return _FakeProc(0 if rollback_ok else 1, b"pg_restore: boom")
        return await real(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake)


async def test_restore_gate_released_on_pre_snapshot_failure(monkeypatch):
    """P0: pre-restore snapshot fails → gate still returns to 0."""
    await settings.set_value("restore_active", "0")
    monkeypatch.setattr(restore, "run_backup", lambda *a, **k: Failure("snapshot blew up"))
    filename = await _run_backup_file()
    result = await restore.start_restore(filename)
    assert isinstance(result, Success)  # job accepted; the failure lands in the task
    await _wait_finished()
    assert await restore.restore_in_progress_db() is False  # DB row — survives a restart
    assert await _gate() == "0"


async def test_restore_gate_released_on_restore_failure_rollback_ok(monkeypatch):
    """P0: pg_restore fails, rollback succeeds → gate returns to 0."""
    await settings.set_value("restore_active", "0")
    _script_pg_restore(monkeypatch, rollback_ok=True)
    filename = await _run_backup_file()
    result = await restore.start_restore(filename)
    assert isinstance(result, Success)
    await _wait_finished()
    assert await restore.restore_in_progress_db() is False
    assert await _gate() == "0"


async def test_restore_gate_released_on_rollback_failure(monkeypatch):
    """P0: pg_restore fails AND rollback fails → gate still returns to 0
    (the operator must inspect the DB manually, but the app is not 503'd)."""
    await settings.set_value("restore_active", "0")
    _script_pg_restore(monkeypatch, rollback_ok=False)
    filename = await _run_backup_file()
    result = await restore.start_restore(filename)
    assert isinstance(result, Success)
    await _wait_finished()
    assert await restore.restore_in_progress_db() is False
    assert await _gate() == "0"


async def test_restore_gate_released_on_exception(monkeypatch):
    """P0: restore crashes mid-flight → the unconditional finally still releases
    the gate, in-process and in the settings row."""
    await settings.set_value("restore_active", "0")
    filename = await _run_backup_file()  # real backup BEFORE subprocess is faked

    async def boom(*args, **kwargs):
        raise OSError("disk disappeared")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", boom)
    result = await restore.start_restore(filename)
    assert isinstance(result, Success)
    await _wait_finished()
    assert await restore.restore_in_progress_db() is False
    assert await _gate() == "0"
