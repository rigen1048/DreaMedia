"""Async playlist fetcher — yt-dlp is blocking, so it runs in a thread.

The 100%-async contract (owner pitch) is preserved at the call site:
`await yt_playlist(...)` never blocks the event loop.
"""
from __future__ import annotations

import asyncio

import yt_dlp
from returns.result import Failure, Result, Success

from Model.video import FetchPayload, VideosDict
from Utility.http import get_ydl_opts
from Utility.logs import log


def _extract(playlist_id: str) -> Result[FetchPayload, str]:
    playlist_url = f"https://www.youtube.com/playlist?list={playlist_id.strip()}"
    ydl_opts = get_ydl_opts()

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(playlist_url, download=False)
    except Exception as e:
        log.error("Failed to extract playlist %s: %s", playlist_url, e)
        return Failure("Extraction Error")

    if not info or "entries" not in info:
        return Failure("Could not extract playlist info")

    entries = [e for e in info["entries"] if e]
    if not entries:
        return Failure("Playlist contains no valid entries")

    videos_dict: VideosDict = {}
    for idx, entry in enumerate(entries, 1):
        video_id = entry.get("id")
        if not video_id:
            continue

        upload_date = entry.get("upload_date")
        published = (
            f"{str(upload_date)[:4]}-{str(upload_date)[4:6]}-{str(upload_date)[6:]}"
            if upload_date and len(str(upload_date)) == 8
            else upload_date
        )

        videos_dict[idx] = {
            "id": video_id,
            "title": entry.get("title") or "Untitled Video",
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "thumbnail": entry.get("thumbnail")
            or (entry.get("thumbnails") or [{}])[0].get("url")
            or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
            "published": published,
        }

    if not videos_dict:
        return Failure("No valid videos could be extracted from the playlist")
    return Success((videos_dict,))


async def yt_playlist(playlist_id: str) -> Result[FetchPayload, str]:
    return await asyncio.to_thread(_extract, playlist_id)


if __name__ == "__main__":
    import sys

    result = asyncio.run(yt_playlist("PL0vfts4VzfNjsTV_6i9a9iczMnthWqHzM"))
    if isinstance(result, Failure):
        print(f"Failed: {result.failure()}", file=sys.stderr)
        sys.exit(1)
    for num, video in result.unwrap()[0].items():
        print(f"{num}. {video['title']}  ({video['published']})")
