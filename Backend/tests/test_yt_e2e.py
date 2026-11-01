"""Yt end-to-end against live Postgres + live YouTube RSS.

signup → add tracking sub → manager claim → pipeline run → feed has
videos, schedule advanced, claim released. Also: claim exclusivity and
stale-claim recovery.
"""
import time

import pytest
from returns.result import Success

from Auth import auth
from Database import db
from Database.pg_store import PgStore
from Orchestrator.Yt import manager

E2E_USER = "testuser_yt_e2e"
MRBEAST = "UCX6OQ3DkcsbYNE6H8uQQuVA"


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


async def test_full_happy_path_live():
    store = PgStore()
    user_id = await _user_id()

    added = await store.add_tracking(
        user_id, MRBEAST, "MrBeast", "https://www.youtube.com/channel/" + MRBEAST
    )
    assert isinstance(added, Success)

    # Claim marks working=true; a second claim sees nothing (no double processing).
    claimed = await store.claim_due()
    assert any(s.sub_id == added.unwrap() for s in claimed)
    assert await store.claim_due() == []

    # Run the manager pass over the live feed.
    processed = 0
    for sub in claimed:
        from Orchestrator.Yt.pipeline import run_subscription

        result = await run_subscription(store, sub)
        assert isinstance(result, Success), result
        await store.release(sub.sub_id)
        processed += 1
    assert processed == len(claimed)

    # Feed has videos; schedule advanced into the future; claim released.
    feed = await store.feed(user_id)
    assert len(feed) > 0
    assert all(v["title"] and v["url"] for v in feed)

    pool = await db.get_pool()
    async with pool.acquire() as con:
        row = await con.fetchrow(
            "SELECT ts, rank, working, last_seen_enc FROM yt_tracking WHERE channel_id = $1",
            added.unwrap(),
        )
    assert row["working"] is False
    assert row["ts"] > int(time.time())
    assert row["last_seen_enc"] is not None

    # Second pass right away: nothing due (schedule respected).
    assert await store.claim_due() == []


async def test_stale_claim_recovery():
    store = PgStore()
    user_id = await _user_id()
    pool = await db.get_pool()
    async with pool.acquire() as con:
        # Simulate a crashed worker: working=true with an ancient ts.
        await con.execute(
            "UPDATE yt_tracking SET working = TRUE, ts = $1, claimed_at = $1 WHERE channel_id IN "
            "(SELECT id FROM yt_channels WHERE user_id = $2)",
            int(time.time()) - 7200,
            user_id,
        )
    freed = await store.release_stale(3600)
    assert freed >= 1
