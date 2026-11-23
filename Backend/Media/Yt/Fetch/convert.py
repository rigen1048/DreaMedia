"""Channel/playlist URL resolution (frontend AI P1).

The management page takes a pasted link and nothing else — we resolve
channel handle URLs to (rss_id, name, canonical url) via yt-dlp, and
extract playlist IDs from playlist URLs. Accepted channel formats:
  youtube.com/@HANDLE[/featured|/videos|/shorts|...]
  youtube.com/channel/UC...
  bare UC... id
yt-dlp is blocking; callers use the dedicated Utility.media_executor.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Optional

import yt_dlp
from returns.result import Failure, Result, Success

from Utility.http import get_ydl_opts
from Utility.logs import log

_UC_RE = re.compile(r"^UC[0-9A-Za-z_-]{22}$")
_CHANNEL_PATH_RE = re.compile(r"youtube\.com/channel/(UC[0-9A-Za-z_-]{22})")
_PLAYLIST_RE = re.compile(r"[?&]list=([A-Za-z0-9_-]+)")


@dataclass(frozen=True)
class ChannelInfo:
    rss_id: str
    name: str
    url: str
    logo: Optional[str]


def parse_playlist_id(link: str) -> Optional[str]:
    """Playlist id from any YouTube playlist URL (or bare id)."""
    link = link.strip()
    match = _PLAYLIST_RE.search(link)
    if match:
        return match.group(1)
    return link if re.fullmatch(r"[A-Za-z0-9_-]{10,}", link) else None


def resolve_channel(link: str) -> Result[ChannelInfo, str]:
    """Resolve any accepted channel link/handle/id to canonical metadata."""
    link = link.strip()

    if _UC_RE.match(link):
        rss_id = link
        url = f"https://www.youtube.com/channel/{rss_id}"
    elif match := _CHANNEL_PATH_RE.search(link):
        rss_id = match.group(1)
        url = f"https://www.youtube.com/channel/{rss_id}"
    else:
        # Handle forms: @HANDLE[/anything] or a bare handle
        handle = link
        if "youtube.com" in handle:
            match = re.search(r"youtube\.com/(@[A-Za-z0-9_.-]+)", handle)
            if not match:
                return Failure(f"unrecognized channel link: {link}")
            handle = match.group(1)
        if not handle.startswith("@"):
            handle = "@" + handle.lstrip("@")
        url = f"https://www.youtube.com/{handle}"
        rss_id = ""

    try:
        with yt_dlp.YoutubeDL(get_ydl_opts()) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        log.error("channel resolve failed for %s: %s", url, e)
        return Failure("channel resolve failed")

    if not isinstance(info, dict):
        return Failure("unexpected resolve response")

    channel_id = rss_id or info.get("channel_id") or info.get("uploader_id")
    if not channel_id:
        return Failure("channel_id not found")

    name = (
        info.get("channel") or info.get("uploader") or info.get("title") or "Unknown"
    )
    logo = None
    for thumb in info.get("thumbnails") or []:
        if thumb.get("url"):
            logo = thumb["url"]  # last = usually largest in yt-dlp ordering

    return Success(
        ChannelInfo(
            rss_id=channel_id,
            name=name,
            url=info.get("channel_url") or info.get("uploader_url") or url,
            logo=logo,
        )
    )


_VIDEO_ID_RE = re.compile(
    r"(?:youtube\.com/watch\?[^#]*v=|youtu\.be/|youtube\.com/shorts/)([A-Za-z0-9_-]{11})"
)


@dataclass(frozen=True)
class VideoInfo:
    video_id: str
    title: str
    url: str
    thumbnail: Optional[str]


def parse_video_id(link: str) -> Optional[str]:
    match = _VIDEO_ID_RE.search(link.strip())
    return match.group(1) if match else None


def _oembed(video_id: str) -> Optional[Dict[str, Any]]:
    """Cheap metadata fallback when yt-dlp is blocked (bot walls, regions)."""
    try:
        import httpx

        response = httpx.get(
            "https://www.youtube.com/oembed",
            params={"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"},
            timeout=5.0,
            follow_redirects=True,
        )
        if response.status_code == 200 and response.text.strip():
            data = response.json()
            if data.get("title"):
                return data
    except Exception as exc:  # pragma: no cover - network dependent
        log.warning("oembed lookup failed for %s: %s", video_id, exc)
    return None


def resolve_video(link: str) -> Result[VideoInfo, str]:
    """Resolve a YouTube video link → id/title/thumbnail (for manual cards, D47).

    Manual playlists must never lose a link to a scraper failure: the id is
    enough to store the row, so oEmbed → yt-dlp → id-only stub is the chain.
    """
    video_id = parse_video_id(link)
    if not video_id:
        return Failure("could not extract a video id from that link")
    url = f"https://www.youtube.com/watch?v={video_id}"
    meta = _oembed(video_id)
    if meta:
        return Success(
            VideoInfo(
                video_id=video_id,
                title=meta.get("title") or "Untitled",
                url=url,
                thumbnail=meta.get("thumbnail_url")
                or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
            )
        )

    try:
        with yt_dlp.YoutubeDL(get_ydl_opts()) as ydl:
            info = ydl.extract_info(url, download=False)
        if isinstance(info, dict) and info.get("id"):
            return Success(
                VideoInfo(
                    video_id=info["id"],
                    title=info.get("title") or "Untitled",
                    url=url,
                    thumbnail=info.get("thumbnail")
                    or f"https://i.ytimg.com/vi/{info['id']}/hqdefault.jpg",
                )
            )
    except Exception as e:
        log.warning("yt-dlp video resolve failed for %s: %s", url, e)

    log.warning("storing %s without metadata (YouTube unreachable)", video_id)
    return Success(
        VideoInfo(
            video_id=video_id,
            title=f"YouTube video {video_id}",
            url=url,
            thumbnail=f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        )
    )
