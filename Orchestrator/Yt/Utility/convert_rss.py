from __future__ import annotations

from typing import Any, Mapping, Optional

import yt_dlp
from pydantic import BaseModel, ConfigDict, HttpUrl
from yt_dlp.utils import DownloadError, ExtractorError


class ChannelInfo(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    channel_id: str
    rss: HttpUrl
    logo: Optional[HttpUrl] = None
    url: HttpUrl


class ChannelExtractionError(Exception):
    """Raised when channel metadata cannot be extracted."""


def _normalize(url: str) -> str:
    url = url.strip()
    if url.startswith(("http://", "https://")):
        return url
    return f"https://www.youtube.com/@{url.lstrip('@')}"


def _best_logo(info: Mapping[str, Any]) -> Optional[str]:
    thumbnails = info.get("thumbnails") or []
    if thumbnails:
        best = max(
            thumbnails,
            key=lambda t: (t.get("width") or 0) * (t.get("height") or 0),
            default=None,
        )
        if best and best.get("url"):
            return best["url"]
    return info.get("thumbnail") or info.get("channel_thumbnail")


def get_channel_info(
    url: str,
    *,
    ydl_opts: Optional[Mapping[str, Any]] = None,
) -> ChannelInfo:
    """
    Resolve a YouTube channel URL or handle into structured metadata.

    Raises
    ------
    ChannelExtractionError
        On missing critical fields or unexpected response.
    DownloadError / ExtractorError
        Propagated from yt-dlp.
    """
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "playlistend": 1,
        "skip_download": True,
        **(ydl_opts or {}),
    }

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(_normalize(url), download=False)
    except (DownloadError, ExtractorError):
        raise
    except Exception as exc:
        raise ChannelExtractionError(f"extraction failed: {exc}") from exc

    if not isinstance(info, dict):
        raise ChannelExtractionError("unexpected response type from yt-dlp")

    channel_id = info.get("channel_id") or info.get("uploader_id")
    if not channel_id:
        raise ChannelExtractionError("channel_id not found")

    return ChannelInfo(
        name=(
            info.get("channel")
            or info.get("uploader")
            or info.get("playlist_title")
            or info.get("title")
            or "Unknown"
        ),
        channel_id=channel_id,
        rss=f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}",
        logo=_best_logo(info),
        url=info.get("channel_url") or info.get("uploader_url") or _normalize(url),
    )
