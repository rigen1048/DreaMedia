import io
from typing import List, Optional
import pandas as pd
from Model.fetch import Video

NAMESPACES = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}


def parse_youtube_feed(xml_content: str) -> List[Video]:
    """
    Parse a YouTube channel RSS XML string into a list of Video objects.

    Returns an empty list if the feed is empty or no valid entries can be parsed.
    """
    try:
        # Read all entries in one go
        df = pd.read_xml(
            io.StringIO(xml_content),
            xpath=".//atom:entry",
            namespaces=NAMESPACES,
        )
    except Exception:
        return []

    if df.empty:
        return []

    videos: List[Video] = []

    for _, row in df.iterrows():
        # Prefer yt:videoId, fall back to parsing the atom:id
        vid = str(row.get("videoId") or "").strip()
        if not vid:
            entry_id = str(row.get("id") or "")
            vid = entry_id.split(":")[-1] if ":" in entry_id else entry_id

        if not vid:
            continue

        title = str(row.get("title") or "No title").strip()
        published = str(row.get("published") or "").strip()

        # Link (atom:link[@rel='alternate'])
        # pandas.read_xml puts attributes in columns when present
        url: Optional[str] = None
        if "href" in row and pd.notna(row["href"]):
            url = str(row["href"])
        if not url:
            url = f"https://www.youtube.com/watch?v={vid}"

        # Thumbnail (media:thumbnail/@url)
        thumbnail: Optional[str] = None
        if "url" in row and pd.notna(row["url"]):
            # When media:thumbnail is present, its @url usually lands in the "url" column
            thumbnail = str(row["url"])

        videos.append(
            Video(
                id=vid,
                title=title,
                url=url,
                published=published,
                thumbnail=thumbnail,
            )
        )

    return videos
