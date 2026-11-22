"""Async YouTube RSS fetcher — HTTP/2 enforced.

NOTE (swap flagged for owner review): the snapshot parsed RSS with
pandas.read_xml — a ~40MB dependency for one XML parse. Replaced with
stdlib ElementTree; same output contract. Revert if pandas is wanted
for the Polars-adjacent CSV work later.
"""
from __future__ import annotations

import asyncio
import xml.etree.ElementTree as ET
from typing import List

import httpx
from returns.result import Failure, Result, Success

from Model.video import FetchPayload, Video, VideosDict
from Utility.http import get_async_client
from Utility.logs import log

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}


class FeedFormatError(ValueError):
    """The HTTP response was not a parseable YouTube Atom feed."""


def _parse_feed(xml_content: str) -> tuple[List[Video], int]:
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError as exc:
        raise FeedFormatError("malformed XML") from exc
    if root.tag != f"{{{_NS['atom']}}}feed":
        raise FeedFormatError(f"unexpected XML root {str(root.tag)[:120]!r}")

    entries = root.findall("atom:entry", _NS)
    videos: List[Video] = []
    for entry in entries:
        vid_el = entry.find("yt:videoId", _NS)
        vid = (vid_el.text or "").strip() if vid_el is not None else ""
        if not vid:
            entry_id = entry.findtext("atom:id", "", _NS)
            vid = entry_id.split(":")[-1] if ":" in entry_id else entry_id
        if not vid:
            continue
        title = (entry.findtext("atom:title", "No title", _NS) or "No title").strip() or "No title"
        published = (entry.findtext("atom:published", "", _NS) or "").strip()
        url = None
        for link in entry.findall("atom:link", _NS):
            if link.get("rel") == "alternate" and link.get("href"):
                url = link.get("href")
                break
        if not url:
            url = f"https://www.youtube.com/watch?v={vid}"
        thumbnail = None
        media_group = entry.find("media:group", _NS)
        if media_group is not None:
            thumb_el = media_group.find("media:thumbnail", _NS)
            if thumb_el is not None:
                thumbnail = thumb_el.get("url")
        videos.append(
            Video(id=vid, title=title, url=url, published=published, thumbnail=thumbnail)
        )
    return videos, len(entries)


def parse_youtube_feed(xml_content: str) -> List[Video]:
    """Parse a YouTube channel RSS XML into Video objects (stdlib only)."""
    try:
        videos, _entry_count = _parse_feed(xml_content)
    except FeedFormatError:
        return []
    return videos


def _to_payload(videos: List[Video]) -> FetchPayload:
    videos.sort(key=lambda v: v.published, reverse=True)
    videos_dict: VideosDict = {
        i + 1: {
            "id": v.id,
            "title": v.title,
            "url": v.url,
            "thumbnail": v.thumbnail or "",
            "published": v.published,
        }
        for i, v in enumerate(videos)
    }
    return (videos_dict,)


async def yt_rss(rss_id: str) -> Result[FetchPayload, str]:
    """Fetch + parse a channel RSS feed. Success((videos_dict,)) | Failure(msg)."""
    feed_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={rss_id}"
    try:
        async with get_async_client(youtube_consent=True) as client:
            response = await client.get(feed_url)
            response.raise_for_status()
            log.info(
                "Fetched feed for channel %s (HTTP/%s)",
                rss_id,
                response.http_version,
            )
    except (httpx.HTTPStatusError, httpx.RequestError) as err:
        log.error("HTTP error fetching feed %s: %s", rss_id, err)
        return Failure("HTTP Error")

    content_type = response.headers.get("content-type", "unknown")
    try:
        videos, entry_count = _parse_feed(response.text)
    except FeedFormatError as exc:
        log.warning(
            "Invalid YouTube feed for channel %s (content-type=%r): %s",
            rss_id,
            content_type,
            exc,
        )
        return Failure("Invalid Feed")
    except Exception:
        log.exception("Unexpected YouTube feed parser error for channel %s", rss_id)
        return Failure("Parsing Error")
    if not videos:
        if entry_count == 0:
            log.info(
                "Valid YouTube Atom feed contains no entries for channel %s",
                rss_id,
            )
            return Failure("Empty Feed")
        log.warning(
            "YouTube Atom feed for channel %s had %s entries but no usable video IDs (content-type=%r)",
            rss_id,
            entry_count,
            content_type,
        )
        return Failure("Invalid Feed")
    return Success(_to_payload(videos))


if __name__ == "__main__":
    result = asyncio.run(yt_rss("UCX6OQ3DkcsbYNE6H8uQQuVA"))  # MrBeast
    if isinstance(result, Failure):
        print(f"Failed: {result.failure()}")
    else:
        for num, video in result.unwrap()[0].items():
            print(f"{num}. {video['title']}  ({video['published']})")
