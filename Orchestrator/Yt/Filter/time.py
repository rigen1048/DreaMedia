from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any, Dict, List, Tuple

from returns.result import Result, Success, Failure

from Model.rank import RANK_INTERVALS
from Utility.logs import log


def _parse_ts(ts: str) -> datetime:
    """
    Parse timestamps coming from RSS (ISO-8601) and Playlist/yt-dlp (YYYYMMDD etc.)
    Returns naive UTC datetime.
    """
    ts = str(ts).strip()

    formats = [
        "%Y-%m-%dT%H:%M:%S%z",     # 2024-05-01T12:34:56+00:00
        "%Y-%m-%dT%H:%M:%SZ",      # 2024-05-01T12:34:56Z
        "%Y-%m-%dT%H:%M:%S",       # 2024-05-01T12:34:56
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
        "%Y%m%d",                  # yt-dlp style
    ]

    for fmt in formats:
        try:
            dt = datetime.strptime(ts, fmt)
            if dt.tzinfo is not None:
                dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
            return dt
        except ValueError:
            continue

    raise ValueError(f"Unable to parse timestamp: {ts!r}")


def ts_proccess(
    videos: Tuple[Dict[int, Dict[str, Any]]],
) -> Result[Tuple[int, str], str]:
    """
    Predict next likely upload time based on historical timestamps.

    Returns Success( (unix_ts, rank) ) or Failure(...).
    Logs the human-readable timestamp.
    """
    if not videos or not videos[0]:
        return Failure("No videos provided")

    videos_dict = videos[0]

    # Extract timestamps (dict is newest → oldest)
    timestamps: List[str] = []
    for key in sorted(videos_dict.keys()):
        published = videos_dict[key].get("published")
        if published:
            timestamps.append(str(published))

    if not timestamps:
        return Failure("No timestamps found")

    try:
        dts = sorted(_parse_ts(ts) for ts in timestamps)
    except ValueError as e:
        return Failure(str(e))

    n = len(dts)
    last_dt = dts[-1]
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    seconds_since_last = (now - last_dt).total_seconds()

    # ------------------------------------------------------------------
    # Less than 10 videos → simple rule
    # ------------------------------------------------------------------
    if n < 10:
        if seconds_since_last > RANK_INTERVALS["abandon"]:
            rank = "abandon"
            period_seconds = RANK_INTERVALS["abandon"]
        else:
            rank = "month"          # default
            period_seconds = RANK_INTERVALS["month"]

        base_date = last_dt.date() + timedelta(seconds=period_seconds)

    # ------------------------------------------------------------------
    # 10+ videos → full median logic
    # ------------------------------------------------------------------
    else:
        # Abandoned check still applies
        if seconds_since_last > RANK_INTERVALS["abandon"]:
            rank = "abandon"
            period_seconds = RANK_INTERVALS["abandon"]
            base_date = last_dt.date() + timedelta(seconds=period_seconds)
        else:
            gaps = [(dts[i] - dts[i - 1]).total_seconds() for i in range(1, n)]
            median_gap = median(gaps)

            # Tightest rank whose interval >= median_gap
            chosen_rank = "abandon"
            chosen_seconds = RANK_INTERVALS["abandon"]

            for rank_name, seconds in RANK_INTERVALS.items():
                if median_gap <= seconds < chosen_seconds:
                    chosen_rank = rank_name
                    chosen_seconds = seconds

            rank = chosen_rank
            period_seconds = chosen_seconds
            base_date = last_dt.date() + timedelta(seconds=period_seconds)

    # Preferred time: last upload time-of-day + 2 hours
    last_time = last_dt.replace(second=0, microsecond=0).time()
    buffered = datetime(2000, 1, 1, last_time.hour, last_time.minute) + timedelta(hours=2)
    preferred_time = buffered.time()

    if buffered.day > 1:  # overflow past midnight
        preferred_time = (buffered - timedelta(days=1)).time()
        base_date += timedelta(days=1)

    next_dt = datetime.combine(base_date, preferred_time)

    # Project forward if already past
    while next_dt <= now + timedelta(hours=2):
        next_dt += timedelta(seconds=period_seconds)

    ts_read = next_dt.strftime("%Y-%m-%d %H:%M")
    ts = int(next_dt.timestamp())

    log.info("Next predicted upload window: %s (rank=%s)", ts_read, rank)

    return Success((ts, rank))
