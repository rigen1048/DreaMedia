from typing import Dict, Optional
from datetime import datetime, timezone
import httpx
import asyncio

# ====================== CONVENIENCE FUNCTIONS ======================

async def get_season_title(seasons_dict: Dict[int, Dict], season: int) -> str:
    """Quick way to get full name for a specific season (Async)"""
    return seasons_dict.get(season, {}).get("title", "Not found")


async def get_next_airing(seasons_dict: Dict[int, Dict], season: int) -> Optional[Dict]:
    """Return nextAiringEpisode dict for a season (Async)"""
    return seasons_dict.get(season, {}).get("next_airing")


async def format_anilist_duration(duration_data: int) -> str:
    """Format Anilist duration like '1 hour, 40 mins' (Async)"""
    if duration_data < 60:
        return f"{duration_data} mins"
    hours = duration_data // 60
    minutes = duration_data % 60
    if minutes > 0:
        return f"{hours} hour{'s' if hours > 1 else ''}, {minutes} mins"
    else:
        return f"{hours} hour{'s' if hours > 1 else ''}"

# ====================== FORMAT FUNCTIONS ===========================

async def format_date(date_dict: Optional[Dict]) -> str:
    """Helper to pretty-print date (Async)"""
    if not date_dict or not date_dict.get("year"):
        return "N/A"
    y = date_dict["year"]
    m = date_dict.get("month")
    d = date_dict.get("day")
    if m and d:
        return f"{y}-{m:02d}-{d:02d}"
    elif m:
        return f"{y}-{m:02d}"
    return str(y)


async def format_airing_time(airing_at: Optional[int], time_until: Optional[int]) -> str:
    """Format next airing time in a human-readable way (Async)"""
    if airing_at:
        dt = datetime.fromtimestamp(airing_at, tz=timezone.utc)
        local = dt.astimezone()
        return local.strftime("%Y-%m-%d %H:%M %Z")
    if time_until is not None:
        days, rem = divmod(time_until, 86400)
        hours, rem = divmod(rem, 3600)
        minutes = rem // 60
        parts = []
        if days:
            parts.append(f"{days}d")
        if hours:
            parts.append(f"{hours}h")
        if minutes or not parts:
            parts.append(f"{minutes}m")
        return "in " + " ".join(parts)
    return "N/A"

# ===================================================================


async def get_season_dict(base_title: str) -> Dict[int, Dict]:
    url = "https://graphql.anilist.co"

    async with httpx.AsyncClient(timeout=30.0) as client:
        search_resp = await client.post(
            url,
            json={
                "query": """
                query ($search: String) {
                  Page(page: 1, perPage: 5) {
                    media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
                      id title { userPreferred romaji english } siteUrl
                    }
                  }
                }
                """,
                "variables": {"search": base_title},
            },
        )
        search_resp.raise_for_status()
        results = search_resp.json().get("data", {}).get("Page", {}).get("media", [])

        if not results:
            print("❌ Anime not found")
            return {}

        start_id = results[0]["id"]
        print(
            f"Base: {results[0]['title'].get('userPreferred') or results[0]['title'].get('romaji')}"
        )

        current_id = start_id
        visited = set()
        while current_id not in visited:
            visited.add(current_id)
            media = await fetch_media(current_id, client)
            if not media:
                break
            prequel = next(
                (
                    e["node"]
                    for e in media.get("relations", {}).get("edges", [])
                    if e.get("relationType") in ["PREQUEL", "PREQUEL_TO"]
                ),
                None,
            )
            if not prequel:
                break
            current_id = prequel["id"]

        seasons: Dict[int, Dict] = {}
        season_num = 1

        while True:
            media = await fetch_media(current_id, client)
            if not media:
                break

            title = media["title"].get("userPreferred") or media["title"].get("romaji")
            start_date = media.get("startDate")
            end_date = media.get("endDate")
            entry_type = media.get("format")
            status = media.get("status")
            next_airing = media.get("nextAiringEpisode")
            episode_total = media.get("episodes")
            total_episodes_str = "N/A"

            if episode_total is not None:
                if status == "FINISHED" and entry_type == "TV":
                    total_episodes_str = str(episode_total)
                else:
                    total_episodes_str = f"~{episode_total}"

            duration_data = media.get("duration")
            if duration_data is not None:
                duration_str = await format_anilist_duration(duration_data)
            else:
                duration_str = "N/A"

            season_data = {
                "season": season_num,
                "title": title,
                "id": current_id,
                "siteUrl": media.get("siteUrl"),
                "start_date": start_date,
                "end_date": end_date,
                "type": entry_type,
                "status": status,
                "episodes": episode_total,
                "total_episodes": total_episodes_str,
                "next_airing": next_airing,
                "raw": media,
                "duration": duration_str,
            }
            seasons[season_num] = season_data

            airing_info = ""
            if status != "FINISHED" and next_airing:
                ep = next_airing.get("episode")
                airing_at = next_airing.get("airingAt")
                time_until = next_airing.get("timeUntilAiring")
                # === AWAITING FORMAT AIRING TIME ===
                airing_str = await format_airing_time(airing_at, time_until)
                airing_info = f" | Next: Ep {ep} → {airing_str}"
            elif status != "FINISHED":
                airing_info = " | Next episode: N/A"

            # === AWAITING FORMAT DATE ===
            start_str = await format_date(start_date)
            end_str = await format_date(end_date)

            print(
                f"S{season_num:02d} → {title} ({entry_type}) [{status}] "
                f"| Start: {start_str} | End: {end_str} "
                f"| Episodes: {total_episodes_str} | Duration: {duration_str}{airing_info}"
            )

            sequel = next(
                (
                    e["node"]
                    for e in media.get("relations", {}).get("edges", [])
                    if e.get("relationType") in ["SEQUEL", "SEQUEL_TO"]
                ),
                None,
            )
            if not sequel:
                print(f"✅ Chain ended at Season {season_num}")
                break

            current_id = sequel["id"]
            season_num += 1

        print(f"\n🎉 Created season dictionary with {len(seasons)} entries!")
        return seasons


async def fetch_media(media_id: int, client: httpx.AsyncClient) -> Optional[Dict]:
    query = """
    query ($id: Int!) {
      Media(id: $id, type: ANIME) {
        id
        title { userPreferred romaji english }
        siteUrl
        season
        seasonYear
        startDate { year month day }
        endDate { year month day }
        episodes
        format
        status
        duration
        nextAiringEpisode {
          airingAt
          timeUntilAiring
          episode
        }
        relations {
          edges {
            relationType
            node { id title { userPreferred romaji } siteUrl }
          }
        }
      }
    }
    """
    try:
        resp = await client.post(
            "https://graphql.anilist.co",
            json={"query": query, "variables": {"id": media_id}},
        )
        resp.raise_for_status()
        return resp.json().get("data", {}).get("Media")
    except Exception as e:
        print(f"⚠️ Error fetching media {media_id}: {e}")
        return None


async def main():
    title = "Naruto"
    seasons = await get_season_dict(title)

    if seasons:
        print("\n" + "=" * 100)
        for s in sorted(seasons.keys()):
            data = seasons[s]

            # === AWAITING FORMAT DATE ===
            start_str = await format_date(data['start_date'])
            end_str = await format_date(data['end_date'])

            line = (
                f"seasons[{s}] = {data['title']} | {data['type']} | {data['status']} | "
                f"Start: {start_str} | End: {end_str}"
                f" | Episodes: {data.get('total_episodes', 'N/A')}"
                f" | Duration: {data.get('duration', 'N/A')}"
            )
            if data["status"] != "FINISHED" and data.get("next_airing"):
                na = data["next_airing"]

                # === AWAITING FORMAT AIRING TIME ===
                airing_str = await format_airing_time(na.get("airingAt"), na.get("timeUntilAiring"))
                line += f" | Next Ep {na.get('episode')}: {airing_str}"

            print(line)

        season_2_title = await get_season_title(seasons, 2)
        print(f"\nSeason 2 full name: {season_2_title}")


if __name__ == "__main__":
    asyncio.run(main())
