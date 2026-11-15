"""Seed a realistic demo workspace for end-to-end review.

Usage (from Backend/):  .venv/bin/python scripts/seed_demo.py
Requires PostgreSQL running and the schema migrated (the app does that on
start, or `python -c "import asyncio; from Database import db; asyncio.run(db.migrate())"`).
"""
from __future__ import annotations

import asyncio
import random
import time
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import Utility.env  # noqa: F401

from returns.result import Success

from Auth import auth
from Database import db, vault
from Database.ani_store import AniStore
from Database.card_store import CardStore
from Database.crypto import encrypt
from Database.pg_store import PgStore

USERNAME = "demo"
PASSWORD = "demo1234"

NOW = int(time.time())
DAY = 86400


def avatar(seed: str) -> str:
    return f"https://api.dicebear.com/9.x/shapes/svg?seed={seed}&backgroundColor=1f2430"


def thumb(video_id: str) -> str:
    # Deterministic abstract art so the demo never shows broken images.
    return (
        "https://api.dicebear.com/9.x/shapes/svg?seed="
        f"{video_id}&backgroundColor=161b26,1c2230&shape1Color=3d4a6b&shape2Color=586a9c&shape3Color=8f7ad6"
    )


YT = [
    # (domain, subdomain, channel, kind, rank, notify_domain, videos[(id,title,days_ago,seen)])
    ("Technology", "Hardware", "Marques Brownlee", "tracking", "day", True, [
        ("S1VkZ4k9K2A", "The M5 MacBook Air is genuinely different", 0.02, False),
        ("Kq3J8m2nP0c", "Pixel 10 Pro review: the camera everyone copies", 0.3, False),
        ("a7Mn2Pq9R4t", "I tried the $25,000 transparent TV", 1.6, False),
        ("Jd9Ks2Lm4Nv", "Why I switched back to Android", 4.2, True),
    ]),
    ("Technology", "Software", "Fireship", "tracking", "day", True, [
        ("zQ1xW8vT2bY", "Bun 2.0 just made Node.js sweat", 0.06, False),
        ("mR4nB7cV1sD", "Every CSS layout in 100 seconds", 0.9, False),
        ("pL8kJ3hG6fS", "The framework wars are over", 2.4, True),
    ]),
    ("Technology", "AI", "Two Minute Papers", "tracking", "tri_day", True, [
        ("xV2cN5bM8qW", "This AI renders worlds in real time", 0.12, False),
        ("hJ6kL9pO2iU", "DeepMind's new model is unsettling", 1.1, False),
    ]),
    ("Music", "Electronic", "The Chainsmokers", "playlist", "week", True, [
        ("Yb7dF3gH9jK", "Live from Red Rocks — full set", 0.2, False),
        ("Tq5wE8rT1yU", "Something Just Like This (Live)", 2.8, True),
    ]),
    ("Music", "Ambient", "C418", "random", "week", True, [
        ("Wq3eR5tY7uI", "Minecraft — Subwoofer Lullaby", 0.4, False),
    ]),
    ("Learning", "Science", "Kurzgesagt", "tracking", "week", True, [
        ("Lk9jH2gF5dS", "What if the sun went out tomorrow?", 0.5, False),
        ("Mn4bV7cX1zQ", "The universe's biggest paradox", 3.1, True),
    ]),
    ("Learning", "Science", "Veritasium", "wordscan", "week", True, [
        ("Qw8eR2tY6uI", "The experiment that broke physics", 0.7, False),
    ]),
    ("Learning", "Mathematics", "3Blue1Brown", "tracking", "tri_day", False, [
        ("Ab3cD6eF9gH", "But what is a neural network, really?", 1.3, False),
        ("Ij1kL4mN7oP", "The beauty of Bézier curves", 5.5, True),
    ]),
    ("Gaming", "Reviews", "Skill Up", "tracking", "week", False, [
        ("Rt5yU8iO1pA", "I strongly recommend this RPG", 0.35, False),
    ]),
    ("Gaming", "Documentary", "Noclip", "tracking", "week", False, [
        ("Sd2fG5hJ8kL", "The making of a cult classic", 1.9, False),
    ]),
    ("News", "Daily", "Some Spam Channel", "tracking", "day", True, [
        ("Zx9cV1bN3mQ", "SHOCKING secret they don't want you to know", 0.8, True),
    ]),
]

ANI = [
    # (title, type, domain, subdomain, list, watch_state, label, notify, seasons[(no, status, eps, aired, start, state, watched)], events[(kind, season, hours_ago)])
    ("Frieren: Beyond Journey's End", "TV", "Fantasy", "Adventure", "watching", None, "none", True,
     [(1, "FINISHED", 28, 28, "2023-09-29", "finished", True),
      (2, "RELEASING", 12, 4, "2026-10-02", "airing", False)],
     [("next_episode_date", 2, 3), ("next_episode_date", 2, 27)]),
    ("Jujutsu Kaisen", "TV", "Shonen", "Action", "watching", None, "none", True,
     [(1, "FINISHED", 24, 24, "2020-10-03", "finished", True),
      (2, "FINISHED", 23, 23, "2023-07-06", "finished", True),
      (3, "RELEASING", 12, 7, "2026-09-18", "airing", False)],
     [("next_episode_date", 3, 9)]),
    ("Dandadan", "TV", "Shonen", "Comedy", "watching", None, "none", True,
     [(1, "FINISHED", 12, 12, "2024-10-04", "finished", True),
     (2, "RELEASING", 12, 9, "2026-07-04", "airing", False)],
     [("episode_released", 2, 3), ("next_episode_date", 2, 30)]),
    ("Chainsaw Man — Reze Arc", "MOVIE", "Shonen", "Action", "next_sequel", None, "none", True,
     [(1, "FINISHED", 12, 12, "2022-10-12", "finished", True),
      (2, "NOT_YET_RELEASED", 1, 0, "2027-03-14", "announced", False)],
     [("next_sequel_date", 2, 20), ("release_changed", 2, 74)]),
    ("Violet Evergarden", "TV", "Drama", "Slice of Life", "watchlist", "confirmed", "none", True,
     [(1, "FINISHED", 13, 13, "2018-01-11", "finished", False)],
     [("release_confirmed", 1, 120)]),
    ("A Silent Voice", "MOVIE", "Drama", "Romance", "watchlist", "maybe", "none", False,
     [(1, "FINISHED", 1, 1, "2016-09-17", "finished", False)], []),
    ("Sousou no Frieren S3", "TV", "Fantasy", "Adventure", "new_anime", None, "none", True,
     [(1, "NOT_YET_RELEASED", 12, 0, None, "unknown", False)], []),
    ("One Punch Man", "TV", "Shonen", "Action", "watching", None, "none", True,
     [(1, "FINISHED", 12, 12, "2015-10-05", "finished", True),
      (2, "FINISHED", 12, 12, "2019-04-03", "finished", True),
      (3, "RELEASING", 12, 2, "2026-10-05", "airing", False)],
     [("episode_postponed", 3, 6)]),
    ("Cyberpunk: Edgerunners", "ONA", "Drama", "Sci-Fi", "watching", None, "completed", False,
     [(1, "FINISHED", 10, 10, "2022-09-13", "finished", True)], []),
    ("Made in Abyss", "TV", "Fantasy", "Adventure", "next_sequel", None, "none", True,
     [(1, "FINISHED", 13, 13, "2017-07-07", "finished", True),
      (2, "FINISHED", 12, 12, "2022-07-06", "finished", True)],
     [("next_sequel", 3, 40)]),
    ("Bocchi the Rock!", "TV", "Comfort", "Slice of Life", "watchlist", "confirmed", "none", True,
     [(1, "FINISHED", 12, 12, "2022-10-09", "finished", False)], []),
    ("Attack on Titan", "TV", "Seinen", "Thriller", "watching", None, "blocked", False,
     [(1, "FINISHED", 25, 25, "2013-04-07", "finished", True)], []),
]

EVENT_PAYLOADS = {
    "next_episode_date": {"episode": 8, "airing_at": NOW + 2 * DAY},
    "episode_released": {"episode": 9, "previous": 8},
    "next_sequel_date": {"release": "2027-03-14", "title": "Reze Arc"},
    "release_changed": {"old": "2027-01-10", "new": "2027-03-14"},
    "release_confirmed": {"release": "2027-03-14"},
    "episode_postponed": {"was": "2026-11-12", "now": "2026-11-19"},
    "next_sequel": {"title": "Made in Abyss S3", "format": "TV", "release": "2027-01-08"},
    "new_anime_date": {"release": "2027-01-08", "title": "Frieren S3"},
}


async def main() -> None:
    await db.migrate()
    pool = await db.get_pool()

    result = await auth.signup(USERNAME, PASSWORD)
    if not isinstance(result, Success):
        result = await auth.login(USERNAME, PASSWORD)
    assert isinstance(result, Success), result
    user_id = result.unwrap()["user_id"]
    key = await vault.get(user_id)
    assert key, "vault key missing"

    async with pool.acquire() as con:
        await con.execute("DELETE FROM yt_cards WHERE user_id = $1", user_id)
        await con.execute("DELETE FROM yt_channels WHERE user_id = $1", user_id)
        await con.execute("DELETE FROM yt_domains WHERE user_id = $1", user_id)
        await con.execute("DELETE FROM ani_entries WHERE user_id = $1", user_id)
        await con.execute("DELETE FROM ani_domains WHERE user_id = $1", user_id)
        await con.execute("DELETE FROM notifications WHERE user_id = $1", user_id)

    store = PgStore()
    ani = AniStore()
    cards = CardStore()

    # ---------------- YouTube ----------------
    for domain, subdomain, channel, kind, rank, notify_domain, videos in YT:
        url = f"https://www.youtube.com/results?search_query={channel.replace(' ', '+')}"
        rss = f"UC{random.getrandbits(96):024x}"[:24]
        if kind == "playlist":
            channel_id = (await store.add_playlist(user_id, f"PL{random.getrandbits(80):020x}", channel, url)).unwrap()
        elif kind == "random":
            channel_id = (await store.add_random(user_id, channel, url, rank)).unwrap()
        else:
            channel_id = (await store.add_tracking(user_id, rss, channel, url, kind=kind)).unwrap()
        await store.assign_category(user_id, channel_id, domain, subdomain)
        await con_exec(pool, "UPDATE yt_channels SET notify = $3 WHERE id = $1 AND user_id = $2",
                       channel_id, user_id, notify_domain)
        if channel == "Some Spam Channel":
            await store.set_label(user_id, channel_id, "blocked", "clickbait / repost farm")
        for vid, title, days_ago, seen in videos:
            await con_exec(
                pool,
                "INSERT INTO yt_videos (channel_id, url_enc, url_hash, title_enc, thumbnail_enc, published_at, seen) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
                channel_id,
                encrypt(key, f"https://www.youtube.com/watch?v={vid}"),
                index_hash_safe(key, vid),
                encrypt(key, title), encrypt(key, thumb(vid)),
                int((time.time() - days_ago * DAY)), seen,
            )

    # mute one entire subdomain (Learning/Mathematics) and one channel (Skill Up)
    async with pool.acquire() as con:
        await con.execute(
            "UPDATE yt_subdomains s SET notify = FALSE FROM yt_domains d "
            "WHERE s.domain_id = d.id AND d.user_id = $1 AND s.name_hash = $2",
            user_id, index_hash_safe(key, "mathematics"),
        )
    # channel-level mute by decrypting names in Python (portable)
    channels = await store.channels_view(user_id, include_blocked=True)
    for c in channels:
        if c["name"] == "Skill Up":
            await store.set_channel_notify(user_id, c["id"], False)

    # ---------------- Playlists (Todo) ----------------
    playlists = [
        ("Weekend binge", [
            ("dQw4w9WgXcQ", "The video everyone links", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            ("S1VkZ4k9K2A", "M5 MacBook Air — full review", "https://www.youtube.com/watch?v=S1VkZ4k9K2A"),
            ("Lk9jH2gF5dS", "What if the sun went out?", "https://www.youtube.com/watch?v=Lk9jH2gF5dS"),
        ]),
        ("Learn GPU internals", [
            ("Ab3cD6eF9gH", "Neural networks, visually", "https://www.youtube.com/watch?v=Ab3cD6eF9gH"),
            ("mR4nB7cV1sD", "Every CSS layout in 100s", "https://www.youtube.com/watch?v=mR4nB7cV1sD"),
        ]),
        ("Music sets", [
            ("Yb7dF3gH9jK", "Red Rocks full set", "https://www.youtube.com/watch?v=Yb7dF3gH9jK"),
            ("Wq3eR5tY7uI", "Subwoofer Lullaby", "https://www.youtube.com/watch?v=Wq3eR5tY7uI"),
        ]),
    ]
    for name, items in playlists:
        card_id = (await cards.create_card(user_id, name)).unwrap()
        for i, (vid, title, url) in enumerate(items):
            item_id = (await cards.add_item(user_id, card_id, vid, url, title, thumb(vid))).unwrap()
            if i == 0 and name != "Music sets":
                await cards.set_item_done(user_id, item_id, True)

    # ---------------- Anime ----------------
    for (title, atype, domain, subdomain, list_kind, watch_state, label, notify,
         seasons, events) in ANI:
        subdomain_id = await ani.ensure_category(user_id, domain, subdomain)
        payload = {}
        for (no, status, eps, aired, start, state, watched) in seasons:
            sid = 10_000 + random.getrandbits(20)
            payload[no] = {
                "id": sid, "title": f"{title} S{no}" if no > 1 else title,
                "status": status, "episodes": eps,
                "published": start, "next_airing": (
                    {"airingAt": NOW + 3 * DAY, "episode": aired + 1} if state == "airing" else None
                ),
                "format": atype,
            }
        first_id = payload[1]["id"]
        entry_id = (await ani.add_entry(
            user_id, first_id, title, cover_for(title), (payload,), list_kind,
            anime_type=atype, subdomain_id=subdomain_id,
        )).unwrap()
        async with pool.acquire() as con:
            for (no, status, eps, aired, start, state, watched) in seasons:
                await con.execute(
                    "UPDATE ani_seasons SET state = $3, watched = $4, episodes_aired = $5, "
                    "release_date = $6, next_airing_at = $7, next_airing_ep = $8 "
                    "WHERE entry_id = $1 AND season_no = $2",
                    entry_id, no, state, watched, aired, start,
                    NOW + 3 * DAY if state == "airing" else None,
                    aired + 1 if state == "airing" else None,
                )
            await con.execute(
                "UPDATE ani_entries SET label = $3, watch_state = $4, notify_release = $5, "
                "canon_only = $6 WHERE id = $1 AND user_id = $2",
                entry_id, user_id, label, watch_state, notify, random.random() < 0.4,
            )
            watched_seasons = [s for s in seasons if s[6]]
            if watched_seasons:
                last = watched_seasons[-1]
                await con.execute(
                    "UPDATE ani_entries SET cursor_season = $3, cursor_episode = $4, "
                    "cursor_position_seconds = $5 WHERE id = $1 AND user_id = $2",
                    entry_id, user_id, last[0], last[3], 640,
                )
        for kind, season_no, hours_ago in events:
            await ani.emit_event(
                user_id, entry_id, season_no, kind,
                "awaited" if any(s[6] for s in seasons) else "unwatched",
                EVENT_PAYLOADS.get(kind, {}),
            )
            async with pool.acquire() as con:
                await con.execute(
                    "UPDATE ani_events SET created_at = now() - ($2 || ' hours')::interval "
                    "WHERE entry_id = $1 AND kind = $3 AND created_at > now() - interval '1 minute'",
                    entry_id, str(hours_ago), kind,
                )

    await _push_demo_messages(user_id)
    await db.close()
    print("Seeded demo workspace for user 'demo' / 'demo1234'.")


COVER_COLORS = ["332a52", "243a44", "43303c", "2b3a2c", "2f3348", "3c2f28"]


async def _push_demo_messages(user_id: int) -> None:
    """Populate the bell through the frontend receiver (the only bell lane)."""
    import os

    url = os.environ.get("FRONTEND_NOTIFY_URL")
    if not url:
        return
    try:
        import httpx

        headers = {}
        token = os.environ.get("FRONTEND_NOTIFY_TOKEN")
        if token:
            headers["X-Dreamedia-Token"] = token
        samples = [
            {
                "media": "yt", "kind": "tracking_video",
                "title": "The M5 MacBook Air is genuinely different",
                "message": "Marques Brownlee · Track",
                "url": "https://www.youtube.com/watch?v=S1VkZ4k9K2A",
            },
            {
                "media": "ani", "kind": "release_confirmed",
                "title": "Frieren: Beyond Journey's End",
                "message": "Release confirmed · Season 2", "level": "release",
            },
            {
                "media": "ani", "kind": "next_episode_date",
                "title": "Dandadan", "message": "New episode · Season 1 · in 3d",
                "level": "release",
            },
        ]
        async with httpx.AsyncClient(timeout=4.0) as client:
            for index, sample in enumerate(samples, start=1):
                body = {
                    "id": f"demo-{user_id}-{index}",
                    "rowId": None,
                    "userId": user_id,
                    "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() - index * 900)),
                    "payload": {},
                    **sample,
                }
                await client.post(url, json=body, headers=headers)
        print("  ✓ demo bell messages pushed to the frontend receiver")
    except Exception as exc:  # pragma: no cover - bridge optional
        print(f"  ! could not push demo messages ({exc})")


def cover_for(title: str) -> str:
    from urllib.parse import quote

    color = COVER_COLORS[sum(map(ord, title)) % len(COVER_COLORS)]
    return (
        "https://api.dicebear.com/9.x/initials/svg?seed="
        f"{quote(title)}&backgroundColor={color}&textColor=e9e4ff&fontSize=40&fontWeight=600"
    )


def index_hash_safe(key, text: str):
    from Database.crypto import index_hash
    return index_hash(key, text)


async def con_exec(pool, sql, *args):
    async with pool.acquire() as con:
        await con.execute(sql, *args)


if __name__ == "__main__":
    asyncio.run(main())
