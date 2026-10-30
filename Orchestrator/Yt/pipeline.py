from returns.result import Result, Success, Failure
import asyncio
from typing import List, Optional

import time

from Automation.Filter.time import ts_proccess
from Automation.Filter.scan import filter_words
from Automation.Filter.last_seen import filter_new_videos
from Fetch.yt_rss import yt_rss
from Fetch.yt_playlist import yt_playlist
from Fetch.yt_random import yt_random
from Utility.check_internet import wait_for_internet
from Utility.notificaion import send_notification
from Utility.yt_valid import video_exists, channel_exists, playlist_exists
from Sql.save import save_counter, save_result, save_ts

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
report = "Issue Spotted, Please report to the dev"
deleted = "got deleted"

T = "Tracking"
W = "WordScan"
P = "Playlist"
R = "Random"



def orchestration(
    kind: str,
    channel_id: int,
    link: str,
    last_seen: Optional[str] = None,
    words: Optional[List[str]] = None,
) -> Result:
    """
    Main orchestration entry point.
    Returns a Result (Success or Failure) so callers can react uniformly.
    """
    increment,ts,rank = 0,0,""

    wait_for_internet()

    # ------------------------------------------------------------------
    # 1. Fetch
    # ------------------------------------------------------------------
    if kind in (T, W):
        result = asyncio.run(yt_rss(link))
    elif kind == P:
        result = yt_playlist(link)
    elif kind == R:
        result = yt_random(link)
    else:
        return Failure("Unknown kind")

    # ------------------------------------------------------------------
    # 2. Handle fetch-level failures
    # ------------------------------------------------------------------
    if isinstance(result, Failure):
        if not channel_exists(link):
            send_notification(f"Channel {deleted}")
            return Failure("Deleted:Channel")

        if kind in (T, W):
            # Retry only on HTTP-related issues
            if result.failure() == "HTTP Error":
                for _ in range(3):
                    time.sleep(5)
                    result = asyncio.run(yt_rss(link))
                    if isinstance(result, Success) or result.failure() != "HTTP Error":
                        break

            # Common failure path (after retries or for non-HTTP errors)
            if isinstance(result, Failure):
                send_notification(f"RSS Fetcher {report}")
                return Failure("Fetcher:RSS")

            # Common failure path (after retries or for non-HTTP errors)
            if isinstance(result, Failure):
                send_notification(f"RSS Fetcher {report}")
                return Failure("Fetcher:RSS")

        if kind == R:
            send_notification(f"Random Fetcher {report}")
            return Failure("Fetcher:Random")

        if kind == P:
            if playlist_exists(link):
                send_notification(f"Playlist Fetcher {report}")
                return Failure("Fetcher:PlayList")
            else:
                send_notification(f"PlayList {deleted}")
                return Failure("Deleted:PlayList")

    # ------------------------------------------------------------------
    # 3. Filter by last_seen (everything except Random)
    # ------------------------------------------------------------------
    if kind != R:
        result = filter_new_videos(result.unwrap(), last_seen)

        if isinstance(result, Failure):
            failure_msg = result.failure()

            if failure_msg == "Same":
                # Latest video is the same as last_seen → nothing new
                increment += 1
                save_counter(channel_id,increment)
                return Success("Done")


            if failure_msg == "Not Found":
                if video_exists(link):
                    # last_seen video still exists but was not in the feed
                    increment += 1
                else:
                    send_notification(f"Last seen Video {deleted}")


    # ------------------------------------------------------------------
    # 4. Word filter (only WordScan)
    # ------------------------------------------------------------------
    if kind == W:
        result = filter_words(result.unwrap(), words)
        if isinstance(result, Failure):
            increment += 1
            save_counter(channel_id,increment)
            return Success("Done")

    if kind != R:
        save_counter(channel_id,increment)
        ts,rank = ts_proccess(result.unwrap())

    save_ts(channel_id,ts,rank)
    save_result(channel_id,result)

    return Success("Done")




"""
Change:
    Fetcher:
        yt_random
        yt_rss
        yt_playlist
    Filter:
        Last seen
        scan

"""



"""
Fetcher:
    -1 = Critical Failure, Cannot handle
    0 = Successful
    1 = increment Counter
"""


"""
checks internet
if word or scan:
    request on rss
if playlist:
    request on play list
if random:
    request on random

- On fail on above 3:
    - check if channels exist
    - if playlist, check playlist existence (if play list exist, fetcher is fucked up)

does the new video proccess on Word/RSS/playlist
    - On fail:
        check video's existence,
            if exist: Increase the counter
            if doesn't: Use notification and return all the videos

does word scan
    - On fail
        Increase the counter







does the ts proccess
    - Finds the median of latest 10's dates diff
    - Find the latest time + 2 hours
    - See where it fits the rank
    - returns rank,ts

Use this:
from Model.rank import RANK_INTERVALS

RANK INTERVALS LOOKS LIKE THIS
RANK_INTERVALS = {
    "day": SECONDS_PER_DAY,
    "tri_day": 3 * SECONDS_PER_DAY,
    "week": SECONDS_PER_WEEK,
    "bi_week": 2 * SECONDS_PER_WEEK,
    "tri_week": 3 * SECONDS_PER_WEEK,
    "month": SECONDS_PER_MONTH,
    "bi_month": 2 * SECONDS_PER_MONTH,
    "quarter": 4 * SECONDS_PER_MONTH,
    "half_year": SECONDS_PER_YEAR // 2,
    "year": SECONDS_PER_YEAR,
    "abandon": 2 * SECONDS_PER_YEAR,
}









does the counter proccess
    - check counter
    - add counter
    - does rank up
    - 2 years of inactivity -> Abandoned. use notification
save
    - Save the ts, rank, Video in the feed.


Todo List:
    1) Make Every Fetcher have consistent Output
    2) yt_rss.py
        i) Remove the new video logic to another module
        ii) Make sure it only gives a turple
"""
