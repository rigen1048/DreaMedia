"""Frontend-contract tests (frontend AI P1/P2 acceptance, D44/D45)."""
import time

import pytest
from returns.result import Failure, Success

from Auth import auth
from Database import db
from Database.ani_store import AniStore
from Database.pg_store import PgStore
from Orchestrator.Ani.Fetch.ani_track import ani_fetch
from Orchestrator.Yt.Fetch.convert import parse_playlist_id, resolve_channel

TEST_USER = "testuser_contract"


@pytest.fixture(scope="session", autouse=True)
async def _setup():
    await db.migrate()
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("DELETE FROM users WHERE username = $1", TEST_USER)
    yield
    await db.close()


@pytest.fixture(autouse=True)
async def _fresh_pool():
    await db.close()
    yield


async def _user_id() -> int:
    result = await auth.signup(TEST_USER, "contract password")
    if isinstance(result, Success):
        return result.unwrap()["user_id"]
    return (await auth.login(TEST_USER, "contract password")).unwrap()["user_id"]


# ---------- URL resolution (P1) ----------

def test_parse_playlist_id():
    assert parse_playlist_id("https://www.youtube.com/playlist?list=PLabc123XYZ") == "PLabc123XYZ"
    assert parse_playlist_id("https://youtu.be/v?list=PLabc123XYZ") == "PLabc123XYZ"
    assert parse_playlist_id("PLabc123XYZ") == "PLabc123XYZ"
    assert parse_playlist_id("https://example.com/nope") is None


def test_resolve_channel_live():
    """Owner's accepted formats resolve to canonical metadata (yt-dlp, live)."""
    result = resolve_channel("https://www.youtube.com/@MrBeast/videos")
    assert isinstance(result, Success), result
    info = result.unwrap()
    assert info.rss_id == "UCX6OQ3DkcsbYNE6H8uQQuVA"
    assert "mrbeast" in info.name.lower() or "beast" in info.name.lower()


# ---------- seen writes, mode switch, active (P1) ----------

async def test_videos_seen_bulk_and_ownership():
    user_id = await _user_id()
    store = PgStore()
    added = await store.add_tracking(user_id, "UCcontract1", "Chan", "https://yt/UCcontract1")
    payload = ({1: {"id": "v1", "title": "T1", "url": "https://youtu.be/c1",
                    "thumbnail": "", "published": "2026-01-01"}},)
    subs = [s for s in await store.get_due() if s.sub_id == added.unwrap()]
    await store.save_videos(subs[0], payload)
    feed = await store.feed(user_id)
    assert feed and feed[0]["id"] and feed[0]["channel_id"] == added.unwrap()
    assert feed[0]["seen"] is False
    assert await store.mark_videos_seen(user_id, [feed[0]["id"]]) == 1
    assert (await store.feed(user_id))[0]["seen"] is True
    # someone else's id → 0 changed
    assert await store.mark_videos_seen(user_id + 999, [feed[0]["id"]]) == 0
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("UPDATE yt_tracking SET active = FALSE WHERE channel_id = $1", added.unwrap())


async def test_switch_mode_exclusive_and_active_toggle():
    user_id = await _user_id()
    store = PgStore()
    added = await store.add_tracking(user_id, "UCcontract2", "Chan2", "https://yt/UCcontract2")
    cid = added.unwrap()

    # tracking → wordscan (exclusive, keeps the row)
    result = await store.switch_mode(user_id, cid, "wordscan", words=["aws"])
    assert isinstance(result, Success)
    view = [c for c in await store.channels_view(user_id) if c["id"] == cid][0]
    assert view["kind"] == "wordscan" and view["words"] == ["aws"]

    # wordscan → random: tracking row deleted, randomsub created
    result = await store.switch_mode(user_id, cid, "random", rank="month")
    assert isinstance(result, Success)
    pool = await db.get_pool()
    async with pool.acquire() as con:
        assert await con.fetchval("SELECT 1 FROM yt_tracking WHERE channel_id = $1", cid) is None
        assert await con.fetchval("SELECT rank FROM yt_randomsubs WHERE channel_id = $1", cid) == "month"

    # active toggle maps to reserved label, never touches blocked
    assert isinstance(await store.set_channel_active(user_id, cid, False), Success)
    view = [c for c in await store.channels_view(user_id) if c["id"] == cid][0]
    assert view["label"] == "reserved"
    assert isinstance(await store.set_channel_active(user_id, cid, True), Success)
    await store.delete_channel(user_id, cid)


# ---------- category CRUD (P1) ----------

async def test_category_crud_and_quick_rename():
    user_id = await _user_id()
    store = PgStore()
    added = await store.add_tracking(user_id, "UCcontract3", "Chan3", "https://yt/UCcontract3")
    await store.assign_category(user_id, added.unwrap(), "Tech", "Cloud")

    cats = await store.list_categories(user_id)
    assert any(d["name"] == "Tech" for d in cats["domains"])

    assert isinstance(await store.create_category(user_id, "Empty", "Unused"), Success)
    cats = await store.list_categories(user_id)
    assert any(d["name"] == "Empty" for d in cats["domains"])  # unused categories listed

    # quick rename keeps the channel assignment
    result = await store.rename_category(user_id, "Tech", "Software")
    assert isinstance(result, Success)
    view = [c for c in await store.channels_view(user_id) if c["id"] == added.unwrap()][0]
    assert view["domain"] == "Software"

    assert isinstance(await store.delete_category(user_id, "Software", "Cloud"), Success)
    assert isinstance(await store.delete_category(user_id, "Empty"), Success)
    await store.delete_channel(user_id, added.unwrap())


# ---------- ani: events seen, canon flag, cursor, range (P1/D43/D44) ----------

async def _ani_entry(user_id):
    store = AniStore()
    fetch = await ani_fetch("Naruto")
    assert isinstance(fetch, Success), fetch
    payload = fetch.unwrap()
    added = await store.add_entry(user_id, int(payload[0][1]["id"]), "Naruto",
                                  payload[0][1]["thumbnail"], payload)
    assert isinstance(added, Success)
    return store, added.unwrap(), len(payload[0])


async def test_ani_cursor_linear_and_range():
    user_id = await _user_id()
    store, entry_id, total = await _ani_entry(user_id)

    # forward moves accepted
    assert isinstance(await store.set_cursor(user_id, entry_id, 1, 30, 730), Success)
    assert isinstance(await store.set_cursor(user_id, entry_id, 2, 5), Success)
    # backward rejected (D44 fragmentation rule)
    result = await store.set_cursor(user_id, entry_id, 1, 10)
    assert isinstance(result, Failure)
    # range completion flags seasons + moves cursor
    result = await store.mark_range(user_id, entry_id, 1, 2)
    assert isinstance(result, Success)
    assert result.unwrap()["watched_seasons"] == 2
    # mark-all
    assert isinstance(await store.mark_all_watched(user_id, entry_id), Success)
    pool = await db.get_pool()
    async with pool.acquire() as con:
        unwatched = await con.fetchval(
            "SELECT count(*) FROM ani_seasons WHERE entry_id = $1 AND NOT watched", entry_id
        )
    assert unwatched == 0
    await store.delete_entry(user_id, entry_id)


async def test_ani_events_seen_and_management_meta():
    user_id = await _user_id()
    store, entry_id, _ = await _ani_entry(user_id)

    # management view carries canon flag, cursor, season meta (P2)
    result = await store.update_entry(user_id, entry_id, canon_only=True)
    assert isinstance(result, Success)
    view = await store.management_view(user_id)
    entry = [e for e in view if e["id"] == entry_id][0]
    assert entry["canon_only"] is True
    assert "cursor" in entry
    assert any(s.get("title") for s in entry["seasons"])

    # events carry entry_id and can be marked seen (P1)
    events = await store.events_feed(user_id)
    if events:
        assert events[0]["entry_id"] == entry_id
        assert await store.mark_events_seen(user_id, [events[0]["id"]]) == 1
        assert (await store.events_feed(user_id, include_seen=True))[0]["seen"] is True
    await store.delete_entry(user_id, entry_id)
