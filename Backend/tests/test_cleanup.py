"""Cleanup 2026-11-08: metadata split, UpToDate fill, ani_todo, blocked categories."""
import pytest

from Auth import auth
from Media.Ani.SQL.store import AniStore
from Database.db import get_pool
from Media.Yt.SQL.store import PgStore
from returns.result import Success


PAYLOAD = ({1: {
    "id": "21", "title": "One Piece", "url": "https://anilist.co/21",
    "thumbnail": "https://img", "published": "1999-10-20",
    "status": "RELEASING", "format": "TV", "episodes": 1100,
    "next_airing": {"airingAt": 1999999999, "episode": 1101},
}, 2: {
    "id": "999", "title": "One Piece S2", "url": "https://anilist.co/999",
    "thumbnail": "https://img", "published": "2030-01-01",
    "status": "NOT_YET_RELEASED", "format": "TV", "episodes": None,
    "next_airing": None,
}},)


async def _user(name: str) -> int:
    result = await auth.signup(name, "cleanup pass")
    if isinstance(result, Success):
        return result.unwrap()["user_id"]
    return (await auth.login(name, "cleanup pass")).unwrap()["user_id"]


async def test_metadata_dual_write():
    uid = await _user("cleanup1")
    store = AniStore()
    entry = await store.add_entry(uid, 21, "One Piece", None, PAYLOAD)
    entry_id = entry.unwrap()
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT * FROM ani_metadata WHERE anilist_id IN (21, 999) ORDER BY season_no"
        )
    assert len(rows) == 2
    assert rows[0]["anilist_id"] == 21 and rows[0]["title"] == "One Piece"
    assert rows[0]["episodes_total"] == 1100
    assert rows[0]["next_airing_ep"] == 1101
    # second user tracking the same anime reuses the same global row
    uid2 = await _user("cleanup2")
    store2 = AniStore()
    await store2.add_entry(uid2, 21, "One Piece", None, PAYLOAD)
    async with pool.acquire() as con:
        count = await con.fetchval("SELECT COUNT(*) FROM ani_metadata WHERE anilist_id = 21")
    assert count == 1


async def test_up_to_date_fill():
    uid = await _user("cleanup3")
    store = AniStore()
    entry = await store.add_entry(uid, 21, "One Piece", None, PAYLOAD, list_kind="up_to_date")
    entry_id = entry.unwrap()
    pool = await get_pool()
    async with pool.acquire() as con:
        watched = await con.fetch(
            "SELECT season_no, watched FROM ani_seasons WHERE entry_id = $1 ORDER BY season_no",
            entry_id,
        )
    # S1 has aired content → watched; S2 unreleased → not watched
    assert [r["watched"] for r in watched] == [True, False]


async def test_ani_todo_crud():
    uid = await _user("cleanup4")
    store = AniStore()
    entry = await store.add_entry(uid, 21, "One Piece", None, PAYLOAD)
    entry_id = entry.unwrap()
    # tracked: "AoT S3 E5 at 7:27" style (One Piece here)
    tid = (await store.todo_add(
        uid, season_no=1, episode=5, position_seconds=447, entry_id=entry_id
    )).unwrap()
    # untracked: title required
    tid2 = (await store.todo_add(
        uid, season_no=3, episode=5, position_seconds=447, title="Attack on Titan"
    )).unwrap()
    items = await store.todo_list(uid)
    assert len(items) == 2
    op = [i for i in items if i["id"] == tid][0]
    assert op["title"] == "One Piece" and op["episode"] == 5 and op["position_seconds"] == 447
    aot = [i for i in items if i["id"] == tid2][0]
    assert aot["title"] == "Attack on Titan" and aot["entry_id"] is None
    # update + done
    assert isinstance(await store.todo_update(uid, tid, done=True), Success)
    items = await store.todo_list(uid)
    assert [i for i in items if i["id"] == tid][0]["done"] is True
    # delete + ownership
    assert isinstance(await store.todo_delete(uid, tid2), Success)
    assert len(await store.todo_list(uid)) == 1
    uid2 = await _user("cleanup5")
    assert not isinstance(await store.todo_delete(uid2, tid), Success)


async def test_blocked_categories():
    uid = await _user("cleanup6")
    ani = AniStore()
    entry = await ani.add_entry(uid, 21, "One Piece", None, PAYLOAD)
    assert isinstance(
        await ani.set_blocked_category(uid, entry.unwrap(), "Shame", "Long runners"), Success
    )
    yt = PgStore()
    added = await yt.add_tracking(uid, "UCcleanup6", "CleanupCh", "https://yt/UCcleanup6")
    assert isinstance(
        await yt.set_blocked_category(uid, added.unwrap(), "Shame", "Clickbait"), Success
    )
    pool = await get_pool()
    async with pool.acquire() as con:
        ani_row = await con.fetchval(
            "SELECT blocked_domain_enc IS NOT NULL FROM ani_entries WHERE user_id = $1", uid
        )
        yt_row = await con.fetchval(
            "SELECT blocked_domain_enc IS NOT NULL FROM yt_channels WHERE user_id = $1", uid
        )
    assert ani_row and yt_row


async def test_ani_trash_ownership_and_restore():
    """Anime trash operations must use the entry owner, not a missing event column."""
    pool = await get_pool()
    async with pool.acquire() as con:
        await con.execute(
            "DELETE FROM users WHERE username = ANY($1::text[])",
            ["cleanup_trash_owner", "cleanup_trash_other"],
        )
    owner = await _user("cleanup_trash_owner")
    other = await _user("cleanup_trash_other")
    store = AniStore()
    entry = await store.add_entry(owner, 21, "One Piece", None, PAYLOAD)
    assert isinstance(entry, Success)

    await store.emit_event(
        owner,
        entry.unwrap(),
        1,
        "episode_released",
        "awaited",
        {"episode": 1101, "title": "One Piece"},
    )
    async with pool.acquire() as con:
        event_id = await con.fetchval(
            "SELECT id FROM ani_events WHERE entry_id = $1 ORDER BY id DESC LIMIT 1",
            entry.unwrap(),
        )
    assert event_id is not None

    # A different user cannot trash or restore the owner's event.
    assert await store.trash_events(other, [event_id]) == 0
    assert await store.restore_events(other, [event_id]) == 0
    assert await store.trash_feed(other) == []

    assert await store.trash_events(owner, [event_id]) == 1
    trash = await store.trash_feed(owner)
    assert len(trash) == 1 and trash[0]["id"] == event_id

    assert await store.restore_events(owner, [event_id]) == 1
    assert await store.trash_feed(owner) == []
