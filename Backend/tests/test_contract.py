"""Frontend-contract tests (frontend AI P1/P2 acceptance, D44/D45)."""
import time

import pytest
from returns.result import Failure, Success

from Auth import auth
from Database import db
from Database.ani_store import AniStore
from Database.pg_store import PgStore, PgSubscription
from Extension import anchor, live, sites
from Extension.store import ExtDomainStore, list_blocked_yt
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

    # The channel switch is the one muted/receiving state.
    assert isinstance(await store.set_channel_active(user_id, cid, False), Success)
    view = [c for c in await store.channels_view(user_id) if c["id"] == cid][0]
    assert view["label"] == "reserved" and view["notify"] is False

    # Legacy channel mute writes use the same state and resume clears it.
    assert isinstance(await store.set_channel_notify(user_id, cid, False), Success)
    view = [c for c in await store.channels_view(user_id) if c["id"] == cid][0]
    assert view["notify"] is False
    assert isinstance(await store.set_channel_active(user_id, cid, True), Success)
    view = [c for c in await store.channels_view(user_id) if c["id"] == cid][0]
    assert view["label"] == "none" and view["notify"] is True

    await store.delete_channel(user_id, cid)


# ---------- mode switch: random -> tracking/wordscan (P2) ----------

async def test_switch_mode_random_to_tracking_and_wordscan():
    """P2: a channel in random mode can be switched into tracking/wordscan,
    using its own URL as the RSS source (no tracking row exists yet)."""
    user_id = await _user_id()
    store = PgStore()
    added = await store.add_tracking(user_id, "UCp2chan", "P2 Chan", "https://yt/UCp2chan")
    cid = added.unwrap()

    # tracking -> random (tracking row dropped, randomsub created)
    result = await store.switch_mode(user_id, cid, "random", rank="week")
    assert isinstance(result, Success)
    pool = await db.get_pool()
    async with pool.acquire() as con:
        assert await con.fetchval("SELECT 1 FROM yt_tracking WHERE channel_id = $1", cid) is None
        assert await con.fetchval("SELECT rank FROM yt_randomsubs WHERE channel_id = $1", cid) == "week"

    # random -> tracking: should now succeed (P2 fix), reusing the channel URL as RSS
    result = await store.switch_mode(user_id, cid, "tracking")
    assert isinstance(result, Success)
    view = [c for c in await store.channels_view(user_id) if c["id"] == cid][0]
    assert view["kind"] == "tracking"
    async with pool.acquire() as con:
        assert await con.fetchval("SELECT 1 FROM yt_tracking WHERE channel_id = $1", cid) is not None
        assert await con.fetchval("SELECT 1 FROM yt_randomsubs WHERE channel_id = $1", cid) is None

    # tracking -> wordscan (exclusive, keeps the row)
    result = await store.switch_mode(user_id, cid, "wordscan", words=["p2"])
    assert isinstance(result, Success)
    view = [c for c in await store.channels_view(user_id) if c["id"] == cid][0]
    assert view["kind"] == "wordscan" and view["words"] == ["p2"]

    await store.delete_channel(user_id, cid)


# ---------- withhold notification type (F1) ----------

async def test_withhold_buffers_then_releases_as_a_batch():
    """F1: withhold=2 buffers single uploads invisibly; the batch that reaches
    the threshold releases everything at once."""
    user_id = await _user_id()
    store = PgStore()
    added = await store.add_tracking(user_id, "UCf1chan", "F1 Chan", "https://yt/UCf1chan")
    cid = added.unwrap()

    result = await store.switch_mode(user_id, cid, "withhold", withhold=2)
    assert isinstance(result, Success), result
    view = [c for c in await store.channels_view(user_id) if c["id"] == cid][0]
    assert view["kind"] == "tracking" and view["withhold_threshold"] == 2

    # Validation: threshold must be >= 1
    assert isinstance(await store.switch_mode(user_id, cid, "withhold", withhold=0), Failure)
    assert isinstance(await store.switch_mode(user_id, cid, "withhold"), Failure)

    def _sub() -> "PgSubscription":
        return PgSubscription(
            sub_id=cid, user_id=user_id, media="yt", kind="tracking",
            link="https://yt/UCf1chan", last_seen=None, withhold_threshold=2,
        )

    async def _chan_feed() -> list:
        # Other tests in this file share the user — scope to this channel.
        return [v for v in await store.feed(user_id) if v["channel_id"] == cid]

    payload1 = ({1: {"id": "w1", "title": "First", "url": "https://youtu.be/w1", "thumbnail": "", "published": "2026-01-01"}},)
    inserted1 = await store.save_videos_detailed(_sub(), payload1)
    assert inserted1 == [], "single upload must buffer, not emit"
    assert await _chan_feed() == [], "buffered video must be hidden from the feed"

    payload2 = ({1: {"id": "w2", "title": "Second", "url": "https://youtu.be/w2", "thumbnail": "", "published": "2026-01-02"}},)
    inserted2 = await store.save_videos_detailed(_sub(), payload2)
    assert len(inserted2) == 2, "threshold reached — the whole batch releases"
    assert len(await _chan_feed()) == 2, "released batch is visible in the feed"

    # Threshold resets the buffer: next single upload buffers again.
    payload3 = ({1: {"id": "w3", "title": "Third", "url": "https://youtu.be/w3", "thumbnail": "", "published": "2026-01-03"}},)
    inserted3 = await store.save_videos_detailed(_sub(), payload3)
    assert inserted3 == []
    assert len(await _chan_feed()) == 2

    # Switching away from withhold clears the threshold.
    result = await store.switch_mode(user_id, cid, "tracking")
    assert isinstance(result, Success)
    view = [c for c in await store.channels_view(user_id) if c["id"] == cid][0]
    assert view["withhold_threshold"] is None

    await store.delete_channel(user_id, cid)


# ---------- extension v2 phase 1: domain allowlist ----------

async def test_ext_domains_allowlist_crud():
    """Ext v2: the extension runs only on allowlisted domains. Add (with URL
    normalization), list, toggle, remove; same domain allowed per media."""
    user_id = await _user_id()
    store = ExtDomainStore()

    added = await store.add_domain(user_id, "HTTPS://WWW.Example.com/watch?v=1", "ani")
    assert isinstance(added, Success)
    row = added.unwrap()
    assert row["domain"] == "example.com" and row["media"] == "ani" and row["enabled"]

    # Invalid input rejected
    assert isinstance(await store.add_domain(user_id, "localhost", "ani"), Failure)
    assert isinstance(await store.add_domain(user_id, "example.org", "podcast"), Failure)

    # Same domain under the other media is a separate row
    added_yt = await store.add_domain(user_id, "example.com", "yt")
    assert isinstance(added_yt, Success)

    # Re-adding an existing (domain, media) re-enables instead of duplicating
    again = await store.add_domain(user_id, "example.com", "ani")
    assert isinstance(again, Success) and again.unwrap()["id"] == row["id"]

    rows = await store.list_domains(user_id)
    assert {(r["domain"], r["media"]) for r in rows} == {
        ("example.com", "ani"), ("example.com", "yt"),
    }

    # Toggle off -> excluded from enabled_only; on -> back
    assert isinstance(await store.set_enabled(user_id, row["id"], False), Success)
    enabled = await store.list_domains(user_id, enabled_only=True)
    assert all(r["domain"] != "example.com" or r["media"] != "ani" for r in enabled)
    assert isinstance(await store.set_enabled(user_id, row["id"], True), Success)

    # Ownership guard
    assert isinstance(await store.set_enabled(user_id, 999999, True), Failure)
    assert isinstance(await store.remove_domain(user_id, 999999), Failure)

    assert isinstance(await store.remove_domain(user_id, row["id"]), Success)
    assert isinstance(await store.remove_domain(user_id, added_yt.unwrap()["id"]), Success)
    assert await store.list_domains(user_id) == []


# ---------- extension v2 phase 2: live watch sessions ----------

async def test_live_sessions_merge_and_crash_sweep():
    """Ext v2: live upserts stay out of the cursor until pause/ended merges
    them; a leftover row (power loss) is merged by the boot sweep."""
    user_id = await _user_id()
    _store, entry_id, _total = await _ani_entry(user_id)
    pool = await db.get_pool()

    async def _cursor():
        async with pool.acquire() as con:
            row = await con.fetchrow(
                "SELECT cursor_season, cursor_episode, cursor_position_seconds "
                "FROM ani_entries WHERE id = $1", entry_id)
        return (row["cursor_season"], row["cursor_episode"], row["cursor_position_seconds"])

    async def _live_row():
        async with pool.acquire() as con:
            return await con.fetchrow(
                "SELECT season, episode, position_seconds FROM ext_live_sessions "
                "WHERE user_id = $1 AND entry_id = $2", user_id, entry_id)

    before = await _cursor()

    # Upserts buffer in the live table only — the real cursor stays put.
    assert isinstance(await live.upsert_position(user_id, entry_id, 1, 4, 612), Success)
    assert isinstance(await live.upsert_position(user_id, entry_id, 1, 4, 700), Success)
    row = await _live_row()
    assert row["position_seconds"] == 700
    assert await _cursor() == before, "an upsert alone must never move the cursor"

    # Ownership: a foreign or unknown entry id cannot be upserted.
    assert isinstance(await live.upsert_position(user_id, 999999, 1, 1, 0), Failure)

    # Pause/ended: the final position becomes the real cursor; row deleted.
    assert isinstance(await live.end_session(user_id, entry_id, 1, 4, 731), Success)
    assert await _live_row() is None
    assert await _cursor() == (1, 4, 731)

    # Power loss: a leftover row is merged by the boot sweep.
    assert isinstance(await live.upsert_position(user_id, entry_id, 1, 7, 120), Success)
    merged = await live.sweep_all()
    assert merged >= 1
    assert await _live_row() is None
    assert await _cursor() == (1, 7, 120)

    await _store.delete_entry(user_id, entry_id)


# ---------- extension v2 phase 3: anchor detection ----------

def _entry(entry_id, titles, cursor=(None, None), seasons=()):
    """titles: plain strings (season unknown) or (title, season_no) tuples."""
    normed = []
    for i, t in enumerate(titles):
        if isinstance(t, tuple):
            normed.append((anchor._norm(t[0]), t[1]))
        else:
            normed.append((anchor._norm(t), None))
    return {
        "id": entry_id, "titles": normed,
        "cursor_season": cursor[0], "cursor_episode": cursor[1],
        "seasons": sorted(seasons),
    }


def test_anchor_parse_patterns():
    """Season/episode extraction across the shapes page titles actually use."""
    p = anchor._parse(anchor._norm("Naruto Shippuden S2 E5"))
    assert (p["season"], p["episode"]) == (2, 5)
    assert "naruto" in str(p["title"]) and "s2" not in str(p["title"])

    p = anchor._parse(anchor._norm("Attack on Titan Season 3 Episode 4"))
    assert (p["season"], p["episode"]) == (3, 4)

    p = anchor._parse(anchor._norm("One Piece Episode 1230"))
    assert (p["season"], p["episode"]) == (None, 1230)

    p = anchor._parse(anchor._norm("One Piece 1230"))
    assert (p["season"], p["episode"]) == (None, 1230) and p["title"] == "one piece"

    p = anchor._parse(anchor._norm("Bleach Season 2"))
    assert (p["season"], p["episode"]) == (2, None)

    p = anchor._parse(anchor._norm("Some random page"))
    assert (p["season"], p["episode"]) == (None, None)


def test_anchor_best_match_and_ambiguity():
    entries = [
        _entry(1, ["Naruto"], cursor=(2, 5)),
        _entry(2, ["One Punch Man"], cursor=(1, 3)),
    ]
    # page adds words around the title (score 2 containment)
    best = anchor._best_match(["Watch Naruto Episode 12 online - SiteName"], entries)
    assert best is not None and best["entry_id"] == 1 and best["episode"] == 12
    assert best["cursor_season"] == 2  # fallbacks ride along for the binding

    # nothing tracked -> None, never a guess
    assert anchor._best_match(["Totally unrelated page title"], entries) is None

    # 'one' must not word-boundary-match 'One Punch Man' on a generic page
    assert anchor._best_match(["the one thing i love"], entries) is None

    # ambiguity between two entries -> None (never bind wrong)
    dupes = [_entry(1, ["Naruto"]), _entry(2, ["Naruto"])]
    assert anchor._best_match(["Naruto Episode 5"], dupes) is None

    # longer season title beats the shorter entry title
    chain = [_entry(1, ["Naruto", ("Naruto Shippuden", 2)], cursor=(2, 5))]
    best = anchor._best_match(["Naruto Shippuden ep 40"], chain)
    assert best is not None and best["entry_id"] == 1 and best["episode"] == 40

    # the matched season title implies the season when the page omits it
    assert best["season"] == 2
    # ...but an explicit page season always wins
    best = anchor._best_match(["Naruto Shippuden S3 E10"], chain)
    assert best is not None and best["season"] == 3 and best["episode"] == 10
    # entry title (names S1) leaves season inference to absolute resolution
    chain2 = [_entry(1, ["Naruto"], seasons=[(1, 220), (2, 500)])]
    best = anchor._best_match(["Naruto ep 12"], chain2)
    assert best is not None and best["season"] is None  # resolved later, via chain walk

    # romaji long vowels fold: pages write 'shippuden', AniList 'shippuuden'
    romaji = [_entry(1, ["Naruto", ("NARUTO: Shippuuden", 2)])]
    best = anchor._best_match(["Watch Naruto Shippuden Episode 5 online"], romaji)
    assert best is not None and best["entry_id"] == 1 and best["season"] == 2


def test_anchor_absolute_episode_resolution():
    """'One Piece 1230' style: absolute numbers map into the chain."""
    best = {"entry_id": 1, "season": None, "episode": 120,
            "seasons": [(1, 100), (2, 50)], "matched": "x",
            "cursor_season": None, "cursor_episode": None}
    anchor._resolve_absolute(best)
    assert (best["season"], best["episode"]) == (2, 20)

    # unknown totals -> left alone
    best = {"entry_id": 1, "season": None, "episode": 120,
            "seasons": [(1, None)], "matched": "x",
            "cursor_season": None, "cursor_episode": None}
    anchor._resolve_absolute(best)
    assert best["season"] is None and best["episode"] == 120


async def test_anchor_match_against_db():
    """Phase 3 end to end: candidates from a fake page resolve to the tracked
    Naruto entry with the parsed episode; blocked entries never match."""
    user_id = await _user_id()
    store, entry_id, _total = await _ani_entry(user_id)

    result = await anchor.anchor_match(
        user_id, ["Watch Naruto Shippuden Episode 5 online - SiteName"])
    match = result.unwrap()
    assert match is not None
    assert match["entry_id"] == entry_id
    assert match["episode"] == 5
    # the matched Shippuden season title implies the chain season (S2)
    assert match["season"] == 2
    # cursor fallbacks present for the binding
    assert "cursor_season" in match and "cursor_episode" in match

    # nothing tracked on the page -> None, not an error
    result = await anchor.anchor_match(user_id, ["Some cooking tutorial site"])
    assert result.unwrap() is None

    # phase 4: blocked entries still match — flagged, with the reason, so
    # the extension shows the disclaimer instead of binding
    assert isinstance(
        await store.update_entry(user_id, entry_id, label="blocked", label_reason="bad pacing"),
        Success,
    )
    result = await anchor.anchor_match(user_id, ["Naruto Shippuden Episode 5"])
    match = result.unwrap()
    assert match is not None and match["blocked"] is True
    assert match["reason"] == "bad pacing"

    await store.delete_entry(user_id, entry_id)


async def test_ext_blocked_list_yt():
    """Phase 4: the extension's local disclaimer cache gets blocked channels
    only, decrypted server-side."""
    user_id = await _user_id()
    yt = PgStore()
    added = await yt.add_tracking(user_id, "UCblocked", "Blocked Chan", "https://www.youtube.com/@blocked")
    cid = added.unwrap()
    added2 = await yt.add_tracking(user_id, "UCfine", "Fine Chan", "https://www.youtube.com/@fine")
    cid2 = added2.unwrap()

    assert isinstance(
        await yt.set_label(user_id, cid, "blocked", "fake stunts"), Success)

    result = await list_blocked_yt(user_id)
    blocked = result.unwrap()
    assert len(blocked) == 1
    assert blocked[0]["name"] == "Blocked Chan"
    assert blocked[0]["url"] == "https://www.youtube.com/@blocked"

    await yt.delete_channel(user_id, cid)
    await yt.delete_channel(user_id, cid2)


# ---------- extension v2 phase 5: watch sites ----------

def test_watch_site_retarget():
    """Endpoint-pattern rewriting for the next episode URL."""
    # same season: episode token swaps
    assert sites._retarget("https://site.example/watch/naruto-episode-5", 1, 5, 1, 6) == \
        "https://site.example/watch/naruto-episode-6"
    # season token: s2e5 -> s3e1
    assert sites._retarget("https://site.example/naruto-s2e5", 2, 5, 3, 1) == \
        "https://site.example/naruto-s3e1"
    # zero-padded season keeps its prefix style
    assert sites._retarget("https://site.example/anime-s02e05", 2, 5, 3, 1) == \
        "https://site.example/anime-s03e01"
    # query param
    assert sites._retarget("https://site.example/play?id=42&ep=12", 1, 12, 1, 13) == \
        "https://site.example/play?id=42&ep=13"
    # no recognizable pattern -> None (caller falls back to the site home)
    assert sites._retarget("https://site.example/naruto", 1, 5, 1, 6) is None
    # too many lookalike tokens -> None rather than corrupt
    assert sites._retarget("https://site.example/5/5/5/naruto-5", 1, 5, 1, 6) is None
    # digits inside bigger numbers never rewrite (1080 stays put)
    assert sites._retarget("https://site.example/watch-1080/naruto-5", 1, 5, 1, 6) == \
        "https://site.example/watch-1080/naruto-6"


async def test_watch_sites_learn_and_resolve():
    """Phase 5: anchor reports teach the site map; the notification click
    resolves the next episode by pattern, else the site home."""
    user_id = await _user_id()
    store, entry_id, _total = await _ani_entry(user_id)
    pool = await db.get_pool()

    page = "https://animesite.example/watch/naruto-shippuden-episode-5"
    result = await anchor.anchor_match(user_id, ["Naruto Shippuden Episode 5"], page_url=page)
    assert result.unwrap() is not None

    async with pool.acquire() as con:
        row = await con.fetchrow(
            "SELECT season, episode, use_count FROM ani_watch_sites "
            "WHERE user_id = $1 AND entry_id = $2", user_id, entry_id)
    assert row is not None
    assert (row["season"], row["episode"], row["use_count"]) == (2, 5, 1)

    # the click for episode 6 rewrites the endpoint pattern
    link = (await sites.resolve_watch_link(user_id, entry_id, 2, 6)).unwrap()
    assert link == "https://animesite.example/watch/naruto-shippuden-episode-6"

    # an episode far from the stored pattern still resolves (pattern, not +1)
    link = (await sites.resolve_watch_link(user_id, entry_id, 2, 40)).unwrap()
    assert link == "https://animesite.example/watch/naruto-shippuden-episode-40"

    # repeat report bumps use_count
    await anchor.anchor_match(user_id, ["Naruto Shippuden Episode 5"], page_url=page)
    async with pool.acquire() as con:
        assert await con.fetchval(
            "SELECT use_count FROM ani_watch_sites WHERE user_id = $1 AND entry_id = $2",
            user_id, entry_id) == 2

    # a site with no pattern in the URL falls back to the site home
    await sites.learn_watch_site(user_id, entry_id, "https://plain.example/naruto", 1, 1)
    link = (await sites.resolve_watch_link(user_id, entry_id, 1, 2)).unwrap()
    # most-used row wins; force it by learning plain.example more times
    await sites.learn_watch_site(user_id, entry_id, "https://plain.example/naruto", 1, 1)
    await sites.learn_watch_site(user_id, entry_id, "https://plain.example/naruto", 1, 1)
    link = (await sites.resolve_watch_link(user_id, entry_id, 1, 2)).unwrap()
    assert link == "https://plain.example"

    await store.delete_entry(user_id, entry_id)


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


# ---------- per-season posters (P14) ----------

async def test_anime_seasons_store_all_posters():
    """P14: every season's poster is stored and exposed via management view,
    so the frontend can show the poster for the season the user is at."""
    user_id = await _user_id()
    store, entry_id, total = await _ani_entry(user_id)
    assert total >= 2, "Naruto chain should resolve multiple seasons"

    view = await store.management_view(user_id)
    entry = [e for e in view if e["id"] == entry_id][0]
    assert len(entry["seasons"]) == total

    # every season carries a poster (AniList coverImage.large)
    for season in entry["seasons"]:
        assert season.get("poster"), f"season {season['seasonNo']} missing poster"
        assert season["poster"].startswith("http"), f"season {season['seasonNo']} poster not a URL"

    # poster differs per season (each season has its own cover)
    posters = {s["poster"] for s in entry["seasons"]}
    assert len(posters) == total, "each season should have its own poster"

    # direct season row also has poster_enc
    pool = await db.get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT season_no, poster_enc IS NOT NULL AS has_poster FROM ani_seasons "
            "WHERE entry_id = $1 ORDER BY season_no",
            entry_id,
        )
    assert all(r["has_poster"] for r in rows), "every season row should store poster_enc"

    await store.delete_entry(user_id, entry_id)
