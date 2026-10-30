from typing import Any, Dict, Tuple
import sys

import yt_dlp
from returns.result import Result, Success, Failure

from Utility.yt_HttpClient import get_ydl_opts
from Utility.logs import log  # optional but recommended for consistency


def yt_playlist(playlist_id: str) -> Result[Tuple[Dict[int, Dict[str, Any]]], str]:
    """
    Extract videos from a YouTube playlist (HTTP/2 via production client).

    Returns
    -------
    Success( (videos_dict,) )
        A 1-element tuple containing a dict of dicts:
        {
            1: {
                "id": ...,
                "title": ...,
                "url": ...,
                "thumbnail": ...,
                "published": ...
            },
            2: { ... },
            ...
        }
        (newest first)

    Failure(error_message) on any failure or empty playlist.
    """
    playlist_url = f"https://www.youtube.com/playlist?list={playlist_id.strip()}"
    ydl_opts = get_ydl_opts()

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(playlist_url, download=False)
    except Exception as e:
        msg = f"Failed to extract playlist info for {playlist_url}: {e}"
        log.error(msg) if "log" in globals() else print(msg, file=sys.stderr)
        return Failure(msg)

    if not info or "entries" not in info:
        msg = f"Could not extract playlist info for {playlist_url}"
        log.warning(msg) if "log" in globals() else print(f"⚠️ Warning: {msg}", file=sys.stderr)
        return Failure(msg)

    entries = [e for e in info["entries"] if e]
    if not entries:
        return Failure("Playlist contains no valid entries")

    videos_dict: Dict[int, Dict[str, Any]] = {}

    for idx, entry in enumerate(entries, 1):
        video_id = entry.get("id")
        if not video_id:
            continue

        # Enrichment when key fields are missing
        if (
            not entry.get("thumbnail")
            or not entry.get("upload_date")
            or not entry.get("title")
        ):
            try:
                full_opts = {**ydl_opts, "extract_flat": False}
                with yt_dlp.YoutubeDL(full_opts) as ydl_full:
                    full_info = ydl_full.extract_info(
                        f"https://www.youtube.com/watch?v={video_id}",
                        download=False,
                    )
                    if full_info:
                        entry.update(full_info)
            except Exception:
                pass

        title = entry.get("title") or "Untitled Video"
        video_url = f"https://www.youtube.com/watch?v={video_id}"

        thumbnail = (
            entry.get("thumbnail")
            or (entry.get("thumbnails") or [{}])[0].get("url")
            or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
        )

        upload_date = entry.get("upload_date")
        if upload_date and len(str(upload_date)) == 8:
            published_at = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"
        else:
            published_at = upload_date

        videos_dict[idx] = {
            "id": video_id,
            "title": title,
            "url": video_url,
            "thumbnail": thumbnail,
            "published": published_at,
        }

    if not videos_dict:
        return Failure("No valid videos could be extracted from the playlist")

    return Success((videos_dict,))


# ==========================
# Example Usage
# ==========================
if __name__ == "__main__":
    playlist_id = "PL0vfts4VzfNjsTV_6i9a9iczMnthWqHzM"
    result = yt_playlist(playlist_id)

    if isinstance(result, Failure):
        print(f"No videos found: {result.failure()}", file=sys.stderr)
        sys.exit(1)

    videos_dict = result.unwrap()[0]
    print(f"Found {len(videos_dict)} videos (newest first):\n")
    for num, video in videos_dict.items():
        print(f"{num}. {video['title']}")
        print(f" ID        : {video['id']}")
        print(f" URL       : {video['url']}")
        print(f" Thumbnail : {video['thumbnail']}")
        print(f" Published : {video['published']}")
        print()
