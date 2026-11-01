"""Ani end-to-end against live Postgres + live AniList.

signup → add Naruto entry (chain fetch live) → manager claim → pipeline
run → season cache filled, schedule set, management view shows per-season
ep counts + totals (D23), events feed readable + encrypted at rest.
"""
import time

import pytest
from returns.result import Success

from Auth import auth
from Database import db, vault
from Database.ani_store import AniStore
from Database.crypto import decrypt
from Orchestrator.Ani import manager
from Orchestrator.Ani.Fetch.ani_track import ani_fetch

E2E_USER = "testuser_ani_e2e"


@pytest.fixture(scope="session", autouse=True)
async def _setup():
    await db.migrate()
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("DELETE FROM users WHERE username = $1", E2E_USER)
    yield
    await db.close()


@pytest.fixture(autouse=True)
async def _fresh_pool():
    await db.close()
    yield


async def _user_id() -> int:
    result = await auth.signup(E2E_USER, "e2e password")
    if isinstance(result, Success):
        return result.unwrap()["user_id"]
    return (await auth.login(E2E_USER, "e2e password")).unwrap()["user_id"]


async def test_full_ani_happy_path_live():
    user_id = await _user_id()
    store = AniStore()

    # Live chain fetch for the entry.
    fetch = await ani_fetch("Naruto")
    assert isinstance(fetch, Success), fetch
    payload = fetch.unwrap()
    first_season_id = int(payload[0][1]["id"])

    added = await store.add_entry(
        user_id, first_season_id, "Naruto", payload[0][1]["thumbnail"], payload
    )
    assert isinstance(added, Success)

    # Claim → run → release, one full manager pass.
    processed = await manager.run_once(store)
    assert processed >= 1

    # Season cache: every chain season has a schedule row with a next check.
    pool = await db.get_pool()
    async with pool.acquire() as con:
        seasons = await con.fetch(
            "SELECT season_no, state FROM ani_seasons WHERE entry_id = $1 ORDER BY season_no",
            added.unwrap(),
        )
        schedules = await con.fetch(
            "SELECT season_no, next_check_ts, working FROM ani_schedule WHERE entry_id = $1",
            added.unwrap(),
        )
    assert len(seasons) == len(payload[0])
    assert len(schedules) == len(payload[0])
    assert all(s["working"] is False for s in schedules)
    assert all(s["next_check_ts"] is None or s["next_check_ts"] > int(time.time()) for s in schedules)
    # Naruto is FINISHED → its seasons should be past 'unknown'.
    assert all(s["state"] in ("announced", "airing", "finished") for s in seasons)

    # Management view (D18/D23): per-season ep counts + total seasons.
    view = await store.management_view(user_id)
    assert len(view) == 1
    entry = view[0]
    assert entry["title"] == "Naruto"
    assert entry["total_seasons"] == len(payload[0])
    assert any((s["episodes_total"] or 0) > 0 for s in entry["seasons"])

    # Feed events decryptable; raw payloads are ciphertext at rest.
    key = await vault.get(user_id)
    assert key is not None
    async with pool.acquire() as con:
        raw = await con.fetchval(
            "SELECT payload_enc FROM ani_events WHERE entry_id = $1 LIMIT 1", added.unwrap()
        )
    if raw is not None:  # events exist only if transitions fired this run
        parsed = decrypt(key, raw)
        assert parsed and "Naruto" not in str(raw)


async def test_ani_stale_claim_recovery():
    user_id = await _user_id()
    store = AniStore()
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute(
            "UPDATE ani_schedule SET working = TRUE, next_check_ts = $1, claimed_at = $1 "
            "WHERE entry_id IN (SELECT id FROM ani_entries WHERE user_id = $2)",
            int(time.time()) - 7200,
            user_id,
        )
    freed = await store.release_stale(3600)
    assert freed >= 1
