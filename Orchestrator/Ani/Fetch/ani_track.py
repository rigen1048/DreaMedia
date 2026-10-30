"""AniList season-chain fetcher — async, HTTP/2, Result-shaped.

Walks PREQUEL relations to the first season, then SEQUEL relations
forward, emitting one payload entry per season in the shared fetcher
contract ({n: {id, title, url, thumbnail, published, ...}}). Extra
fields (status, episodes, next_airing) ride along — the Ani pipeline
uses next_airing.airingAt for scheduling instead of median-gap
prediction (AniList tells us the future; YouTube doesn't).

Rewrite of the owner's ani_track.py prototype: same GraphQL queries and
chain logic, but Result-typed, no prints, no N+1 formatting helpers.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from returns.result import Failure, Result, Success

from Model.video import FetchPayload, VideosDict
from Utility.http import get_async_client
from Utility.logs import log

ANILIST_URL = "https://graphql.anilist.co"

_SEARCH_QUERY = """
query ($search: String) {
  Page(page: 1, perPage: 5) {
    media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
      id title { userPreferred romaji english } siteUrl
    }
  }
}
"""

_MEDIA_QUERY = """
query ($id: Int!) {
  Media(id: $id, type: ANIME) {
    id
    title { userPreferred romaji english }
    siteUrl
    format
    status
    episodes
    duration
    startDate { year month day }
    coverImage { large }
    nextAiringEpisode { airingAt timeUntilAiring episode }
    relations {
      edges { relationType node { id title { userPreferred romaji } } }
    }
  }
}
"""


def _iso(date_dict: Optional[Dict]) -> str:
    if not date_dict or not date_dict.get("year"):
        return ""
    y = date_dict["year"]
    m = date_dict.get("month") or 1
    d = date_dict.get("day") or 1
    return f"{y}-{m:02d}-{d:02d}"


async def _graphql(client, query: str, variables: Dict) -> Optional[Dict]:
    import asyncio as _asyncio

    for attempt in range(3):
        try:
            resp = await client.post(ANILIST_URL, json={"query": query, "variables": variables})
            if resp.status_code == 429:
                wait = float(resp.headers.get("Retry-After", 2 * (attempt + 1)))
                log.warning("AniList rate-limited; retrying in %ss", wait)
                await _asyncio.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json().get("data")
        except Exception as e:
            log.error("AniList request failed (attempt %s): %s", attempt + 1, e)
            await _asyncio.sleep(1.5 * (attempt + 1))
    return None


def _relation(media: Dict, kinds: tuple[str, ...]) -> Optional[int]:
    for edge in media.get("relations", {}).get("edges", []):
        if edge.get("relationType") in kinds:
            return edge["node"]["id"]
    return None


async def ani_fetch(base_title: str) -> Result[FetchPayload, str]:
    """Fetch the full season chain for an anime title."""
    async with get_async_client() as client:
        data = await _graphql(client, _SEARCH_QUERY, {"search": base_title})
        results = (data or {}).get("Page", {}).get("media", [])
        if not results:
            return Failure(f"Anime not found: {base_title}")

        start_id = results[0]["id"]
        log.info("AniList match: %s", results[0]["title"].get("userPreferred"))

        # Walk to the earliest prequel.
        current_id = start_id
        visited: set[int] = set()
        while current_id not in visited:
            visited.add(current_id)
            media = (await _graphql(client, _MEDIA_QUERY, {"id": current_id}) or {}).get("Media")
            if not media:
                break
            prequel = _relation(media, ("PREQUEL", "PREQUEL_TO"))
            if not prequel:
                break
            current_id = prequel

        # Walk sequels forward, collecting seasons.
        seasons: List[Dict[str, Any]] = []
        visited.clear()
        while current_id and current_id not in visited:
            visited.add(current_id)
            media = (await _graphql(client, _MEDIA_QUERY, {"id": current_id}) or {}).get("Media")
            if not media:
                break
            seasons.append(media)
            current_id = _relation(media, ("SEQUEL", "SEQUEL_TO"))

    if not seasons:
        return Failure("No seasons resolved")

    videos_dict: VideosDict = {}
    for idx, media in enumerate(seasons, 1):
        title = media["title"].get("userPreferred") or media["title"].get("romaji") or "Unknown"
        videos_dict[idx] = {
            "id": str(media["id"]),
            "title": title,
            "url": media.get("siteUrl") or "",
            "thumbnail": (media.get("coverImage") or {}).get("large") or "",
            "published": _iso(media.get("startDate")),
            # Ani-specific scheduling fields:
            "status": media.get("status"),
            "format": media.get("format"),   # TV | MOVIE | ... (next_sequel event distinguishes)
            "episodes": media.get("episodes"),
            "next_airing": media.get("nextAiringEpisode"),
        }

    log.info("season chain resolved: %s season(s) for %s", len(videos_dict), base_title)
    return Success((videos_dict,))
