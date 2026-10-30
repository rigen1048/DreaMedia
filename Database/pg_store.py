"""Postgres store — the real persistence behind the pipelines (D3/D8/D9).

Same async method shapes as DevStore, so pipelines don't care which
store they get. Differences that matter:

- Every content column is encrypted with the row owner's key from the
  vault. Lookups/uniqueness go through blind indexes (HMAC) because
  randomized nonces make ciphertext non-deterministic.
- If the user's key isn't in the vault (app restarted, D9), their rows
  are skipped by get_due — that IS the pause-until-login behavior.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from returns.result import Failure, Result, Success

from Database import vault
from Database.crypto import decrypt, encrypt, index_hash
from Database.db import get_pool
from Model.video import FetchPayload
from Utility.logs import log


@dataclass
class PgSubscription:
    sub_id: int           # yt_tracking.channel_id
    user_id: int
    media: str            # "yt"
    kind: str             # tracking|wordscan|playlist|random
    link: str             # rss_id (decrypted — needed for fetching)
    last_seen: Optional[str]
    words: List[str] = field(default_factory=list)
    ts: Optional[int] = None
    rank: str = "day"
    counter: int = 0


class PgStore:
    """Yt-facing Postgres store (Ani store lands with the Ani pipeline)."""

    async def add_tracking(
        self,
        user_id: int,
        rss_id: str,
        channel_name: str,
        channel_url: str,
        kind: str = "tracking",
        words: Optional[List[str]] = None,
    ) -> Result[int, str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked for user (login required, D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                channel_id = await con.fetchval(
                    "INSERT INTO yt_channels (user_id, name_enc, url_enc, url_hash) "
                    "VALUES ($1, $2, $3, $4) RETURNING id",
                    user_id,
                    encrypt(key, channel_name),
                    encrypt(key, channel_url),
                    index_hash(key, channel_url),
                )
                await con.execute(
                    "INSERT INTO yt_tracking (channel_id, rss_id_enc, rss_hash, kind, word_enc) "
                    "VALUES ($1, $2, $3, $4, $5)",
                    channel_id,
                    encrypt(key, rss_id),
                    index_hash(key, rss_id),
                    kind,
                    encrypt(key, ",".join(words)) if words else None,
                )
        return Success(channel_id)

    async def get_due(self) -> List[PgSubscription]:
        """Due tracking rows whose owner's vault is unlocked (D9 pause)."""
        now = int(time.time())
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT t.channel_id, c.user_id, t.rss_id_enc, t.kind,
                       t.word_enc, t.last_seen_enc, t.ts, t.rank, t.counter
                FROM yt_tracking t
                JOIN yt_channels c ON c.id = t.channel_id
                WHERE t.active AND NOT t.working
                  AND c.label != 'reserved'           -- D22 life-phase switch
                  AND (t.ts IS NULL OR t.ts <= $1)
                """,
                now,
            )
        due: List[PgSubscription] = []
        for r in rows:
            key = await vault.get(r["user_id"])
            if key is None:
                log.debug("vault locked for user %s — skipping (D9)", r["user_id"])
                continue
            words_raw = decrypt(key, r["word_enc"])
            due.append(
                PgSubscription(
                    sub_id=r["channel_id"],
                    user_id=r["user_id"],
                    media="yt",
                    kind=r["kind"],
                    link=decrypt(key, r["rss_id_enc"]) or "",
                    last_seen=decrypt(key, r["last_seen_enc"]),
                    words=words_raw.split(",") if words_raw else [],
                    ts=r["ts"],
                    rank=r["rank"],
                    counter=r["counter"],
                )
            )
        return due

    async def save_videos(self, sub: PgSubscription, payload: FetchPayload) -> int:
        key = await vault.get(sub.user_id)
        if key is None:
            return 0
        videos = payload[0] if payload else {}
        pool = await get_pool()
        inserted = 0
        async with pool.acquire() as con:
            for video in videos.values():
                url = video.get("url")
                if not url:
                    continue
                result = await con.execute(
                    "INSERT INTO yt_videos (channel_id, url_enc, url_hash, title_enc, thumbnail_enc, published_at) "
                    "VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (channel_id, url_hash) DO NOTHING",
                    sub.sub_id,
                    encrypt(key, url),
                    index_hash(key, url),
                    encrypt(key, video.get("title") or "Untitled"),
                    encrypt(key, video.get("thumbnail")),
                    _to_unix(video.get("published")),
                )
                if result.endswith("1"):
                    inserted += 1
        return inserted

    async def update_schedule(
        self,
        sub: PgSubscription,
        *,
        ts: Optional[int] = None,
        rank: Optional[str] = None,
        last_seen: Optional[str] = None,
        counter: Optional[int] = None,
    ) -> None:
        key = await vault.get(sub.user_id)
        last_seen_enc = encrypt(key, last_seen) if (key and last_seen) else None
        pool = await get_pool()
        async with pool.acquire() as con:
            await con.execute(
                "UPDATE yt_tracking SET "
                "ts = COALESCE($2, ts), rank = COALESCE($3, rank), "
                "last_seen_enc = COALESCE($4, last_seen_enc), "
                "counter = COALESCE($5, counter) "
                "WHERE channel_id = $1",
                sub.sub_id, ts, rank, last_seen_enc, counter,
            )

    async def bump_counter(self, sub_id: int, increment: int) -> int:
        pool = await get_pool()
        async with pool.acquire() as con:
            return await con.fetchval(
                "UPDATE yt_tracking SET counter = counter + $2 WHERE channel_id = $1 "
                "RETURNING counter",
                sub_id, increment,
            )

    async def feed(self, user_id: int, limit: int = 100) -> List[Dict[str, Any]]:
        """Decrypted feed rows for one user — the Feed tier reads this."""
        key = await vault.get(user_id)
        if key is None:
            return []
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT v.title_enc, v.url_enc, v.thumbnail_enc, v.published_at, v.seen,
                       c.name_enc AS channel_enc
                FROM yt_videos v
                JOIN yt_channels c ON c.id = v.channel_id
                WHERE c.user_id = $1 AND c.label != 'blocked'   -- D22
                ORDER BY v.published_at DESC NULLS LAST
                LIMIT $2
                """,
                user_id, limit,
            )
        return [
            {
                "title": decrypt(key, r["title_enc"]),
                "url": decrypt(key, r["url_enc"]),
                "thumbnail": decrypt(key, r["thumbnail_enc"]),
                "published_at": r["published_at"],
                "seen": r["seen"],
                "channel": decrypt(key, r["channel_enc"]),
            }
            for r in rows
        ]


def _to_unix(published: Any) -> Optional[int]:
    if not published:
        return None
    from datetime import datetime

    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d", "%Y%m%d"):
        try:
            return int(datetime.strptime(str(published), fmt).timestamp())
        except ValueError:
            continue
    return None
