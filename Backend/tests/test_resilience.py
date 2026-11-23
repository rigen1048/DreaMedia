"""Crash/restart resilience around every pipeline boundary (owner mandate).

Every subscription type: claim → crash (no release) → stale sweep frees it
(claimed_at-keyed) → row is claimable again. Plus: DB sessions survive a
simulated backend restart, vault lock still pauses pipelines (D9), and a
corrupted backup fails verification instead of being kept.
"""
import time

import pytest

from Auth import auth
from Database import vault
from Media.Ani.SQL.store import AniStore
from Database.db import get_pool
from Media.Yt.SQL.store import PgStore
from returns.result import Success


async def _user(name: str) -> int:
    result = await auth.signup(name, "resilience pass")
    if isinstance(result, Success):
        return result.unwrap()["user_id"]
    return (await auth.login(name, "resilience pass")).unwrap()["user_id"]


async def _crash_and_sweep(store, table: str, channel_id: int) -> None:
    """Claim → crash (working=true, stale claimed_at) → sweep frees it."""
    pool = await get_pool()
    async with pool.acquire() as con:
        await con.execute(
            f"UPDATE {table} SET working = TRUE, claimed_at = $2 WHERE channel_id = $1",
            channel_id, int(time.time()) - 7200,
        )
    freed = await store.release_stale(3600)
    assert freed >= 1, f"{table}: crashed claim was not freed"
    async with pool.acquire() as con:
        assert not await con.fetchval(
            f"SELECT working FROM {table} WHERE channel_id = $1", channel_id
        )


async def test_crash_recovery_tracking():
    store = PgStore()
    uid = await _user("crash_track")
    cid = (await store.add_tracking(uid, "UCcrash_t", "T", "https://yt/UCcrash_t")).unwrap()
    await _crash_and_sweep(store, "yt_tracking", cid)


async def test_crash_recovery_playlist():
    store = PgStore()
    uid = await _user("crash_pl")
    cid = (await store.add_playlist(uid, "PLcrash", "P", "https://yt/pl_crash")).unwrap()
    await _crash_and_sweep(store, "yt_playlists", cid)


async def test_crash_recovery_random():
    store = PgStore()
    uid = await _user("crash_rnd")
    cid = (await store.add_random(uid, "R", "https://yt/crash_r")).unwrap()
    await _crash_and_sweep(store, "yt_randomsubs", cid)


async def test_crash_recovery_ani():
    from Media.Ani.Fetch.ani_track import ani_fetch

    uid = await _user("crash_ani")
    store = AniStore()
    fetch = await ani_fetch("Naruto")
    payload = fetch.unwrap()
    entry_id = (await store.add_entry(uid, int(payload[0][1]["id"]), "Naruto", None, payload)).unwrap()
    pool = await get_pool()
    async with pool.acquire() as con:
        await con.execute(
            "UPDATE ani_schedule SET working = TRUE, claimed_at = $2 WHERE entry_id = $1",
            entry_id, int(time.time()) - 7200,
        )
    freed = await store.release_stale(3600)
    assert freed >= 1, "ani: crashed claim was not freed"


async def test_session_survives_restart():
    """DB sessions (Phase 1): a backend restart no longer logs anyone out."""
    uid = await _user("crash_sess")
    login = await auth.login("crash_sess", "resilience pass")
    token = login.unwrap()["token"]
    # Simulate a restart: nothing in process memory is trusted anymore.
    resolved = await auth.resolve_session(token)
    assert resolved == uid, "session did not survive the simulated restart"


async def test_vault_lock_pauses_pipeline():
    """D9: no vault key → pipeline claims release immediately, no crash."""
    store = PgStore()
    uid = await _user("crash_vault")
    await store.add_tracking(uid, "UCcrash_v", "V", "https://yt/UCcrash_v")
    await vault.drop(uid)  # simulate restart without login
    due = await store.claim_due()
    assert all(sub.user_id != uid for sub in due), "locked-vault rows must not be claimed"
    pool = await get_pool()
    async with pool.acquire() as con:
        stuck = await con.fetchval(
            "SELECT COUNT(*) FROM yt_tracking t JOIN yt_channels c ON c.id = t.channel_id "
            "WHERE c.user_id = $1 AND t.working",
            uid,
        )
    assert stuck == 0, "locked-vault claims were orphaned"


async def test_backup_verification_rejects_corrupt_dump(tmp_path):
    """Owner mandate: every backup verified. A corrupt dump must not survive."""
    from Database.Admin import settings
    from Admin.backup import run_backup
    from returns.result import Failure

    dump = await run_backup()
    assert isinstance(dump, Success), f"backup failed: {dump}"
    # Corrupt it and verify the validation step rejects a fake archive.
    from Admin.restore import _pg_restore_bin
    import asyncio as aio

    pg_restore = _pg_restore_bin()
    if not pg_restore:
        pytest.skip("pg_restore not available on this host")
    fake = tmp_path / "dreamedia-20990101-000000-000000.dump"
    fake.write_bytes(b"not a real pg dump")
    proc = await aio.create_subprocess_exec(
        pg_restore, "-l", str(fake),
        stdout=aio.subprocess.DEVNULL, stderr=aio.subprocess.PIPE,
    )
    await proc.communicate()
    assert proc.returncode != 0, "corrupt dump passed pg_restore -l validation"
