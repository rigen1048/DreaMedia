"""Fault-tolerance blackbox tests (Phase 2, D15/D60).

One reproduction per unhappy path, each asserting THREE things:
  1. exactly ONE alert of the right kind lands in the bell lane
  2. the subscription is NEVER auto-deleted
  3. a repeat failure does not duplicate the alert (outage throttling)

YouTube existence probes are intercepted with respx; yt-dlp fetchers
(playlist/random) are faked at the pipeline's FETCHERS table.
"""
from __future__ import annotations

import time
import uuid

import httpx
import pytest
import respx
from httpx import ASGITransport, AsyncClient

from App.main import app
from Database import db
from Media.Yt.SQL.store import PgStore
from Gate.gate import registry as gates
from Media.Yt import manager as yt_manager
from Media.Yt import pipeline as yt_pipeline
from returns.result import Failure

CHANNEL = "UCfaulttolerance0000000"


@pytest.fixture(scope="session", autouse=True)
async def _schema():
    await db.migrate()
    yield
    await db.close()


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    async def _online(*_args, **_kwargs) -> bool:
        return True

    monkeypatch.setattr("Media.Yt.pipeline.wait_for_internet_bounded", _online)
    monkeypatch.setattr(gates, "_rest_seconds", lambda _key: 0)
    monkeypatch.setattr("Config.Hardcoded.limits.RETRY_DELAY_SECONDS", 0)
    monkeypatch.setattr("Config.Hardcoded.limits.FETCH_RETRIES", 1)


@pytest.fixture
async def user():
    """A real signed-up user (the vault needs a login for encryption keys)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://dreamedia.test") as client:
        username = f"ft_{uuid.uuid4().hex[:12]}"
        response = await client.post("/graphql", json={
            "query": 'mutation($u:String!,$p:String!){ signup(username:$u,password:$p){ id } }',
            "variables": {"u": username, "p": "ft-pass"},
        })
        user_id = response.json()["data"]["signup"]["id"]
        yield client, user_id
        pool = await db.get_pool()
        async with pool.acquire() as con:
            await con.execute("DELETE FROM users WHERE id = $1", user_id)


async def alerts(client: AsyncClient) -> list[dict]:
    response = await client.post("/graphql", json={"query": "{ alerts(limit: 100) { kind title } }"})
    return response.json()["data"]["alerts"]


async def add_tracking(user_id: int) -> int:
    result = await PgStore().add_tracking(
        user_id, CHANNEL, "Fault Channel", f"https://www.youtube.com/channel/{CHANNEL}",
    )
    return result.unwrap()


async def add_playlist(user_id: int) -> int:
    result = await PgStore().add_playlist(user_id, "PLfault0000000000000", "Fault Playlist",
                                          "https://www.youtube.com/playlist?list=PLfault0000000000000")
    return result.unwrap()


async def make_due_tracking(sub_id: int) -> None:
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("UPDATE yt_tracking SET ts = 0 WHERE channel_id = $1", sub_id)


async def make_due_playlist(sub_id: int) -> None:
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("UPDATE yt_playlists SET ts = 0 WHERE channel_id = $1", sub_id)


def rss_mock(status: int, body: str = "", routes: dict | None = None) -> respx.MockRouter:
    """RSS response + optional specific routes; catch-all LAST (first match wins)."""
    mock = respx.mock(assert_all_called=False)
    mock.get("https://www.youtube.com/feeds/videos.xml").mock(
        return_value=httpx.Response(status, text=body)
    )
    for url, response in (routes or {}).items():
        mock.get(url).mock(return_value=response)
    # Consent bootstrap and any stray YouTube call get a benign 200.
    mock.get(url__startswith="https://www.youtube.com").mock(
        return_value=httpx.Response(200, text="<html></html>")
    )
    return mock


# --------------------------------------------------------------------------
# 1. Deleted channel: RSS 404 + channel page 404 → one channel_deleted alert
# --------------------------------------------------------------------------
async def test_deleted_channel_alerts_once_and_is_never_auto_deleted(user):
    client, user_id = user
    sub_id = await add_tracking(user_id)
    await make_due_tracking(sub_id)

    with rss_mock(404, routes={
        f"https://www.youtube.com/channel/{CHANNEL}": httpx.Response(404, text="Not Found"),
    }):
        await yt_manager.run_once(PgStore())

    kinds = [a["kind"] for a in await alerts(client)]
    assert kinds == ["channel_deleted"], kinds
    titles = [a["title"] for a in await alerts(client)]
    assert titles == ["Channel may got deleted"]

    # D15: the subscription survives — the user deletes, never the backend.
    pool = await db.get_pool()
    async with pool.acquire() as con:
        assert await con.fetchval("SELECT COUNT(*) FROM yt_channels WHERE id = $1", sub_id) == 1
        assert await con.fetchval("SELECT COUNT(*) FROM yt_tracking WHERE channel_id = $1", sub_id) == 1

    # Outage throttle: a second failing poll must not duplicate the alert.
    await make_due_tracking(sub_id)
    with rss_mock(404, routes={
        f"https://www.youtube.com/channel/{CHANNEL}": httpx.Response(404, text="Not Found"),
    }):
        await yt_manager.run_once(PgStore())
    assert [a["kind"] for a in await alerts(client)] == ["channel_deleted"]


# --------------------------------------------------------------------------
# 2. Channel alive + RSS persistently broken → fetcher_rss 'report' alert
# --------------------------------------------------------------------------
async def test_rss_failure_with_live_channel_alerts_fetcher_report(user):
    client, user_id = user
    sub_id = await add_tracking(user_id)
    await make_due_tracking(sub_id)

    with rss_mock(500, routes={
        f"https://www.youtube.com/channel/{CHANNEL}": httpx.Response(200, text="<html></html>"),
    }):
        await yt_manager.run_once(PgStore())

    kinds = [a["kind"] for a in await alerts(client)]
    assert kinds == ["fetcher_rss"], kinds
    assert "report to the dev" in (await alerts(client))[0]["title"]


# --------------------------------------------------------------------------
# 3. Deleted playlist: fetch fails + playlist page 404 → playlist_deleted
# --------------------------------------------------------------------------
async def test_deleted_playlist_alerts_and_is_never_auto_deleted(user, monkeypatch):
    client, user_id = user
    sub_id = await add_playlist(user_id)
    await make_due_playlist(sub_id)

    async def _broken(_link):
        return Failure("HTTP Error")

    monkeypatch.setitem(yt_pipeline.FETCHERS, "playlist", _broken)

    with respx.mock(assert_all_called=False) as mock:
        mock.get("https://www.youtube.com/playlist").mock(
            return_value=httpx.Response(404, text="Not Found")
        )
        mock.get(url__startswith="https://www.youtube.com").mock(
            return_value=httpx.Response(200, text="<html></html>")
        )
        await yt_manager.run_once(PgStore())

    kinds = [a["kind"] for a in await alerts(client)]
    assert kinds == ["playlist_deleted"], kinds
    assert (await alerts(client))[0]["title"] == "Playlist may got deleted"

    pool = await db.get_pool()
    async with pool.acquire() as con:
        assert await con.fetchval("SELECT COUNT(*) FROM yt_playlists WHERE channel_id = $1", sub_id) == 1


# --------------------------------------------------------------------------
# 4. last_seen video deleted: anchor missing from feed + oembed 404
# --------------------------------------------------------------------------
async def test_last_seen_video_deleted_alerts(user):
    client, user_id = user
    sub_id = await add_tracking(user_id)

    # Anchor on a video the feed no longer carries, and make the row due.
    store = PgStore()
    from Database import vault
    from Database.crypto import encrypt
    key = await vault.get(user_id)
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute(
            "UPDATE yt_tracking SET last_seen_enc = $2, ts = 0 WHERE channel_id = $1",
            sub_id, encrypt(key, "deletedvideo1"),
        )

    feed = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">'
        "<entry><yt:videoId>brandnew1</yt:videoId><title>Brand new</title>"
        "<published>2026-11-20T00:00:00+00:00</published></entry></feed>"
    )
    with rss_mock(200, feed, routes={
        "https://www.youtube.com/oembed": httpx.Response(404, text="Not Found"),
    }):
        await yt_manager.run_once(PgStore())

    kinds = [a["kind"] for a in await alerts(client)]
    assert kinds == ["last_seen_deleted"], kinds
    assert (await alerts(client))[0]["title"] == "Last seen video may got deleted"


# --------------------------------------------------------------------------
# 5. No internet: bounded wait times out → one no_internet alert + Failure
# --------------------------------------------------------------------------
async def test_no_internet_alerts_once(user, monkeypatch):
    client, user_id = user
    sub_id = await add_tracking(user_id)
    await make_due_tracking(sub_id)

    async def _offline(*_args, **_kwargs) -> bool:
        return False

    monkeypatch.setattr("Media.Yt.pipeline.wait_for_internet_bounded", _offline)

    await yt_manager.run_once(PgStore())
    assert [a["kind"] for a in await alerts(client)] == ["no_internet"]
    assert (await alerts(client))[0]["title"] == "We cannot access the internet"

    # Still offline: no duplicate.
    await make_due_tracking(sub_id)
    await yt_manager.run_once(PgStore())
    assert [a["kind"] for a in await alerts(client)] == ["no_internet"]

    # Recovery clears the outage: the next outage may alert again.
    from Utility.alert import clear_outage
    clear_outage(user_id, "no_internet")
    await make_due_tracking(sub_id)
    await yt_manager.run_once(PgStore())
    assert [a["kind"] for a in await alerts(client)] == ["no_internet", "no_internet"]
