"""Black-box scenario tests (owner request): realistic inputs, observable outputs.

The system under test is the whole backend. Setup and assertions go through
the public GraphQL API over HTTP (cookies included); the only things faked
are the third-party providers we do not own (YouTube RSS, AniList), which
are intercepted at the HTTP layer with respx. A scheduler "tick" is invoked
through the same entry point the background loop uses.

Scenarios
  YT-1  channel whose last-seen is the 3rd newest video → only the two newer
        videos appear in the pull-driven feed, and the anchor advances.
  YT-2  WordScan picks only the matching new title, while still advancing the
        anchor so non-matching videos are never re-scanned.
  YT-3  muted channel still stores videos in the feed.
  YT-4  muted domain silences the channel beneath it without touching flags.

D60/D61 invariant under test everywhere below: feed items NEVER produce
bell alerts — the alerts lane is backend-driven and unhappy-path only, so
every happy-path scenario must leave the alerts list empty.
  ANI-1 release day unchanged + episode count unchanged → "releases today".
  ANI-2 release day moved → change event carrying old/new dates.
  ANI-3 episode count moved → "already released" event (not another "today").
"""
from __future__ import annotations

import time
import uuid
import xml.sax.saxutils as sx

import httpx
import pytest
import respx
from httpx import ASGITransport, AsyncClient

from App.main import app
from Database import db
from Media.Ani.SQL.store import AniStore
from Media.Yt.SQL.store import PgStore
from Gate.gate import registry as gates
from Media.Ani import manager as ani_manager
from Media.Yt import manager as yt_manager

CHANNEL = "UCscenario0000000000000000"
ANILIST_ID = 900001


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------
@pytest.fixture(scope="session", autouse=True)
async def _schema():
    await db.migrate()
    yield
    await db.close()


@pytest.fixture(autouse=True)
def _fast_gates(monkeypatch):
    """No politeness sleeps and no internet probe inside tests."""

    async def _noop() -> None:
        return None

    async def _online(*_args, **_kwargs) -> bool:
        return True

    monkeypatch.setattr("Media.Yt.pipeline.wait_for_internet_bounded", _online)
    monkeypatch.setattr("Media.Ani.pipeline.wait_for_internet_bounded", _online)
    monkeypatch.setattr(gates, "_rest_seconds", lambda _key: 0)


@pytest.fixture
async def api():
    """Signed-in HTTP client: the same surface the frontend uses."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://dreamedia.test") as client:
        username = f"sc_{uuid.uuid4().hex[:12]}"
        data = await gql(
            client,
            'mutation($u:String!,$p:String!){ signup(username:$u,password:$p){ id } }',
            {"u": username, "p": "scenario-pass"},
        )
        client.user_id = data["signup"]["id"]  # type: ignore[attr-defined]
        yield client
        # Keep the shared test database tidy: this user's rows only.
        pool = await db.get_pool()
        async with pool.acquire() as con:
            await con.execute("DELETE FROM users WHERE id = $1", client.user_id)


async def gql(client: AsyncClient, query: str, variables: dict | None = None):
    response = await client.post("/graphql", json={"query": query, "variables": variables or {}})
    body = response.json()
    assert "errors" not in body, body["errors"]
    return body["data"]


async def pause_other_workers() -> None:
    """Push every non-YT-RSS worker out of the way so a tick only does our work.

    Playlist and random fetchers use yt-dlp (a real network client we cannot
    intercept with respx); other tests' rows are simply not due right now.
    """
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("UPDATE yt_playlists SET ts = $1 WHERE ts <= $2", int(time.time()) + 3600, int(time.time()))
        await con.execute("UPDATE yt_randomsubs SET ts = $1 WHERE ts <= $2", int(time.time()) + 3600, int(time.time()))


# --------------------------------------------------------------------------
# YouTube fixtures / helpers
# --------------------------------------------------------------------------
def rss(channel_id: str, videos: list[tuple[str, str, str]]) -> str:
    """Minimal but real-shaped YouTube Atom feed. videos = (id, title, date)."""
    entries = "".join(
        f"""<entry>
      <id>yt:video:{vid}</id><yt:videoId>{vid}</yt:videoId>
      <title>{sx.escape(title)}</title>
      <published>{published}T00:00:00+00:00</published>
      <link rel="alternate" href="https://www.youtube.com/watch?v={vid}"/>
    </entry>"""
        for vid, title, published in videos
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<feed xmlns="http://www.w3.org/2005/Atom" '
        'xmlns:yt="http://www.youtube.com/xml/schemas/2015" '
        'xmlns:media="http://search.yahoo.com/mrss/">'
        f"<title>Scenario channel</title><id>channel:{channel_id}</id>{entries}</feed>"
    )


def provider_mock(feed_videos: list[tuple[str, str, str]]):
    """Catch-all provider responses; the channel-specific route wins by order."""
    mock = respx.mock(assert_all_called=False)
    mock.get("https://www.youtube.com/feeds/videos.xml", params={"channel_id": CHANNEL}).mock(
        return_value=httpx.Response(200, text=rss(CHANNEL, feed_videos))
    )
    # Any other due subscription in the shared DB gets an empty feed: the
    # pipeline treats that as "nothing new", never as an exception.
    mock.get(url__startswith="https://www.youtube.com/feeds/videos.xml").mock(
        return_value=httpx.Response(200, text=rss("UCother", []))
    )
    mock.get("https://www.youtube.com").mock(return_value=httpx.Response(200, text="<html></html>"))
    return mock


async def add_tracking(user_id: int, kind: str = "tracking", words: list[str] | None = None) -> int:
    store = PgStore()
    result = await store.add_tracking(
        user_id, CHANNEL, "Scenario Channel", f"https://www.youtube.com/channel/{CHANNEL}",
        kind=kind, words=words,
    )
    return result.unwrap()


async def _claim(sub_id: int):
    """Force one subscription due, claim it, and release everything else."""
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("UPDATE yt_tracking SET ts = 0 WHERE channel_id = $1", sub_id)
    store = PgStore()
    claimed = await store.claim_due()
    mine = [s for s in claimed if s.sub_id == sub_id]
    for other in claimed:
        if other.sub_id != sub_id:
            await store.release(other.sub_id)
    assert mine, f"subscription {sub_id} was not claimable"
    return store, mine[0]


async def set_anchor(sub_id: int, last_seen: str) -> None:
    """Pin the subscription's last-seen to an arbitrary video, then make it due."""
    store, sub = await _claim(sub_id)
    await store.update_schedule(sub, ts=0, last_seen=last_seen)
    await store.release(sub_id)


async def tick_yt() -> None:
    await pause_other_workers()
    await yt_manager.run_once(PgStore())


async def make_due(sub_id: int) -> None:
    store, sub = await _claim(sub_id)
    await store.update_schedule(sub, ts=0)
    await store.release(sub_id)


async def feed_titles(client: AsyncClient) -> list[str]:
    data = await gql(client, "{ ytFeed { title url } }")
    return [row["title"] for row in data["ytFeed"]]


async def alerts(client: AsyncClient) -> list[dict]:
    data = await gql(client, "{ alerts(limit: 100) { id media kind title } }")
    return data["alerts"]


# --------------------------------------------------------------------------
# YT-1  last-seen = 3rd newest video
# --------------------------------------------------------------------------
async def test_tracking_only_returns_videos_after_last_seen(api):
    videos = [
        ("v5new", "Newest upload", "2026-11-14"),
        ("v4new", "Second newest", "2026-11-13"),
        ("v3seen", "Third newest (anchor)", "2026-11-12"),
        ("v2old", "Older", "2026-11-11"),
        ("v1old", "Oldest", "2026-11-10"),
    ]
    sub_id = await add_tracking(api.user_id)
    await set_anchor(sub_id, "v3seen")

    with provider_mock(videos):
        await tick_yt()

    titles = await feed_titles(api)
    assert titles == ["Newest upload", "Second newest"], titles
    assert await alerts(api) == [], "happy-path feed must never alert the bell"

    # Anchor advanced to the newest video: a later upload is the only new one.
    await make_due(sub_id)
    with provider_mock([("v6new", "Later upload", "2026-11-15")] + videos):
        await tick_yt()
    assert await feed_titles(api) == ["Later upload", "Newest upload", "Second newest"]
    assert await alerts(api) == []


# --------------------------------------------------------------------------
# YT-2  WordScan
# --------------------------------------------------------------------------
async def test_wordscan_matches_only_keyword_titles_but_still_advances_anchor(api):
    videos = [
        ("v5ai", "Why AI models hallucinate", "2026-11-14"),
        ("v4cook", "Cooking a steak", "2026-11-13"),
        ("v3seen", "Anchor video", "2026-11-12"),
        ("v2old", "AI in 2019", "2026-11-11"),
    ]
    sub_id = await add_tracking(api.user_id, kind="wordscan", words=["AI"])
    await set_anchor(sub_id, "v3seen")

    with provider_mock(videos):
        await tick_yt()

    assert await feed_titles(api) == ["Why AI models hallucinate"]
    assert await alerts(api) == []

    # The non-matching new video must not be rescanned forever.
    await make_due(sub_id)
    with provider_mock(videos):
        await tick_yt()
    assert await feed_titles(api) == ["Why AI models hallucinate"]
    assert await alerts(api) == []


# --------------------------------------------------------------------------
# YT-3 / YT-4  per-scope notify flags (mute state persists on the feed)
# --------------------------------------------------------------------------
async def test_muted_channel_still_stores_in_feed(api):
    sub_id = await add_tracking(api.user_id)
    await set_anchor(sub_id, "v3seen")
    data = await gql(
        api,
        "mutation($id:Int!){ ytSetNotify(channelId:$id, notify:false) }",
        {"id": sub_id},
    )
    assert data["ytSetNotify"] is True
    channels = await gql(api, "{ ytChannels { id label notify } }")
    muted = next(channel for channel in channels["ytChannels"] if channel["id"] == sub_id)
    assert muted["label"] == "none"
    assert muted["notify"] is False

    with provider_mock([("v5", "Kept quiet one", "2026-11-14"), ("v4", "Kept quiet two", "2026-11-13"),
                        ("v3seen", "Anchor", "2026-11-12")]):
        await tick_yt()

    assert await feed_titles(api) == ["Kept quiet one", "Kept quiet two"]
    assert await alerts(api) == []


async def test_muted_domain_silences_channel_without_touching_its_flag(api):
    sub_id = await add_tracking(api.user_id)
    await set_anchor(sub_id, "v3seen")
    await gql(api, 'mutation{ ytCreateDomain(name:"Silent") }')
    await gql(
        api,
        'mutation($id:Int!){ ytAssignChannel(channelId:$id, domain:"Silent", subdomain:"General") }',
        {"id": sub_id},
    )
    domains = await gql(api, "{ ytDomains { id name notify } }")
    domain_id = next(d["id"] for d in domains["ytDomains"] if d["name"] == "Silent")
    await gql(
        api,
        "mutation($id:Int!){ ytSetDomainNotify(domainId:$id, notify:false) }",
        {"id": domain_id},
    )

    with provider_mock([("v5", "Domain muted", "2026-11-14"), ("v3seen", "Anchor", "2026-11-12")]):
        await tick_yt()

    assert await feed_titles(api) == ["Domain muted"]
    assert await alerts(api) == []
    channels = await gql(api, "{ ytChannels { id notify } }")
    mine = next(c for c in channels["ytChannels"] if c["id"] == sub_id)
    assert mine["notify"] is True, "domain mute must not rewrite the channel flag"


# --------------------------------------------------------------------------
# Anime fixtures / helpers
# --------------------------------------------------------------------------
def iso(days_from_today: int) -> str:
    from datetime import date, timedelta

    return (date.today() + timedelta(days=days_from_today)).isoformat()


def media(
    *,
    published: str,
    episode: int | None,
    airing_at: int | None,
    status: str = "RELEASING",
    episodes: int = 12,
) -> dict:
    return {
        "id": ANILIST_ID,
        "title": {"userPreferred": "Scenario Anime", "romaji": "Scenario Anime"},
        "siteUrl": "https://anilist.co/anime/900001",
        "format": "TV",
        "status": status,
        "episodes": episodes,
        "duration": 24,
        "startDate": {"year": int(published[:4]), "month": int(published[5:7]), "day": int(published[8:10])},
        "coverImage": {"large": ""},
        "nextAiringEpisode": (
            {"airingAt": airing_at, "timeUntilAiring": max(0, (airing_at or 0) - int(time.time())), "episode": episode}
            if episode
            else None
        ),
        "relations": {"edges": []},
    }


def anilist_mock(state: dict):
    """Serve the search + media queries from a mutable dict the test controls."""

    def handler(request: httpx.Request) -> httpx.Response:
        query = request.read().decode()
        if "Page(" in query:
            return httpx.Response(200, json={"data": {"Page": {"media": [{"id": ANILIST_ID,
                "title": {"userPreferred": "Scenario Anime", "romaji": "Scenario Anime", "english": "Scenario Anime"},
                "siteUrl": "https://anilist.co/anime/900001"}]}}})
        return httpx.Response(200, json={"data": {"Media": state["media"]}})

    mock = respx.mock(assert_all_called=False)
    mock.post("https://graphql.anilist.co").mock(side_effect=handler)
    return mock


async def track_anime(client: AsyncClient, list_kind: str = "watching") -> int:
    data = await gql(
        client,
        'mutation($list:String!){ aniTrack(title:"Scenario Anime", listKind:$list) }',
        {"list": list_kind},
    )
    return data["aniTrack"]


async def events(client: AsyncClient) -> list[dict]:
    data = await gql(
        client,
        "{ aniEvents { kind bucket label seasonNo payload } }",
    )
    return data["aniEvents"]


async def make_ani_due(entry_id: int, season: int = 1) -> None:
    await AniStore().set_next_check(entry_id, season, 0)


# --------------------------------------------------------------------------
# ANI-1  same release day + same episode count → "releases today"
# --------------------------------------------------------------------------
async def test_release_day_unchanged_confirms_release_today(api):
    today = iso(0)
    state = {"media": media(published=today, episode=3, airing_at=int(time.time()) + 3 * 86400)}

    with anilist_mock(state):
        entry_id = await track_anime(api)
        await make_ani_due(entry_id)
        await ani_manager.run_once(AniStore())

        # Friday morning: exactly the same date and the same episode count.
        await make_ani_due(entry_id)
        await ani_manager.run_once(AniStore())

    kinds = [e["kind"] for e in await events(api)]
    assert "release_confirmed" in kinds, kinds
    confirmed = next(e for e in await events(api) if e["kind"] == "release_confirmed")
    assert confirmed["bucket"] == "today"

    # A third identical check must not duplicate the message.
    with anilist_mock(state):
        await make_ani_due(entry_id)
        await ani_manager.run_once(AniStore())
    assert [e["kind"] for e in await events(api)].count("release_confirmed") == 1


# --------------------------------------------------------------------------
# ANI-2  release day moved
# --------------------------------------------------------------------------
async def test_release_day_change_emits_change_event(api):
    today = iso(0)
    state = {"media": media(published=today, episode=3, airing_at=int(time.time()) + 3 * 86400)}

    with anilist_mock(state):
        entry_id = await track_anime(api)
        await make_ani_due(entry_id)
        await ani_manager.run_once(AniStore())   # unknown → announced (today)

        state["media"] = media(published=iso(7), episode=3, airing_at=int(time.time()) + 10 * 86400)
        await make_ani_due(entry_id)
        await ani_manager.run_once(AniStore())   # date moved a week

    changed = [e for e in await events(api) if e["kind"] == "release_changed"]
    assert changed, [e["kind"] for e in await events(api)]
    payload = changed[0]["payload"]
    assert today in payload and iso(7) in payload, payload


# --------------------------------------------------------------------------
# ANI-3  episode count moved → it already released
# --------------------------------------------------------------------------
async def test_episode_count_increase_means_already_released(api):
    started = iso(-14)
    state = {"media": media(published=started, episode=3, airing_at=int(time.time()) - 7 * 86400)}

    with anilist_mock(state):
        entry_id = await track_anime(api)
        await make_ani_due(entry_id)
        await ani_manager.run_once(AniStore())   # starts airing, 2 episodes out

        # Next check: episode 3 aired, episode 4 is scheduled.
        state["media"] = media(published=started, episode=4, airing_at=int(time.time()) + 7 * 86400)
        await make_ani_due(entry_id)
        await ani_manager.run_once(AniStore())

    released = [e for e in await events(api) if e["kind"] == "episode_released"]
    assert released, [e["kind"] for e in await events(api)]
    assert '"episode": 3' in released[0]["payload"].replace(" ", " "), released[0]["payload"]
    assert released[0]["bucket"] == "today"
    assert released[0]["label"] == "Episode released"


# --------------------------------------------------------------------------
# ANI-4  UpToDate tracking is persisted and enables release feed events
# --------------------------------------------------------------------------
async def test_up_to_date_tracking_enables_release_events(api):
    state = {"media": media(published=iso(0), episode=3, airing_at=int(time.time()) + 3 * 86400)}
    with anilist_mock(state):
        entry_id = await track_anime(api, "up_to_date")

    data = await gql(api, "{ aniEntries(includeBlocked:true) { id list notifyRelease } }")
    entry = next(item for item in data["aniEntries"] if item["id"] == entry_id)
    assert entry["list"] == "up_to_date"
    assert entry["notifyRelease"] is True
