from typing import Dict, Tuple
import asyncio
import httpx
from returns.result import Result, Success, Failure

from Utility.yt_parser import parse_youtube_feed
from Utility.yt_HttpClient import get_http_client
from Utility.logs import log


async def yt_rss(
    rss_id: str,
) -> Result[Tuple[Dict[int, Dict[str, str]]], str]:
    """
    Fetches a YouTube channel RSS feed over HTTP/2 and parses it.

    Returns:
        Success( (videos_dict,) ) – 1-element tuple containing a dict of dicts
            {
                1: {"id": ..., "title": ..., "url": ..., "thumbnail": ..., "published": ...},
                2: {...},
                ...
            }
            sorted latest → oldest

        Failure(error_message) on any failure / empty feed.
    """
    feed_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={rss_id}"

    try:
        async with get_http_client() as client:
            response = await client.get(feed_url)
            response.raise_for_status()
            log.info(
                "Fetched feed for channel %s (HTTP/%s)",
                rss_id,
                response.http_version,
            )
            xml_content = response.text
    except httpx.HTTPStatusError as err:
        log.error("HTTP error fetching feed %s: %s", rss_id, err)
        return Failure("HTTP Error")
    except httpx.RequestError as err:
        log.error("Network error fetching feed %s: %s", rss_id, err)
        return Failure("HTTP Error")

    try:
        videos = parse_youtube_feed(xml_content)
        if not videos:
            msg = f"No valid videos parsed for channel {rss_id}"
            log.info(msg)
            return Failure(msg)

        videos.sort(key=lambda x: x.published, reverse=True)

        videos_dict: Dict[int, Dict[str, str]] = {
            i + 1: {
                "id": v.id,
                "title": v.title,
                "url": v.url,
                "thumbnail": v.thumbnail or "",
                "published": v.published,
            }
            for i, v in enumerate(videos)
        }

        return Success((videos_dict,))
    except Exception as e:
        msg = f"Error parsing XML for channel {rss_id}: {e}"
        log.error(msg)
        return Failure("Parsing Error")

# ========================== Entry Point ==========================
if __name__ == "__main__":
    MRBEAST_CHANNEL_ID = "UCX6OQ3DkcsbYNE6H8uQQuVA"

    result = asyncio.run(yt_rss(MRBEAST_CHANNEL_ID))

    if isinstance(result, Failure):
        print(f"Failed to fetch or parse the feed: {result.failure()}")
    else:
        videos_dict = result.unwrap()[0]
        print(f"Found {len(videos_dict)} videos (latest → oldest):\n")
        for num, video in videos_dict.items():
            print(f"{num}. {video['title']}")
            print(f" ID : {video['id']}")
            print(f" URL : {video['url']}")
            print(f" Thumbnail : {video['thumbnail']}")
            print(f" Published : {video['published']}")
            print()
