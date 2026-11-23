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
from Media.Yt.Config.Model.subscription import PgSubscription




class YtProcessSQL:
    """Backend-mechanism Yt SQL — the pipeline/manager/import workers call this. Never called from user-triggered paths."""

    async def _get_or_create_channel(self, con, key, user_id, name, url, logo=None) -> int:
        channel_id = await con.fetchval(
            "INSERT INTO yt_channels (user_id, name_enc, url_enc, url_hash, logo_enc) "
            "VALUES ($1, $2, $3, $4, $5) "
            "ON CONFLICT (user_id, url_hash) DO UPDATE SET "
            "logo_enc = COALESCE(EXCLUDED.logo_enc, yt_channels.logo_enc) "
            "RETURNING id",
            user_id, encrypt(key, name), encrypt(key, url), index_hash(key, url),
            encrypt(key, logo) if logo else None,
        )
        return channel_id

    async def claim_due(self) -> List[PgSubscription]:
        """Atomically claim due rows (working=true) and return them.

        Crash semantics: if the process dies mid-work, the row stays
        working=true until release_stale() frees it — nothing is ever
        processed twice, nothing is lost.
        """
        now = int(time.time())
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                UPDATE yt_tracking t SET working = TRUE, claimed_at = EXTRACT(EPOCH FROM NOW())::BIGINT
                FROM yt_channels c
                WHERE c.id = t.channel_id
                  AND t.active AND NOT t.working
                  AND c.label != 'reserved'           -- D22 life-phase switch
                  AND (t.ts IS NULL OR t.ts <= $1)
                RETURNING t.channel_id, c.user_id, t.rss_id_enc, t.kind,
                          t.word_enc, t.last_seen_enc, t.ts, t.rank, t.counter, t.claimed_at, t.claimed_at,
                          t.withhold_threshold
                """,
                now,
            )
            # Playlist + RandomSub tables: same claim discipline, plaintext ids.
            pl_rows = await con.fetch(
                """
                UPDATE yt_playlists p SET working = TRUE, claimed_at = EXTRACT(EPOCH FROM NOW())::BIGINT
                FROM yt_channels c
                WHERE c.id = p.channel_id
                  AND p.active AND NOT p.working
                  AND c.label != 'reserved'
                  AND (p.ts IS NULL OR p.ts <= $1)
                RETURNING p.channel_id, c.user_id, p.playlist_id, p.last_seen,
                          p.ts, p.rank, p.counter, p.claimed_at, p.claimed_at
                """,
                now,
            )
            rnd_rows = await con.fetch(
                """
                UPDATE yt_randomsubs r SET working = TRUE, claimed_at = EXTRACT(EPOCH FROM NOW())::BIGINT
                FROM yt_channels c
                WHERE c.id = r.channel_id
                  AND r.active AND NOT r.working
                  AND c.label != 'reserved'
                  AND (r.ts IS NULL OR r.ts <= $1)
                RETURNING r.channel_id, c.user_id, c.url_enc, r.ts, r.rank, r.claimed_at
                """,
                now,
            )
        subs, skipped = await self._to_subs(rows, return_skipped=True)
        # D9: locked-vault users are paused, not crashed — release their
        # claims immediately so they aren't orphaned for the stale window.
        if skipped:
            pool = await get_pool()
            async with pool.acquire() as con:
                await con.execute(
                    "UPDATE yt_tracking SET working = FALSE WHERE channel_id = ANY($1)",
                    skipped,
                )
        for r in pl_rows:
            subs.append(PgSubscription(
                sub_id=r["channel_id"], user_id=r["user_id"], media="yt",
                kind="playlist", link=r["playlist_id"], last_seen=r["last_seen"],
                ts=r["ts"], rank=r["rank"], counter=r["counter"],
                claim_token=r.get("claimed_at"),
            ))
        for r in rnd_rows:
            key = await vault.get(r["user_id"])
            if key is None:
                await self.release(r["channel_id"])  # D9 pause: don't orphan claims
                continue
            subs.append(PgSubscription(
                sub_id=r["channel_id"], user_id=r["user_id"], media="yt",
                kind="random", link=decrypt(key, r["url_enc"]) or "", last_seen=None,
                ts=r["ts"], rank=r["rank"], claim_token=r.get("claimed_at"),
            ))
        return subs

    async def release(self, sub_id: int, claim_token: Optional[int] = None) -> None:
        """Clear the working flag after processing. With claim_token (claimed_at
        at claim time) only THAT claim is cleared — an old worker finishing late
        cannot clear a newer worker's claim (2026 review fix)."""
        pool = await get_pool()
        async with pool.acquire() as con:
            for table in ("yt_tracking", "yt_playlists", "yt_randomsubs"):
                if claim_token is None:
                    await con.execute(
                        f"UPDATE {table} SET working = FALSE WHERE channel_id = $1", sub_id
                    )
                else:
                    await con.execute(
                        f"UPDATE {table} SET working = FALSE "
                        "WHERE channel_id = $1 AND claimed_at IS NOT DISTINCT FROM $2",
                        sub_id, claim_token,
                    )

    async def release_stale(self, stale_seconds: int) -> int:
        """Free claims older than the stale window — keyed on claimed_at so a
        crash after claiming a NEW row (ts still NULL) is recovered too, and
        covering ALL subscription tables (2026 review: both holes reproduced)."""
        cutoff = int(time.time()) - stale_seconds
        pool = await get_pool()
        freed = 0
        async with pool.acquire() as con:
            for table in ("yt_tracking", "yt_playlists", "yt_randomsubs"):
                result = await con.execute(
                    f"UPDATE {table} SET working = FALSE "
                    "WHERE working = TRUE AND claimed_at IS NOT NULL AND claimed_at < $1",
                    cutoff,
                )
                freed += int(result.split()[-1])
        if freed:
            log.warning("released %s stale working claim(s)", freed)
        return freed

    async def next_due_ts(self) -> int | None:
        """Earliest scheduled ts across active tracking rows (manager sleep)."""
        pool = await get_pool()
        async with pool.acquire() as con:
            return await con.fetchval(
                "SELECT MIN(ts) FROM ("
                "  SELECT ts FROM yt_tracking WHERE active AND NOT working AND ts IS NOT NULL"
                "  UNION ALL SELECT ts FROM yt_playlists WHERE active AND NOT working AND ts IS NOT NULL"
                "  UNION ALL SELECT ts FROM yt_randomsubs WHERE active AND NOT working AND ts IS NOT NULL"
                ") all_due"
            )

    async def get_due(self) -> List[PgSubscription]:
        """Due rows WITHOUT claiming (inspection/tests only)."""
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT t.channel_id, c.user_id, t.rss_id_enc, t.kind,
                       t.word_enc, t.last_seen_enc, t.ts, t.rank, t.counter,
                       t.withhold_threshold
                FROM yt_tracking t
                JOIN yt_channels c ON c.id = t.channel_id
                WHERE t.active AND NOT t.working
                  AND c.label != 'reserved'
                  AND (t.ts IS NULL OR t.ts <= $1)
                """,
                int(time.time()),
            )
        return await self._to_subs(rows)

    async def _to_subs(self, rows, return_skipped: bool = False):
        due: List[PgSubscription] = []
        skipped: List[int] = []
        for r in rows:
            key = await vault.get(r["user_id"])
            if key is None:
                log.debug("vault locked for user %s — skipping (D9)", r["user_id"])
                skipped.append(r["channel_id"])
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
                    claim_token=r.get("claimed_at"),
                    counter=r["counter"],
                    withhold_threshold=r.get("withhold_threshold"),
                )
            )
        return (due, skipped) if return_skipped else due

    async def save_videos_detailed(
        self, sub: PgSubscription, payload: FetchPayload
    ) -> List[Dict[str, Any]]:
        """Insert new videos and return exactly the rows that were new, so the
        pipeline stores each genuinely new video for the pull-driven feed."""
        key = await vault.get(sub.user_id)
        if key is None:
            return []
        videos = payload[0] if payload else {}
        pool = await get_pool()
        inserted: List[Dict[str, Any]] = []
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
                    inserted.append(
                        {
                            "video_id": video.get("id"),
                            "title": video.get("title") or "Untitled",
                            "url": url,
                            "thumbnail": video.get("thumbnail"),
                        }
                    )
            if inserted and sub.withhold_threshold:
                # F1 Withhold: buffer this batch. Nothing is emitted (and the feed
                # hides it) until the buffered count reaches the threshold, then
                # everything releases as one batch.
                await con.execute(
                    "UPDATE yt_videos SET withheld = TRUE WHERE channel_id = $1 "
                    "AND url_hash = ANY($2)",
                    sub.sub_id, [index_hash(key, v["url"]) for v in inserted],
                )
                buffered = await con.fetchval(
                    "SELECT count(*) FROM yt_videos WHERE channel_id = $1 AND withheld",
                    sub.sub_id,
                )
                if buffered < sub.withhold_threshold:
                    log.info(
                        "withhold: channel %s buffered %s/%s video(s)",
                        sub.sub_id, buffered, sub.withhold_threshold,
                    )
                    return []
                released = await con.fetch(
                    "UPDATE yt_videos SET withheld = FALSE WHERE channel_id = $1 AND withheld "
                    "RETURNING url_enc, title_enc, thumbnail_enc",
                    sub.sub_id,
                )
                log.info(
                    "withhold: channel %s released %s video(s) at threshold %s",
                    sub.sub_id, len(released), sub.withhold_threshold,
                )
                return [
                    {
                        "video_id": None,
                        "title": decrypt(key, r["title_enc"]) or "Untitled",
                        "url": decrypt(key, r["url_enc"]) or "",
                        "thumbnail": decrypt(key, r["thumbnail_enc"]),
                    }
                    for r in released
                ]
        return inserted

    async def save_videos(self, sub: PgSubscription, payload: FetchPayload) -> int:
        return len(await self.save_videos_detailed(sub, payload))

    async def channel_meta(self, user_id: int, channel_id: int) -> Dict[str, Any]:
        """Display metadata for feed rows and alert payloads (name + categories)."""
        key = await vault.get(user_id)
        if key is None:
            return {}
        pool = await get_pool()
        async with pool.acquire() as con:
            row = await con.fetchrow(
                "SELECT c.name_enc, s.name_enc AS s_enc, d.name_enc AS d_enc "
                "FROM yt_channels c "
                "LEFT JOIN yt_subdomains s ON s.id = c.subdomain_id "
                "LEFT JOIN yt_domains d ON d.id = s.domain_id "
                "WHERE c.id = $1 AND c.user_id = $2",
                channel_id, user_id,
            )
        if row is None:
            return {}
        return {
            "name": decrypt(key, row["name_enc"]),
            "domain": decrypt(key, row["d_enc"]) or "uncategorized",
            "subdomain": decrypt(key, row["s_enc"]) or "uncategorized",
        }

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
        pool = await get_pool()
        async with pool.acquire() as con:
            if sub.kind in ("tracking", "wordscan"):
                last_seen_enc = encrypt(key, last_seen) if (key and last_seen) else None
                await con.execute(
                    "UPDATE yt_tracking SET "
                    "ts = COALESCE($2, ts), rank = COALESCE($3, rank), "
                    "last_seen_enc = COALESCE($4, last_seen_enc), "
                    "counter = COALESCE($5, counter) "
                    "WHERE channel_id = $1",
                    sub.sub_id, ts, rank, last_seen_enc, counter,
                )
            elif sub.kind == "playlist":
                await con.execute(
                    "UPDATE yt_playlists SET "
                    "ts = COALESCE($2, ts), rank = COALESCE($3, rank), "
                    "last_seen = COALESCE($4, last_seen), counter = COALESCE($5, counter) "
                    "WHERE channel_id = $1",
                    sub.sub_id, ts, rank, last_seen, counter,
                )
            else:  # random: ts only — rank is user-controlled, never auto
                await con.execute(
                    "UPDATE yt_randomsubs SET ts = COALESCE($2, ts) WHERE channel_id = $1",
                    sub.sub_id, ts,
                )

    async def bump_counter(self, sub_id: int, increment: int, kind: str = "tracking") -> int:
        table = "yt_playlists" if kind == "playlist" else "yt_tracking"
        pool = await get_pool()
        async with pool.acquire() as con:
            return await con.fetchval(
                f"UPDATE {table} SET counter = counter + $2 WHERE channel_id = $1 "
                "RETURNING counter",
                sub_id, increment,
            )

    async def alerts_enabled(self, user_id: int, channel_id: int) -> bool:
        """Effective alerts gate for one channel (domain ∧ subdomain ∧
        channel ∧ not blocked ∧ subscription active)."""
        pool = await get_pool()
        async with pool.acquire() as con:
            return bool(
                await con.fetchval(
                    """
                    SELECT COALESCE(c.alerts, TRUE) AND COALESCE(s.alerts, TRUE)
                       AND COALESCE(d.alerts, TRUE) AND c.label = 'none'
                       AND COALESCE(t.active, p.active, r.active, TRUE)
                    FROM yt_channels c
                    LEFT JOIN yt_subdomains s ON s.id = c.subdomain_id
                    LEFT JOIN yt_domains d ON d.id = s.domain_id
                    LEFT JOIN yt_tracking t ON t.channel_id = c.id
                    LEFT JOIN yt_playlists p ON p.channel_id = c.id
                    LEFT JOIN yt_randomsubs r ON r.channel_id = c.id
                    WHERE c.id = $1 AND c.user_id = $2
                    """,
                    channel_id, user_id,
                )
            )

    async def purge_trash(self, older_than_seconds: int = 86400) -> int:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "DELETE FROM yt_videos WHERE trashed_at < now() - make_interval(secs => $1)",
                older_than_seconds,
            )
        return int(result.split()[-1])


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
