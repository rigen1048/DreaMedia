from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from Model.rank import DEFAULT_INTERVAL, DEFAULT_RANGE, RANK_INTERVALS


# ---------------------------------------------------------------------------
# Connection helper (single style)
# ---------------------------------------------------------------------------
@contextmanager
def get_connection(db_path: str | Path = DB_PATH) -> Iterator[sqlite3.Connection]:
    """Open a connection with Row factory and guarantee it is closed."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
def _parse_word_list(raw: str | None) -> List[str]:
    """Convert '[banana, red, dragon]' → ['banana', 'red', 'dragon']."""
    if not raw or not (raw.startswith("[") and raw.endswith("]")):
        return []
    content = raw[1:-1].strip()
    return [w.strip() for w in content.split(",") if w.strip()] if content else []


def _fetch_ids(cur: sqlite3.Cursor, query: str, params: tuple = ()) -> List[Any]:
    cur.execute(query, params)
    return [row[0] for row in cur.fetchall()]


def _build(
    db_path: Path | str,
    id_map: Dict[str, List[Any]],
) -> Tuple[Tuple[Any, ...], ...]:
    """
    Build a flat tuple of tuples:

        (
            ("Tracking", channel_id, rss, last_seen),
            ("WordScan", channel_id, rss, last_seen, word),   # word is a list
            ("Playlist", channel_id, playlist_id, last_seen),
            ("RandomSub", channel_id, url),
            ...
        )
    """
    result: List[Tuple[Any, ...]] = []

    with get_connection(db_path) as con:
        cur = con.cursor()

        # Tracking (type 0)
        if ids := id_map.get("Tracking"):
            ph = ",".join("?" * len(ids))
            cur.execute(
                f"""
                SELECT id_channel AS channel_id,
                       rss_id AS rss,
                       last_video_id AS last_seen
                FROM Tracking
                WHERE rss_id IN ({ph}) AND type = 0
                """,
                ids,
            )
            for row in cur.fetchall():
                result.append(
                    ("Tracking", row["channel_id"], row["rss"], row["last_seen"])
                )

        # WordScan (type 1)
        if ids := id_map.get("WordScan"):
            ph = ",".join("?" * len(ids))
            cur.execute(
                f"""
                SELECT id_channel AS channel_id,
                       rss_id AS rss,
                       last_video_id AS last_seen,
                       word
                FROM Tracking
                WHERE rss_id IN ({ph}) AND type = 1
                """,
                ids,
            )
            for row in cur.fetchall():
                word = _parse_word_list(row["word"])
                result.append(
                    (
                        "WordScan",
                        row["channel_id"],
                        row["rss"],
                        row["last_seen"],
                        word,
                    )
                )

        # Playlist
        if ids := id_map.get("Playlist"):
            ph = ",".join("?" * len(ids))
            cur.execute(
                f"""
                SELECT id_channel AS channel_id,
                       id_playlist AS playlist_id,
                       last_video_id AS last_seen
                FROM Playlist
                WHERE id_playlist IN ({ph})
                """,
                ids,
            )
            for row in cur.fetchall():
                result.append(
                    (
                        "Playlist",
                        row["channel_id"],
                        row["playlist_id"],
                        row["last_seen"],
                    )
                )

        # RandomSub
        if ids := id_map.get("RandomSub"):
            ph = ",".join("?" * len(ids))
            cur.execute(
                f"""
                SELECT r.id_channel AS channel_id,
                       c.channel_url AS url
                FROM RandomSub r
                JOIN Channel c ON c.id_channel = r.id_channel
                WHERE r.id_randomsub IN ({ph})
                """,
                ids,
            )
            for row in cur.fetchall():
                result.append(("RandomSub", row["channel_id"], row["url"]))

    return tuple(result)


# ---------------------------------------------------------------------------
# Public API – subscriptions
# ---------------------------------------------------------------------------
def get_working_subscriptions(
    db_path: str | Path = DB_PATH,
) -> Tuple[Tuple[Any, ...], ...]:
    """Return all subscriptions currently marked working = 1 as a flat tuple of tuples."""
    db_path = Path(db_path)
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    with get_connection(db_path) as con:
        cur = con.cursor()
        id_map = {
            "Tracking": _fetch_ids(
                cur, "SELECT rss_id FROM Tracking WHERE working = 1 AND type = 0"
            ),
            "WordScan": _fetch_ids(
                cur, "SELECT rss_id FROM Tracking WHERE working = 1 AND type = 1"
            ),
            "Playlist": _fetch_ids(
                cur, "SELECT id_playlist FROM Playlist WHERE working = 1"
            ),
            "RandomSub": _fetch_ids(
                cur, "SELECT id_randomsub FROM RandomSub WHERE working = 1"
            ),
        }
    return _build(db_path, id_map)


def get_due_subscriptions(
    db_path: str | Path = DB_PATH,
) -> Tuple[Tuple[Any, ...], ...]:
    """
    Find subscriptions whose ts < now, set working = 1,
    and return their data as a flat tuple of tuples.
    """
    db_path = Path(db_path)
    now = int(time.time())

    with get_connection(db_path) as con:
        cur = con.cursor()
        id_map: Dict[str, List[Any]] = {
            "Tracking": [],
            "WordScan": [],
            "Playlist": [],
            "RandomSub": [],
        }

        # Tracking
        due = _fetch_ids(
            cur, "SELECT rss_id FROM Tracking WHERE ts < ? AND type = 0", (now,)
        )
        if due:
            ph = ",".join("?" * len(due))
            cur.execute(
                f"UPDATE Tracking SET working = 1 WHERE rss_id IN ({ph}) AND type = 0",
                due,
            )
            id_map["Tracking"] = due

        # WordScan
        due = _fetch_ids(
            cur, "SELECT rss_id FROM Tracking WHERE ts < ? AND type = 1", (now,)
        )
        if due:
            ph = ",".join("?" * len(due))
            cur.execute(
                f"UPDATE Tracking SET working = 1 WHERE rss_id IN ({ph}) AND type = 1",
                due,
            )
            id_map["WordScan"] = due

        # Playlist
        due = _fetch_ids(cur, "SELECT id_playlist FROM Playlist WHERE ts < ?", (now,))
        if due:
            ph = ",".join("?" * len(due))
            cur.execute(
                f"UPDATE Playlist SET working = 1 WHERE id_playlist IN ({ph})",
                due,
            )
            id_map["Playlist"] = due

        # RandomSub
        due = _fetch_ids(
            cur, "SELECT id_randomsub FROM RandomSub WHERE ts < ?", (now,)
        )
        if due:
            ph = ",".join("?" * len(due))
            cur.execute(
                f"UPDATE RandomSub SET working = 1 WHERE id_randomsub IN ({ph})",
                due,
            )
            id_map["RandomSub"] = due
        con.commit()
    return _build(db_path, id_map)



def get_all_subscriptions(
    db_path: str | Path = DB_PATH,
) -> Tuple[Tuple[Any, ...], ...]:
    """Return all subscriptions (regardless of working/ts status) as a flat tuple of tuples."""
    db_path = Path(db_path)
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    with get_connection(db_path) as con:
        cur = con.cursor()
        id_map = {
            "Tracking": _fetch_ids(
                cur, "SELECT rss_id FROM Tracking WHERE type = 0"
            ),
            "WordScan": _fetch_ids(
                cur, "SELECT rss_id FROM Tracking WHERE type = 1"
            ),
            "Playlist": _fetch_ids(
                cur, "SELECT id_playlist FROM Playlist"
            ),
            "RandomSub": _fetch_ids(
                cur, "SELECT id_randomsub FROM RandomSub"
            ),
        }
    return _build(db_path, id_map)

# ---------------------------------------------------------------------------
# Public API – on-the-fly channel lookups
# ---------------------------------------------------------------------------

def get_channel_rank_counter(
    db_path: str | Path,
    channel_id: int,
) -> Optional[Dict[str, Any]]:
    """
    Returns {"rank": str, "counter": int} or {"rank": str} or None.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    with get_connection(db_path) as con:
        cur = con.cursor()

        cur.execute(
            "SELECT rank, counter FROM Tracking WHERE id_channel = ? LIMIT 1",
            (channel_id,),
        )
        if row := cur.fetchone():
            return {"rank": row[0], "counter": int(row[1])}

        cur.execute(
            "SELECT rank, counter FROM Playlist WHERE id_channel = ? LIMIT 1",
            (channel_id,),
        )
        if row := cur.fetchone():
            return {"rank": row[0], "counter": int(row[1])}

        cur.execute(
            "SELECT rank FROM RandomSub WHERE id_channel = ? LIMIT 1",
            (channel_id,),
        )
        if row := cur.fetchone():
            return {"rank": row[0]}

    return None


def get_channel_last_seen(
    db_path: str | Path,
    channel_id: int,
) -> Optional[Dict[str, Any]]:
    """
    Returns {"last_seen": str | None} or None.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    with get_connection(db_path) as con:
        cur = con.cursor()

        cur.execute(
            "SELECT last_video_id FROM Tracking WHERE id_channel = ? LIMIT 1",
            (channel_id,),
        )
        if row := cur.fetchone():
            return {"last_seen": row[0]}

        cur.execute(
            "SELECT last_video_id FROM Playlist WHERE id_channel = ? LIMIT 1",
            (channel_id,),
        )
        if row := cur.fetchone():
            return {"last_seen": row[0]}

    return None


# ---------------------------------------------------------------------------
# Public API – Sync table helpers
# ---------------------------------------------------------------------------

def is_working(db_path: str | Path = DB_PATH) -> bool:
    """Return True if the `working` column in Sync is 1."""
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT working FROM Sync LIMIT 1").fetchone()
    return bool(row and row[0] == 1)


def next_sync(db_path: str | Path = DB_PATH) -> int:
    """
    Read last_sync + rank from Sync, compute next sync time,
    and return True if it falls within ±DEFAULT_RANGE of now.
    """
    with get_connection(db_path) as conn:
        row = conn.execute(
            "SELECT last_sync, rank FROM Sync LIMIT 1"
        ).fetchone()

    if not row:
        return False

    last_sync, rank = row
    interval = RANK_INTERVALS.get(str(rank).lower(), DEFAULT_INTERVAL)
    next_sync = last_sync + interval
    return next_sync


def should_sync_today(db_path: str | Path = DB_PATH) -> bool:
    now = int(time.time())
    next_syn = next_sync(db_path)
    if next_syn is False:          # or: if not isinstance(next_syn, (int, float))
        return False
    return abs(next_syn - now) <= DEFAULT_RANGE


def has_working_subscriptions(
    db_path: str | Path = DB_PATH,
) -> bool:
    """Return True if any subscription is currently marked working = 1."""
    db_path = Path(db_path)
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")
    with get_connection(db_path) as con:
        cur = con.cursor()
        if _fetch_ids(
            cur, "SELECT rss_id FROM Tracking WHERE working = 1 AND type = 0"
        ):
            return True
        if _fetch_ids(
            cur, "SELECT rss_id FROM Tracking WHERE working = 1 AND type = 1"
        ):
            return True
        if _fetch_ids(cur, "SELECT id_playlist FROM Playlist WHERE working = 1"):
            return True
        if _fetch_ids(cur, "SELECT id_randomsub FROM RandomSub WHERE working = 1"):
            return True
    return False


def has_due_subscriptions(
    db_path: str | Path = DB_PATH,
) -> bool:
    """
    Return True if any subscription has ts < now (i.e. is due).
    Does NOT update the working flag.
    """
    db_path = Path(db_path)
    now = int(time.time())
    with get_connection(db_path) as con:
        cur = con.cursor()
        if _fetch_ids(
            cur, "SELECT rss_id FROM Tracking WHERE ts < ? AND type = 0", (now,)
        ):
            return True
        if _fetch_ids(
            cur, "SELECT rss_id FROM Tracking WHERE ts < ? AND type = 1", (now,)
        ):
            return True
        if _fetch_ids(cur, "SELECT id_playlist FROM Playlist WHERE ts < ?", (now,)):
            return True
        if _fetch_ids(
            cur, "SELECT id_randomsub FROM RandomSub WHERE ts < ?", (now,)
        ):
            return True
    return False
