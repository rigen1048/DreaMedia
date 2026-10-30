import json
import random
import re
import sys
from typing import Any, Dict, Tuple
import httpx
from returns.result import Result, Success, Failure
from yt_dlp import YoutubeDL
from Utility.yt_HttpClient import get_production_client
from Utility.logs import log
# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def normalize_channel_url(url: str) -> str:
    """
    Strips trailing slashes and any existing sub-tabs (/videos, /shorts, /oldest)
    so we always have a clean base channel URL to work with.
    """
    url = url.rstrip("/")
    url = re.sub(r'/(videos|shorts|streams|oldest|popular)$', '', url)
    return url
def get_nested_value(data: Dict[str, Any], path: list) -> Any:
    current = data
    for key in path:
        if isinstance(current, dict) and key in current:
            current = current[key]
        else:
            return None
    return current
def extract_video_count_from_html(html: str) -> Result[int, str]:
    """
    Extract video count using fast string-slicing instead of heavy regex.
    Assumes English locale header configuration.
    """
    log.info(f"HTML length: {len(html):,} characters")
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
    json_str = html[start_idx : end_idx + 1]
    try:
        data = json.loads(json_str)
        log.info("✅ JSON parsed successfully")
    except Exception as e:
        return Failure(f"JSON parse failed: {e}")
    metadata_rows = get_nested_value(
        data,
        [
            "header",
            "pageHeaderRenderer",
            "content",
            "pageHeaderViewModel",
            "metadata",
            "contentMetadataViewModel",
            "metadataRows",
        ],
    )
    if not isinstance(metadata_rows, list):
        return Failure("No metadataRows found")
    for row in metadata_rows:
        parts = row.get("metadataParts")
        if not isinstance(parts, list):
            continue
        for part in parts:
            text_content = get_nested_value(part, ["text", "content"])
            if text_content and "videos" in str(text_content).lower():
                count_str = "".join(filter(str.isdigit, str(text_content)))
                count = int(count_str) if count_str else 0
                if count > 0:
                    log.info(f"✅ Video count found: {count}")
                    return Success(count)
    return Failure("No video count found in metadata")
def _get_http_client() -> httpx.Client:
    """Create the production HTTP/2 client (or a plain fallback)."""
    if get_production_client is not None:
        try:
            return get_production_client(apply_youtube_consent=True)
        except Exception as e:
            log.error(f"Failed to create production client: {e}")
    log.warning("Using plain httpx client (no custom headers/consent)")
    return httpx.Client(http2=True, timeout=20.0)
# ---------------------------------------------------------------------------
# 1. Find the total number of videos
# ---------------------------------------------------------------------------
def get_channel_video_count(base_channel_url: str) -> Result[int, str]:
    """
    Return the total number of videos on a channel.
    """
    client = _get_http_client()
    total_videos = 0
    log.info("--- Attempt 1: HTML scraping ---")
    try:
        response = client.get(base_channel_url, timeout=20.0)
        log.info(f"HTML Status: {response.status_code}")
        if response.status_code == 200:
            html_result = extract_video_count_from_html(response.text)
            if isinstance(html_result, Success):
                total_videos = html_result.unwrap()
    except Exception as e:
        log.error(f"HTML request failed: {e}")
    finally:
        client.close()
    if total_videos <= 0:
        log.info("--- Attempt 2: yt-dlp count ---")
        ydl_opts = {
            "quiet": True,
            "extract_flat": "in_playlist",
            "playlist_items": "0",
            "no_warnings": True,
        }
        try:
            with YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(f"{base_channel_url}/videos", download=False)
                if result:
                    total_videos = int(
                        result.get("playlist_count")
                        or len(result.get("entries") or [])
                    )
                    log.info(f"yt-dlp found: {total_videos} videos")
        except Exception as e:
            log.error(f"yt-dlp count error: {e}")
    if total_videos <= 0:
        return Failure("Could not determine video count")
    log.info(f"📊 Total Videos: {total_videos}")
    return Success(total_videos)
# ---------------------------------------------------------------------------
# 2. Search / fetch a specific video by position (Mathematical Back-Count)
# ---------------------------------------------------------------------------
def get_video_at_position(
    base_channel_url: str, position: int, total_videos: int
) -> Result[Dict[str, Any], str]:
    """
    Fetch the video at `position` (1-based) using mathematical optimization.
    Uses yt-dlp's native negative indexing if the position is in the second half.
    """
    videos_url = f"{base_channel_url}/videos"
    midpoint = total_videos // 2
    if position > midpoint:
        # Mathematical optimization: count backward from the end using negative index
        # e.g., position 1998 out of 2000 becomes -3
        fetch_position = -(total_videos - position + 1)
        log.info(
            f"⚡ Optimized Back-Count: Target position {position}/{total_videos} "
            f"is in the second half. Using yt-dlp negative index: {fetch_position}"
        )
    else:
        fetch_position = position
        log.info(
            f"⚡ Standard Forward Route: Target position {fetch_position}/{total_videos}"
        )
    ydl_opts = {
        "quiet": True,
        "extract_flat": True,
        "playlist_items": str(fetch_position),
        "ignoreerrors": True,
        "no_warnings": True,
    }
    entry = None
    try:
        with YoutubeDL(ydl_opts) as ydl:
            result = ydl.extract_info(videos_url, download=False)
            if result and result.get("entries"):
                entry = result["entries"][0]
    except Exception as e:
        log.error(f"Video fetch error at position {position} (fetch_idx={fetch_position}): {e}")
    if not entry or not entry.get("id"):
        return Failure(f"No video entry found at position {position} (index: {fetch_position})")
    video_id = entry["id"]
    video_url = f"https://www.youtube.com/watch?v={video_id}"
    # Enrich missing metadata
    if not entry.get("thumbnail") or not entry.get("upload_date") or not entry.get("title"):
        try:
            with YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
                full = ydl.extract_info(video_url, download=False)
                if full:
                    entry.update(full)
        except Exception:
            pass
    return Success({
        "id": video_id,
        "title": entry.get("title") or "",
        "url": video_url,
        "thumbnail": entry.get("thumbnail"),
        "published": entry.get("upload_date"),
    })
# ---------------------------------------------------------------------------
# 3. Pick a random position
# ---------------------------------------------------------------------------
def pick_random_position(total_videos: int) -> int:
    """Pick a random 1-based position and log it."""
    random_n = random.randint(1, total_videos)
    log.info(f"🎲 Random position: {random_n} / {total_videos}")
    return random_n
# ---------------------------------------------------------------------------
# 4. Orchestrator – pick a random video from the channel
# ---------------------------------------------------------------------------
def yt_random(channel_url: str) -> Result[Tuple[Dict[str, Any]], str]:
    """
    Pick a random video from the given channel URL.
    """
    log.info(f"\n{'=' * 80}\nSTARTING FOR CHANNEL: {channel_url}\n{'=' * 80}")
    base_channel_url = normalize_channel_url(channel_url)
    log.info(f"Normalized Target URL: {base_channel_url}")
    count_result = get_channel_video_count(base_channel_url)
    if isinstance(count_result, Failure):
        return count_result
    total_videos = count_result.unwrap()
    random_n = pick_random_position(total_videos)
    video_result = get_video_at_position(base_channel_url, random_n, total_videos)
    if isinstance(video_result, Failure):
        return video_result
    video = video_result.unwrap()
    log.info(f"Selected video_id={video['id']} | position={random_n} | total={total_videos}")
    log.info(f"Title: {video['title']}")
    log.info(f"Thumbnail: {video['thumbnail']}")
    log.info(f"Published at: {video['published']}")
    return Success((video,))
# ---------------------------------------------------------------------------
# Example
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    channel_input = "https://www.youtube.com/@MrBeast"
    result = yt_random(channel_input)
    if isinstance(result, Failure):
        log.error(f"Script failed: {result.failure()}")
        sys.exit(1)
    video = result.unwrap()[0]
    print("\n" + "=" * 60)
    print("✅ SUCCESS")
    print("=" * 60)
    print(f"Video ID  : {video['id']}")
    print(f"Title     : {video['title']}")
    print(f"Video URL : {video['url']}")
    print(f"Thumbnail : {video['thumbnail']}")
    print(f"Published : {video['published']}")
