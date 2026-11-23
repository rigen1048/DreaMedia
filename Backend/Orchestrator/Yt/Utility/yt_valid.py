"""YouTube existence checks — the unhappy-path fault tolerance (D15/D60).

Every check is TRI-STATE:
    True  — confirmed to exist
    False — confirmed GONE (only then may the pipeline alert 'deleted')
    None  — could not tell (rate limit, network flake, unusual status)

Never alert on None: a flaky network must not cry 'deleted'. And per D15,
nothing here ever deletes a subscription — the user does, or reports it.
"""
from __future__ import annotations

from typing import Optional

import httpx

from Utility.http import get_async_client
from Utility.logs import log


async def _exists(url: str, *, consent: bool = True) -> Optional[bool]:
    try:
        async with get_async_client(youtube_consent=consent) as client:
            response = await client.get(url)
    except (httpx.HTTPStatusError, httpx.RequestError) as err:
        log.warning("existence check failed for %s: %s", url, err)
        return None
    if response.status_code == 404:
        return False
    if 200 <= response.status_code < 400:
        return True
    log.warning("existence check ambiguous for %s: HTTP %s", url, response.status_code)
    return None


async def channel_exists(rss_id: str) -> Optional[bool]:
    """Channel page by its RSS/UC id — 404 means the channel is gone."""
    return await _exists(f"https://www.youtube.com/channel/{rss_id}")


async def playlist_exists(playlist_id: str) -> Optional[bool]:
    return await _exists(f"https://www.youtube.com/playlist?list={playlist_id}")


async def video_exists(video_id: str) -> Optional[bool]:
    """oEmbed is the cheap canonical probe: deleted videos answer 404/400."""
    try:
        async with get_async_client() as client:
            response = await client.get(
                "https://www.youtube.com/oembed",
                params={"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"},
            )
    except (httpx.HTTPStatusError, httpx.RequestError) as err:
        log.warning("video existence check failed for %s: %s", video_id, err)
        return None
    if response.status_code in (400, 404):
        return False
    if 200 <= response.status_code < 400:
        return True
    log.warning("video existence check ambiguous for %s: HTTP %s", video_id, response.status_code)
    return None
