"""Async random-video fetcher — picks one random video from a channel.

Strategy (owner's design): count videos (HTML scrape, yt-dlp fallback),
pick a random position, then fetch that position using yt-dlp negative
indexing when it's in the back half. yt-dlp is blocking → thread offload.
"""
from __future__ import annotations

import asyncio
import json
import random
import re
from typing import Any, Dict

import httpx
from returns.result import Failure, Result, Success
from yt_dlp import YoutubeDL

from Model.video import FetchPayload
from Utility.http import get_privacy_headers
from Utility.logs import log


def _normalize_channel_url(url: str) -> str:
    url = url.rstrip("/")
    return re.sub(r"/(videos|shorts|streams|oldest|popular)$", "", url)


def _nested(data: Dict[str, Any], path: list) -> Any:
    current = data
    for key in path:
        if isinstance(current, dict) and key in current:
            current = current[key]
        else:
            return None
    return current


def _count_from_html(html: str) -> Result[int, str]:
    start_marker = "var ytInitialData = "
    start_idx = html.find(start_marker)
    if start_idx == -1:
        start_marker = 'window["ytInitialData"] = '
        start_idx = html.find(start_marker)
    if start_idx == -1:
        return Failure("Could not extract ytInitialData marker")
    start_idx += len(start_marker)
    end_idx = html.find("};", start_idx)
    if end_idx == -1:
        end_idx = html.find("}</script>", start_idx)
    if end_idx == -1:
        return Failure("Could not find end of ytInitialData JSON object")
    try:
        data = json.loads(html[start_idx : end_idx + 1])
    except Exception as e:
        return Failure(f"JSON parse failed: {e}")

    metadata_rows = _nested(
        data,
        [
            "header", "pageHeaderRenderer", "content", "pageHeaderViewModel",
            "metadata", "contentMetadataViewModel", "metadataRows",
        ],
    )
    if not isinstance(metadata_rows, list):
        return Failure("No metadataRows found")
    for row in metadata_rows:
        for part in row.get("metadataParts") or []:
            text = _nested(part, ["text", "content"])
            if text and "videos" in str(text).lower():
                digits = "".join(filter(str.isdigit, str(text)))
                if digits and int(digits) > 0:
                    return Success(int(digits))
    return Failure("No video count found in metadata")


def _video_count(base_url: str) -> Result[int, str]:
    try:
        with httpx.Client(
            http2=True, headers=get_privacy_headers(), timeout=20.0,
            follow_redirects=True,
        ) as client:
            response = client.get(base_url)
            if response.status_code == 200:
                result = _count_from_html(response.text)
                if isinstance(result, Success):
                    return result
    except Exception as e:
        log.error("HTML count request failed: %s", e)

    ydl_opts = {
        "quiet": True, "extract_flat": "in_playlist",
        "playlist_items": "0", "no_warnings": True,
    }
    try:
        with YoutubeDL(ydl_opts) as ydl:
            result = ydl.extract_info(f"{base_url}/videos", download=False)
            if result:
                count = int(result.get("playlist_count") or len(result.get("entries") or []))
                if count > 0:
                    return Success(count)
    except Exception as e:
        log.error("yt-dlp count error: %s", e)
    return Failure("Could not determine video count")


def _video_at_position(
    base_url: str, position: int, total: int
) -> Result[Dict[str, Any], str]:
    midpoint = total // 2
    fetch_position = (
        -(total - position + 1) if position > midpoint else position
    )
    log.info("position %s/%s → yt-dlp index %s", position, total, fetch_position)
    ydl_opts = {
        "quiet": True, "extract_flat": True,
        "playlist_items": str(fetch_position),
        "ignoreerrors": True, "no_warnings": True,
    }
    entry = None
    try:
        with YoutubeDL(ydl_opts) as ydl:
            result = ydl.extract_info(f"{base_url}/videos", download=False)
            if result and result.get("entries"):
                entry = result["entries"][0]
    except Exception as e:
        log.error("Video fetch error at position %s: %s", position, e)
    if not entry or not entry.get("id"):
        return Failure(f"No video entry found at position {position}")

    video_id = entry["id"]
    if not entry.get("thumbnail") or not entry.get("upload_date") or not entry.get("title"):
        try:
            with YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
                full = ydl.extract_info(
                    f"https://www.youtube.com/watch?v={video_id}", download=False
                )
                if full:
                    entry.update(full)
        except Exception:
            pass

    return Success({
        "id": video_id,
        "title": entry.get("title") or "",
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "thumbnail": entry.get("thumbnail"),
        "published": entry.get("upload_date"),
    })


def _pick_random(channel_url: str) -> Result[FetchPayload, str]:
    base_url = _normalize_channel_url(channel_url)
    count_result = _video_count(base_url)
    if isinstance(count_result, Failure):
        return count_result
    total = count_result.unwrap()
    position = random.randint(1, total)
    log.info("random position: %s / %s", position, total)
    video_result = _video_at_position(base_url, position, total)
    if isinstance(video_result, Failure):
        return video_result
    return Success(({1: video_result.unwrap()},))


async def yt_random(channel_url: str) -> Result[FetchPayload, str]:
    return await asyncio.to_thread(_pick_random, channel_url)


if __name__ == "__main__":
    import sys

    result = asyncio.run(yt_random("https://www.youtube.com/@MrBeast"))
    if isinstance(result, Failure):
        print(f"Failed: {result.failure()}", file=sys.stderr)
        sys.exit(1)
    video = result.unwrap()[0][1]
    print(f"Random pick: {video['title']}  →  {video['url']}")
