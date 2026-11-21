"""Portable txt backup (D56) — linkwarden-style.

pg_dump is fragile across schema changes; this export is application-level:
the owner's data, decrypted with their vault key, as plain JSON in a .txt
file. Re-import re-encrypts under whatever the CURRENT schema is, so a dump
from any older version still restores.
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict

from returns.result import Failure, Result, Success

from Database import vault
from Database.ani_store import AniStore
from Database.card_store import CardStore
from Database.db import get_pool
from Database.pg_store import PgStore

FORMAT_VERSION = 1


async def export_user(user_id: int) -> Result[str, str]:
    """Decrypted, schema-independent snapshot of one user's data as JSON text."""
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9) — log in to export")

    yt = PgStore()
    ani = AniStore()
    cards = CardStore()

    channels = await yt.channels_view(user_id, include_blocked=True)
    card_list = await cards.list_cards(user_id)
    entries = await ani.management_view(user_id, include_blocked=True)
    yt_domains = await yt.domains_tree(user_id) if hasattr(yt, "domains_tree") else {}

    payload: Dict[str, Any] = {
        "format": "dreamedia-portable",
        "version": FORMAT_VERSION,
        "exported_at": int(time.time()),
        "youtube": {
            "channels": channels,
            "cards": card_list,
        },
        "anime": {
            "entries": entries,
        },
    }
    return Success(json.dumps(payload, indent=2, default=str))


async def import_user(user_id: int, text: str) -> Result[Dict[str, int], str]:
    """Restore a portable export: re-encrypt everything under the current key."""
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9) — log in to import")
    try:
        payload = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return Failure("not a DreaMedia portable export (invalid JSON)")
    if payload.get("format") != "dreamedia-portable":
        return Failure("not a DreaMedia portable export")

    from returns.result import Failure as F

    yt = PgStore()
    counts = {"channels": 0, "cards": 0, "anime": 0, "skipped": 0}

    # YouTube channels: re-subscribe by URL (the resolver re-fetches metadata —
    # this is the schema-independent path: links, not row data).
    for ch in (payload.get("youtube") or {}).get("channels") or []:
        url = ch.get("url")
        if not url:
            counts["skipped"] += 1
            continue
        kind = ch.get("kind") or "tracking"
        try:
            if kind == "playlist":
                result = await yt.add_playlist(
                    user_id, ch.get("rss_id") or url, ch.get("name") or "Playlist", url,
                )
            elif kind == "random":
                result = await yt.add_random(user_id, ch.get("name") or url, url, ch.get("rank") or "week")
            else:
                result = await yt.add_tracking(
                    user_id, ch.get("rss_id") or url, ch.get("name") or url, url,
                    kind=kind, words=ch.get("words"),
                )
            if isinstance(result, F):
                counts["skipped"] += 1
            else:
                counts["channels"] += 1
        except Exception:
            counts["skipped"] += 1

    # Playlists (cards): recreate empty, items re-resolve on add via /ext or UI
    cards_store = CardStore()
    for card in (payload.get("youtube") or {}).get("cards") or []:
        name = card.get("name") or "Restored playlist"
        result = await cards_store.create_card(user_id, name)
        if isinstance(result, F):
            counts["skipped"] += 1
            continue
        counts["cards"] += 1
        # items carry url + title + thumbnail from the export — no re-fetch needed
        card_id = result.unwrap()
        for item in card.get("items") or []:
            url = item.get("url")
            if not url:
                continue
            await cards_store.add_item(
                user_id, card_id, item.get("video_id") or url, url,
                item.get("title") or url, item.get("thumbnail"),
            )

    # Anime entries: re-track by title (AniList re-resolves the chain)
    from Orchestrator.Ani.Fetch.ani_track import ani_fetch

    ani = AniStore()
    for entry in (payload.get("anime") or {}).get("entries") or []:
        title = entry.get("title")
        if not title:
            counts["skipped"] += 1
            continue
        try:
            fetch = await ani_fetch(title)
            if isinstance(fetch, F):
                counts["skipped"] += 1
                continue
            data = fetch.unwrap()
            added = await ani.add_entry(
                user_id, int(data[0][1]["id"]), title, entry.get("cover"), data,
                list_kind=entry.get("list") or "watching",
            )
            if isinstance(added, F):
                counts["skipped"] += 1
                continue
            counts["anime"] += 1
            entry_id = added.unwrap()
            cursor = entry.get("cursor") or {}
            if cursor.get("season"):
                await ani.set_cursor(
                    user_id, entry_id, cursor["season"],
                    cursor.get("episode"), cursor.get("position_seconds"),
                )
            for season in entry.get("seasons") or []:
                if season.get("watched") and season.get("season_no"):
                    await ani.set_season_watched(user_id, entry_id, season["season_no"], True)
        except Exception:
            counts["skipped"] += 1

    return Success(counts)
