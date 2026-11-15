"""Season bumping + "fetch now" — the two progress shortcuts added after the
UI review.

`advance_season` is the whole point of the anime bump button: the backend, not
the browser, decides whether the next season is already out (→ watching at its
first episode) or still scheduled (→ Next sequel with the announced date and a
schedule row that is due immediately). These tests seed the season chain
directly so no network or AniList state can make them flaky.
"""
import time

import pytest
from returns.result import Failure, Success

from Auth import auth
from Database import db, vault
from Database.ani_store import AniStore
from Database.crypto import encrypt
from Database.pg_store import PgStore

USER = "testuser_progress"
OTHER = "testuser_progress_other"

DAY = 24 * 3600


@pytest.fixture(scope="session", autouse=True)
async def _setup():
    await db.migrate()
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("DELETE FROM users WHERE username = ANY($1)", [USER, OTHER])
    yield
    await db.close()


@pytest.fixture(autouse=True)
async def _fresh_pool():
    await db.close()
    yield


async def _user(name: str = USER) -> int:
    result = await auth.signup(name, "progress password")
    if isinstance(result, Success):
        return result.unwrap()["user_id"]
    return (await auth.login(name, "progress password")).unwrap()["user_id"]


async def _seed_chain(user_id: int, seasons: list[dict]) -> int:
    """Insert one entry with a hand-built season chain (no network)."""
    key = await vault.get(user_id)
    pool = await db.get_pool()
    async with pool.acquire() as con:
        entry_id = await con.fetchval(
            "INSERT INTO ani_entries (user_id, anilist_id, title_enc, list, anime_type) "
            "VALUES ($1, $2, $3, 'watching', 'TV') RETURNING id",
            user_id,
            int(time.time() * 1000) % 2_000_000_000,
            encrypt(key, "Test Chain"),
        )
        for season in seasons:
            await con.execute(
                "INSERT INTO ani_seasons (entry_id, season_no, anilist_id, title_enc, "
                "status, episodes_total, episodes_aired, start_date) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                entry_id,
                season["season_no"],
                9000 + season["season_no"],
                encrypt(key, f"Season {season['season_no']}"),
                season.get("status"),
                season.get("total"),
                season.get("aired", 0),
                season.get("start"),
            )
            await con.execute(
                "INSERT INTO ani_schedule (entry_id, season_no, next_check_ts) "
                "VALUES ($1, $2, $3)",
                entry_id,
                season["season_no"],
                None,
            )
    return entry_id


async def _entry(entry_id: int) -> dict:
    pool = await db.get_pool()
    async with pool.acquire() as con:
        row = await con.fetchrow(
            "SELECT list, cursor_season, cursor_episode FROM ani_entries WHERE id = $1",
            entry_id,
        )
    return dict(row)


async def test_advance_into_a_season_that_already_aired():
    user_id = await _user()
    entry_id = await _seed_chain(user_id, [
        {"season_no": 1, "status": "FINISHED", "total": 12, "aired": 12},
        {"season_no": 2, "status": "RELEASING", "total": 12, "aired": 5},
    ])
    result = await AniStore().advance_season(user_id, entry_id, 1)
    assert isinstance(result, Success), result
    decision = result.unwrap()
    assert decision["action"] == "watching"
    assert (decision["season"], decision["episode"]) == (2, 1)

    entry = await _entry(entry_id)
    assert entry["list"] == "watching"
    assert (entry["cursor_season"], entry["cursor_episode"]) == (2, 1)

    pool = await db.get_pool()
    async with pool.acquire() as con:
        watched = await con.fetchval(
            "SELECT watched FROM ani_seasons WHERE entry_id = $1 AND season_no = 1", entry_id
        )
    assert watched is True


async def test_advance_into_a_season_that_has_not_aired_waits_for_it():
    user_id = await _user()
    future = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 90 * DAY))
    entry_id = await _seed_chain(user_id, [
        {"season_no": 1, "status": "FINISHED", "total": 12, "aired": 12},
        {
            "season_no": 2,
            "status": "NOT_YET_RELEASED",
            "total": 12,
            "aired": 0,
            "start": future,
        },
    ])
    result = await AniStore().advance_season(user_id, entry_id, 1)
    assert isinstance(result, Success), result
    decision = result.unwrap()
    assert decision["action"] == "awaiting"
    assert decision["release_date"] == future
    assert decision["season"] == 2

    entry = await _entry(entry_id)
    assert entry["list"] == "next_sequel"
    # Cursor stays at the end of the finished season — nothing to watch yet.
    assert (entry["cursor_season"], entry["cursor_episode"]) == (1, 12)

    pool = await db.get_pool()
    async with pool.acquire() as con:
        release = await con.fetchval(
            "SELECT release_date FROM ani_seasons WHERE entry_id = $1 AND season_no = 2",
            entry_id,
        )
        due = await con.fetchval(
            "SELECT next_check_ts FROM ani_schedule WHERE entry_id = $1 AND season_no = 2",
            entry_id,
        )
    assert release == future
    # Due immediately: the pipeline confirms the date and raises the
    # next_sequel_date bell message instead of waiting a week.
    assert due is not None and due <= int(time.time()) + 5


async def test_advance_past_the_last_season_completes():
    user_id = await _user()
    entry_id = await _seed_chain(user_id, [
        {"season_no": 1, "status": "FINISHED", "total": 12, "aired": 12},
    ])
    result = await AniStore().advance_season(user_id, entry_id, 1)
    assert isinstance(result, Success), result
    decision = result.unwrap()
    assert decision["action"] == "completed"
    assert decision["season"] == 1
    assert decision["episode"] == 12


async def test_advance_is_owner_scoped_and_rejects_unknown_seasons():
    owner = await _user()
    stranger = await _user(OTHER)
    entry_id = await _seed_chain(owner, [
        {"season_no": 1, "status": "FINISHED", "total": 12, "aired": 12},
    ])
    store = AniStore()
    foreign = await store.advance_season(stranger, entry_id, 1)
    assert isinstance(foreign, Failure)
    assert "not found" in foreign.failure()

    missing = await store.advance_season(owner, entry_id, 7)
    assert isinstance(missing, Failure)
    assert "not in this entry" in missing.failure()


async def test_set_progress_corrects_an_overshot_season():
    """A wrong bump must be fixable, and the season flags must follow."""
    user_id = await _user()
    entry_id = await _seed_chain(user_id, [
        {"season_no": 1, "status": "FINISHED", "total": 12, "aired": 12},
        {"season_no": 2, "status": "FINISHED", "total": 12, "aired": 12},
        {"season_no": 3, "status": "RELEASING", "total": 12, "aired": 4},
    ])
    store = AniStore()
    bumped = await store.advance_season(user_id, entry_id, 1)
    assert isinstance(bumped, Success), bumped
    assert bumped.unwrap()["action"] == "watching"  # lands on S2E1

    fixed = await store.set_progress(user_id, entry_id, 1, 5)
    assert isinstance(fixed, Success), fixed
    entry = await _entry(entry_id)
    assert (entry["cursor_season"], entry["cursor_episode"]) == (1, 5)
    assert entry["list"] == "watching"

    pool = await db.get_pool()
    async with pool.acquire() as con:
        flags = {
            row["season_no"]: row["watched"]
            for row in await con.fetch(
                "SELECT season_no, watched FROM ani_seasons WHERE entry_id = $1", entry_id
            )
        }
    # Mid-season 1 means nothing is finished yet — the bump had flagged S1.
    assert flags == {1: False, 2: False, 3: False}

    # Setting the last episode of a season marks it (and earlier ones) watched.
    await store.set_progress(user_id, entry_id, 2, 12)
    async with pool.acquire() as con:
        flags = {
            row["season_no"]: row["watched"]
            for row in await con.fetch(
                "SELECT season_no, watched FROM ani_seasons WHERE entry_id = $1", entry_id
            )
        }
    assert flags == {1: True, 2: True, 3: False}


async def test_set_progress_validates_season_and_owner():
    owner = await _user()
    stranger = await _user(OTHER)
    entry_id = await _seed_chain(owner, [
        {"season_no": 1, "status": "FINISHED", "total": 12, "aired": 12},
    ])
    store = AniStore()
    assert isinstance(await store.set_progress(stranger, entry_id, 1, 1), Failure)
    missing = await store.set_progress(owner, entry_id, 9, 1)
    assert isinstance(missing, Failure)
    assert "not in this entry" in missing.failure()
    assert isinstance(await store.set_progress(owner, entry_id, 0, 1), Failure)


async def test_fetch_now_marks_subscriptions_due_and_wakes_the_manager():
    from Orchestrator.Yt import manager

    user_id = await _user()
    store = PgStore()
    added = await store.add_tracking(
        user_id, "UC_fetch_now_test", "Fetch Now Channel", "https://youtube.com/@fetchnow"
    )
    assert isinstance(added, Success), added
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute(
            "UPDATE yt_tracking SET ts = $2 WHERE channel_id = $1",
            added.unwrap(),
            int(time.time()) + 30 * DAY,
        )

    manager._WAKE.clear()
    queued = await store.request_fetch_now(user_id)
    assert queued == 1
    manager.wake()
    assert manager._WAKE.is_set()

    async with pool.acquire() as con:
        ts = await con.fetchval(
            "SELECT ts FROM yt_tracking WHERE channel_id = $1", added.unwrap()
        )
    assert ts == 0
    # Other users are never nudged.
    assert await store.request_fetch_now(user_id + 10_000) == 0
    manager._WAKE.clear()


async def test_manager_nap_returns_early_on_wake():
    import asyncio

    from Orchestrator.Yt import manager

    manager._WAKE.clear()

    async def _ring():
        await asyncio.sleep(0.05)
        manager.wake()

    started = time.monotonic()
    await asyncio.gather(manager._nap(5), _ring())
    assert time.monotonic() - started < 1.0
