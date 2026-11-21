"""CSV backup (third backup style, after linkwarden txt D56 and pg_dump D33).

One CSV per media: youtube.csv is FreeTube-compatible in its first three
columns (Channel ID / Channel URL / Channel Title — FreeTube and
HydraWatch exports import directly), with DreaMedia's mode/words/rank/
withhold/label/category appended for full round-trip. anime.csv carries
title + AniList id + list/cursor/category. Import is column-tolerant:
FreeTube, HydraWatch, and our own exports all parse.
"""
from __future__ import annotations

import asyncio
import csv
import io
from typing import Any, Dict, List, Optional

from returns.result import Failure, Result, Success

from Database import vault
from Database.ani_store import AniStore
from Database.db import get_pool
from Database.pg_store import PgStore

YT_HEADER = [
    "Channel ID", "Channel URL", "Channel Title",
    "Mode", "Words", "Rank", "Withhold", "Label", "Label Reason", "Domain", "Subdomain",
]
ANI_HEADER = [
    "Title", "AniList ID", "List", "Cursor Season", "Cursor Episode",
    "Cursor Position", "Label", "Label Reason", "Domain", "Subdomain",
]


async def export_youtube(user_id: int) -> Result[str, str]:
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9) — log in to export")
    yt = PgStore()
    channels = await yt.channels_view(user_id, include_blocked=True)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(YT_HEADER)
    for ch in channels:
        writer.writerow([
            ch.get("rss_id") or "",
            ch.get("url") or "",
            ch.get("name") or "",
            ch.get("kind") or "tracking",
            ",".join(ch.get("words") or []),
            ch.get("rank") or "",
            ch.get("withhold_threshold") or "",
            ch.get("label") or "none",
            ch.get("label_reason") or "",
            ch.get("domain") if ch.get("domain") != "uncategorized" else "",
            ch.get("subdomain") if ch.get("subdomain") != "uncategorized" else "",
        ])
    return Success(out.getvalue())


async def export_anime(user_id: int) -> Result[str, str]:
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9) — log in to export")
    ani = AniStore()
    entries = await ani.management_view(user_id, include_blocked=True)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(ANI_HEADER)
    for e in entries:
        cursor = e.get("cursor") or {}
        writer.writerow([
            e.get("title") or "",
            e.get("anilist_id") or "",
            e.get("list") or "watching",
            cursor.get("season") or "",
            cursor.get("episode") if cursor.get("episode") is not None else "",
            cursor.get("position_seconds") if cursor.get("position_seconds") is not None else "",
            e.get("label") or "none",
            e.get("label_reason") or "",
            e.get("domain") if e.get("domain") != "uncategorized" else "",
            e.get("subdomain") if e.get("subdomain") != "uncategorized" else "",
        ])
    return Success(out.getvalue())


def _rows(text: str) -> Result[List[Dict[str, str]], str]:
    """DictReader with case-insensitive, whitespace-tolerant headers."""
    try:
        reader = csv.DictReader(io.StringIO(text.strip()))
        if not reader.fieldnames:
            return Failure("empty CSV")
        rows = []
        for raw in reader:
            rows.append({(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()})
        return Success(rows)
    except csv.Error as exc:
        return Failure(f"invalid CSV: {exc}")


def _col(row: Dict[str, str], *names: str) -> Optional[str]:
    for name in names:
        value = row.get(name)
        if value:
            return value
    return None


def _int_or_none(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


async def import_youtube(user_id: int, text: str) -> Result[Dict[str, Any], str]:
    """FreeTube ('Channel ID,Channel URL,Channel Title'), HydraWatch, and
    our own export format. Rows with a stored rss id skip network
    resolution; foreign rows resolve through the same path the extension
    subscribe flow uses."""
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9) — log in to import")
    parsed = _rows(text)
    if isinstance(parsed, Failure):
        return parsed
    from Orchestrator.Yt.Fetch.convert import resolve_channel

    yt = PgStore()
    imported, skipped = 0, 0
    errors: List[str] = []
    for row in parsed.unwrap():
        url = _col(row, "channel url", "url", "link", "channel")
        if not url or "://" not in url:
            skipped += 1
            continue
        mode = (_col(row, "mode", "kind") or "tracking").lower()
        if mode not in ("tracking", "wordscan", "playlist", "random", "withhold"):
            mode = "tracking"
        rss_id = _col(row, "channel id", "rss id", "rss_id")
        name = _col(row, "channel title", "title", "name")
        logo = None
        if not rss_id or not name:
            resolved = await asyncio.to_thread(resolve_channel, url)
            if isinstance(resolved, Failure):
                skipped += 1
                errors.append(f"{url}: {resolved.failure()}")
                continue
            info = resolved.unwrap()
            rss_id = rss_id or info.rss_id
            name = name or info.name
            logo = info.logo
        words_raw = _col(row, "words")
        words = [w for w in (words_raw or "").split(",") if w] or None
        if mode == "playlist":
            result = await yt.add_playlist(user_id, rss_id, name or "Playlist", url, logo=logo)
        elif mode == "random":
            result = await yt.add_random(user_id, name or url, url, _col(row, "rank") or "week", logo=logo)
        else:
            result = await yt.add_tracking(
                user_id, rss_id, name or url, url,
                kind="tracking" if mode == "withhold" else mode,
                words=words, logo=logo,
            )
            if isinstance(result, Success) and mode == "withhold":
                await yt.switch_mode(
                    user_id, result.unwrap(), "withhold",
                    withhold=_int_or_none(_col(row, "withhold")) or 2,
                )
        if isinstance(result, Failure):
            skipped += 1
            errors.append(f"{url}: {result.failure()}")
            continue
        channel_id = result.unwrap()
        imported += 1
        label = (_col(row, "label") or "none").lower()
        if label in ("blocked", "reserved"):
            await yt.set_label(user_id, channel_id, label, _col(row, "label reason", "reason"))
        domain = _col(row, "domain")
        if domain:
            await yt.assign_category(user_id, channel_id, domain, _col(row, "subdomain"))
    return Success({"imported": imported, "skipped": skipped, "errors": errors[:10]})


async def import_anime(user_id: int, text: str) -> Result[Dict[str, Any], str]:
    """anime.csv round-trip + any CSV with a title column (HydraWatch)."""
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9) — log in to import")
    parsed = _rows(text)
    if isinstance(parsed, Failure):
        return parsed
    from Orchestrator.Ani.Fetch.ani_track import ani_fetch

    ani = AniStore()
    imported, skipped = 0, 0
    errors: List[str] = []
    for row in parsed.unwrap():
        title = _col(row, "title", "name", "anime")
        if not title:
            skipped += 1
            continue
        fetch = await ani_fetch(title)
        if isinstance(fetch, Failure):
            skipped += 1
            errors.append(f"{title}: {fetch.failure()}")
            continue
        data = fetch.unwrap()
        list_kind = (_col(row, "list", "list kind") or "watching").lower()
        added = await ani.add_entry(
            user_id, int(data[0][1]["id"]), title, data[0][1].get("thumbnail"), data,
            list_kind=list_kind if list_kind in (
                "watching", "up_to_date", "watchlist", "next_sequel", "new_anime") else "watching",
        )
        if isinstance(added, Failure):
            skipped += 1
            errors.append(f"{title}: {added.failure()}")
            continue
        entry_id = added.unwrap()
        imported += 1
        season = _int_or_none(_col(row, "cursor season", "season"))
        if season:
            await ani.set_progress(
                user_id, entry_id, season,
                _int_or_none(_col(row, "cursor episode", "episode")) or 0,
                _int_or_none(_col(row, "cursor position", "position")),
            )
        label = (_col(row, "label") or "none").lower()
        if label in ("blocked", "reserved", "completed"):
            await ani.update_entry(
                user_id, entry_id, label=label, label_reason=_col(row, "label reason", "reason"))
        domain = _col(row, "domain")
        if domain:
            subdomain_id = await ani.ensure_category(user_id, domain, _col(row, "subdomain"))
            if subdomain_id:
                await ani.update_entry(user_id, entry_id, subdomain_id=subdomain_id)
    return Success({"imported": imported, "skipped": skipped, "errors": errors[:10]})
