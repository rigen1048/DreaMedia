from typing import Any, Dict, List, Optional, Tuple
from Utility.logs import log
from Database.db import get_connection
from Model.config import COUNTER_CELLING
from Model.rank import RANK_INTERVALS


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _get_next_rank(current_rank: str) -> Optional[str]:
    """Return the next higher rank in RANK_INTERVALS order, or None if already highest."""
    ranks = list(RANK_INTERVALS.keys())
    try:
        idx = ranks.index(current_rank)
        if idx + 1 < len(ranks):
            return ranks[idx + 1]
    except ValueError:
        pass
    return None


def _resolve_subscription(channel_id: int) -> List[Tuple[str, str, Any]]:
    """
    Discover which subscription table(s) contain this channel_id.

    Returns a list of (table_name, primary_key_column, primary_key_value).
    A channel *should* belong to only one table, but we handle the possibility
    of multiple matches gracefully.
    """
    conn = get_connection()
    cur = conn.cursor()
    results = []

    try:
        # Tracking (PK = rss_id)
        cur.execute(
            "SELECT rss_id FROM Tracking WHERE id_channel = ?",
            (channel_id,),
        )
        for (rss_id,) in cur.fetchall():
            results.append(("Tracking", "rss_id", rss_id))

        # Playlist (PK = id_playlist)
        cur.execute(
            "SELECT id_playlist FROM Playlist WHERE id_channel = ?",
            (channel_id,),
        )
        for (playlist_id,) in cur.fetchall():
            results.append(("Playlist", "id_playlist", playlist_id))

        # RandomSub (no useful PK for updates – we key on id_channel)
        cur.execute(
            "SELECT 1 FROM RandomSub WHERE id_channel = ?",
            (channel_id,),
        )
        if cur.fetchone():
            results.append(("RandomSub", "id_channel", channel_id))

    finally:
        conn.close()

    return results


# ---------------------------------------------------------------------------
# 1. Save the video result + mark subscription as done (working = 0)
# ---------------------------------------------------------------------------
def save_result(
    channel_id: int,
    videos: Tuple[Dict[int, Dict[str, Any]]],
) -> None:
    """
    Persist new videos into the Video table and set working = 0
    on every subscription row that belongs to this channel_id.
    """
    if not videos or not videos[0]:
        log.info("save_result: no videos to save for channel_id=%s", channel_id)
        return

    videos_dict = videos[0]
    conn = get_connection()
    cur = conn.cursor()
    inserted = 0

    try:
        # ------------------------------------------------------------------
        # 1. Insert new videos
        # ------------------------------------------------------------------
        for video in videos_dict.values():
            video_url = video.get("url")
            title = video.get("title") or "Untitled"
            thumbnail = video.get("thumbnail")
            published = video.get("published")

            published_at = None
            if published:
                try:
                    from datetime import datetime
                    for fmt in (
                        "%Y-%m-%dT%H:%M:%S%z",
                        "%Y-%m-%dT%H:%M:%SZ",
                        "%Y-%m-%dT%H:%M:%S",
                        "%Y-%m-%d",
                        "%Y%m%d",
                    ):
                        try:
                            dt = datetime.strptime(str(published), fmt)
                            published_at = int(dt.timestamp())
                            break
                        except ValueError:
                            continue
                except Exception:
                    pass

            cur.execute(
                """
                INSERT OR IGNORE INTO Video
                    (channel_id, video_url, title, thumbnail, published_at, seen)
                VALUES (?, ?, ?, ?, ?, 0)
                """,
                (channel_id, video_url, title, thumbnail, published_at),
            )
            if cur.rowcount:
                inserted += 1

        # ------------------------------------------------------------------
        # 2. Set working = 0 on every matching subscription
        # ------------------------------------------------------------------
        targets = _resolve_subscription(channel_id)

        if not targets:
            log.warning(
                "save_result: channel_id=%s not found in Tracking/Playlist/RandomSub",
                channel_id,
            )
        else:
            for table, pk_col, pk_val in targets:
                if table == "RandomSub":
                    cur.execute(
                        "UPDATE RandomSub SET working = 0 WHERE id_channel = ?",
                        (channel_id,),
                    )
                else:
                    cur.execute(
                        f"UPDATE {table} SET working = 0 WHERE {pk_col} = ?",
                        (pk_val,),
                    )
                log.info(
                    "save_result: set working=0 on %s (%s=%s)",
                    table, pk_col, pk_val,
                )

        conn.commit()
        log.info(
            "save_result: channel_id=%s – inserted %s videos",
            channel_id, inserted,
        )

    except Exception as e:
        conn.rollback()
        log.error("save_result failed for channel_id=%s: %s", channel_id, e)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 2. Save ts + rank
# ---------------------------------------------------------------------------
def save_ts(
    channel_id: int,
    ts: int | None = None,
    rank: str | None = None,
) -> None:
    """
    Update ts (and rank where allowed) for every subscription that belongs
    to the given channel_id.

    Rules
    -----
    - Tracking / Playlist → update both ts and rank (rank is optional)
    - RandomSub           → update **only** ts  (rank is user-controlled)
    """
    targets = _resolve_subscription(channel_id)

    if not targets:
        log.warning(
            "save_ts: channel_id=%s not found in Tracking/Playlist/RandomSub",
            channel_id,
        )
        return

    conn = get_connection()
    cur = conn.cursor()

    try:
        for table, pk_col, pk_val in targets:
            if table == "RandomSub":
                # Never touch rank
                cur.execute(
                    "UPDATE RandomSub SET ts = ? WHERE id_channel = ?",
                    (ts, channel_id),
                )
                log.info(
                    "save_ts: RandomSub channel_id=%s – ts=%s rank=(unchanged)",
                    channel_id, ts,
                )
            else:
                # Tracking or Playlist – may update rank
                cur.execute(
                    f"""
                    UPDATE {table}
                    SET ts = ?, rank = COALESCE(?, rank)
                    WHERE {pk_col} = ?
                    """,
                    (ts, rank, pk_val),
                )
                log.info(
                    "save_ts: %s %s=%s – ts=%s rank=%s",
                    table, pk_col, pk_val, ts, rank,
                )

        conn.commit()

    except Exception as e:
        conn.rollback()
        log.error("save_ts failed for channel_id=%s: %s", channel_id, e)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 3. Save / process counter
# ---------------------------------------------------------------------------
def save_counter(channel_id: int, increment: int) -> None:
    """
    1. Add increment to the counter of the given channel (Tracking + Playlist)
    2. Scan whole DB for any counter > COUNTER_CELLING
    3. Promote those ranks one step and reset their counter
    4. Log everything, return nothing

    Note: RandomSub does not have a counter.
    """
    if increment <= 0:
        return

    conn = get_connection()
    cur = conn.cursor()

    try:
        # 1. Update counter for this channel in Tracking & Playlist
        for table in ("Tracking", "Playlist"):
            cur.execute(
                f"""
                UPDATE {table}
                SET counter = counter + ?
                WHERE id_channel = ?
                """,
                (increment, channel_id),
            )
            if cur.rowcount:
                log.info(
                    "save_counter: %s channel_id=%s (+%s)",
                    table, channel_id, increment,
                )

        # 2. DB-wide search for counters over the ceiling
        candidates = []

        cur.execute(
            "SELECT rss_id, rank, counter FROM Tracking WHERE counter > ?",
            (COUNTER_CELLING,),
        )
        for rss_id, rank, counter in cur.fetchall():
            candidates.append(("Tracking", "rss_id", rss_id, rank, counter))

        cur.execute(
            "SELECT id_playlist, rank, counter FROM Playlist WHERE counter > ?",
            (COUNTER_CELLING,),
        )
        for playlist_id, rank, counter in cur.fetchall():
            candidates.append(("Playlist", "id_playlist", playlist_id, rank, counter))

        # 3. Promote + reset
        for table, pk_col, pk_val, current_rank, counter in candidates:
            next_rank = _get_next_rank(current_rank or "day")
            if next_rank is None:
                log.info(
                    "save_counter: %s %s already at highest rank (%s) – no promotion",
                    table, pk_val, current_rank,
                )
                continue

            cur.execute(
                f"""
                UPDATE {table}
                SET rank = ?, counter = 0
                WHERE {pk_col} = ?
                """,
                (next_rank, pk_val),
            )
            log.info(
                "save_counter: promoted %s %s %s → %s (counter was %s)",
                table, pk_val, current_rank, next_rank, counter,
            )

        conn.commit()

    except Exception as e:
        conn.rollback()
        log.error("save_counter failed for channel_id=%s: %s", channel_id, e)
    finally:
        conn.close()
