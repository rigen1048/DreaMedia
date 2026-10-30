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

    async def _get_or_create_channel(self, con, key, user_id, name, url) -> int:
        return await con.fetchval(
            "INSERT INTO yt_channels (user_id, name_enc, url_enc, url_hash) "
            "VALUES ($1, $2, $3, $4) "
            "ON CONFLICT (user_id, url_hash) DO UPDATE SET user_id = EXCLUDED.user_id "
            "RETURNING id",
            user_id, encrypt(key, name), encrypt(key, url), index_hash(key, url),
        )

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
                channel_id = await self._get_or_create_channel(con, key, user_id, channel_name, channel_url)
                # yt_tracking.channel_id is PK (owner schema: 1 subscription row
                # per channel). Re-subscribing with a different kind UPDATES it:
                # a channel is either tracked wholesale or word-scanned.
                await con.execute(
                    "INSERT INTO yt_tracking (channel_id, rss_id_enc, rss_hash, kind, word_enc) "
                    "VALUES ($1, $2, $3, $4, $5) "
                    "ON CONFLICT (channel_id) DO UPDATE SET "
                    "kind = EXCLUDED.kind, word_enc = EXCLUDED.word_enc",
                    channel_id,
                    encrypt(key, rss_id),
                    index_hash(key, rss_id),
                    kind,
                    encrypt(key, ",".join(words)) if words else None,
                )
        return Success(channel_id)

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
                UPDATE yt_tracking t SET working = TRUE
                FROM yt_channels c
                WHERE c.id = t.channel_id
                  AND t.active AND NOT t.working
                  AND c.label != 'reserved'           -- D22 life-phase switch
                  AND (t.ts IS NULL OR t.ts <= $1)
                RETURNING t.channel_id, c.user_id, t.rss_id_enc, t.kind,
                          t.word_enc, t.last_seen_enc, t.ts, t.rank, t.counter
                """,
                now,
            )
            # Playlist + RandomSub tables: same claim discipline, plaintext ids.
            pl_rows = await con.fetch(
                """
                UPDATE yt_playlists p SET working = TRUE
                FROM yt_channels c
                WHERE c.id = p.channel_id
                  AND p.active AND NOT p.working
                  AND c.label != 'reserved'
                  AND (p.ts IS NULL OR p.ts <= $1)
                RETURNING p.channel_id, c.user_id, p.playlist_id, p.last_seen,
                          p.ts, p.rank, p.counter
                """,
                now,
            )
            rnd_rows = await con.fetch(
                """
                UPDATE yt_randomsubs r SET working = TRUE
                FROM yt_channels c
                WHERE c.id = r.channel_id
                  AND r.active AND NOT r.working
                  AND c.label != 'reserved'
                  AND (r.ts IS NULL OR r.ts <= $1)
                RETURNING r.channel_id, c.user_id, c.url_enc, r.ts, r.rank
                """,
                now,
            )
        subs = await self._to_subs(rows)
        for r in pl_rows:
            subs.append(PgSubscription(
                sub_id=r["channel_id"], user_id=r["user_id"], media="yt",
                kind="playlist", link=r["playlist_id"], last_seen=r["last_seen"],
                ts=r["ts"], rank=r["rank"], counter=r["counter"],
            ))
        for r in rnd_rows:
            key = await vault.get(r["user_id"])
            if key is None:
                await self.release(r["channel_id"])  # D9 pause: don't orphan claims
                continue
            subs.append(PgSubscription(
                sub_id=r["channel_id"], user_id=r["user_id"], media="yt",
                kind="random", link=decrypt(key, r["url_enc"]) or "", last_seen=None,
                ts=r["ts"], rank=r["rank"],
            ))
        return subs

    async def release(self, sub_id: int) -> None:
        """Clear the working flag after a subscription is processed (all tables)."""
        pool = await get_pool()
        async with pool.acquire() as con:
            for table in ("yt_tracking", "yt_playlists", "yt_randomsubs"):
                await con.execute(
                    f"UPDATE {table} SET working = FALSE WHERE channel_id = $1", sub_id
                )

    async def release_stale(self, stale_seconds: int) -> int:
        """Free rows stuck working=true longer than stale_seconds (crash recovery)."""
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE yt_tracking SET working = FALSE "
                "WHERE working = TRUE AND ts IS NOT NULL AND ts < $1",
                int(time.time()) - stale_seconds,
            )
        freed = int(result.split()[-1])
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
                       t.word_enc, t.last_seen_enc, t.ts, t.rank, t.counter
                FROM yt_tracking t
                JOIN yt_channels c ON c.id = t.channel_id
                WHERE t.active AND NOT t.working
                  AND c.label != 'reserved'
                  AND (t.ts IS NULL OR t.ts <= $1)
                """,
                int(time.time()),
            )
        return await self._to_subs(rows)

    async def _to_subs(self, rows) -> List[PgSubscription]:
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


    # ---------------- Feed tier (reads for the frontend, D16/D22) ----------------
    async def sidebar(self, user_id: int) -> Dict[str, Any]:
        """Domain → subdomains tree for the requesting user (D22: reserved
        categories are included but marked inactive; blocked channels hidden)."""
        key = await vault.get(user_id)
        if key is None:
            return {"domains": []}
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT DISTINCT d.name_enc AS d_enc, d.active AS d_active,
                       s.name_enc AS s_enc, s.active AS s_active
                FROM yt_channels c
                JOIN yt_subdomains s ON s.id = c.subdomain_id
                JOIN yt_domains d ON d.id = s.domain_id
                WHERE c.user_id = $1 AND c.label != 'blocked'
                ORDER BY d.name_enc, s.name_enc
                """,
                user_id,
            )
        tree: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            d_name = decrypt(key, r["d_enc"]) or "uncategorized"
            s_name = decrypt(key, r["s_enc"]) or "uncategorized"
            domain = tree.setdefault(
                d_name, {"key": d_name.lower(), "name": d_name,
                         "active": r["d_active"], "subdomains": {}}
            )
            domain["subdomains"][s_name] = {
                "key": s_name.lower(), "name": s_name, "active": r["s_active"]
            }
        domains = []
        for d in tree.values():
            d["subdomains"] = sorted(d["subdomains"].values(), key=lambda s: s["key"])
            domains.append(d)
        return {"domains": sorted(domains, key=lambda d: d["key"])}

    async def channels_view(self, user_id: int, include_blocked: bool = False) -> List[Dict[str, Any]]:
        """Settings/management listing. Blocked included on demand (D22)."""
        key = await vault.get(user_id)
        if key is None:
            return []
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT c.id, c.name_enc, c.url_enc, c.label, c.label_reason_enc,
                       t.rss_id_enc, t.kind,
                       d.name_enc AS d_enc, s.name_enc AS s_enc
                FROM yt_channels c
                LEFT JOIN yt_tracking t ON t.channel_id = c.id
                LEFT JOIN yt_subdomains s ON s.id = c.subdomain_id
                LEFT JOIN yt_domains d ON d.id = s.domain_id
                WHERE c.user_id = $1 AND ($2 OR c.label != 'blocked')
                ORDER BY c.id
                """,
                user_id, include_blocked,
            )
        return [
            {
                "id": r["id"],
                "name": decrypt(key, r["name_enc"]),
                "url": decrypt(key, r["url_enc"]),
                "label": r["label"],
                "label_reason": decrypt(key, r["label_reason_enc"]),
                "rss_id": decrypt(key, r["rss_id_enc"]),
                "kind": r["kind"],
                "domain": decrypt(key, r["d_enc"]) or "uncategorized",
                "subdomain": decrypt(key, r["s_enc"]) or "uncategorized",
            }
            for r in rows
        ]

    # ---------------- Access tier (mutations, D16/D17/D22) ----------------
    async def set_label(
        self, user_id: int, channel_id: int, label: str, reason: Optional[str] = None
    ) -> Result[Dict[str, Any], str]:
        if label not in ("none", "reserved", "blocked"):
            return Failure("label must be none|reserved|blocked")
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE yt_channels SET label = $3, label_reason_enc = $4 "
                "WHERE id = $1 AND user_id = $2",
                channel_id, user_id, label, encrypt(key, reason) if reason else None,
            )
        if result.endswith("0"):
            return Failure("channel not found")
        return Success({"id": channel_id, "label": label})

    async def _get_or_create_category(
        self, con, key: bytes, user_id: int, domain: str, subdomain: Optional[str]
    ) -> Optional[int]:
        """Get-or-create domain (+subdomain); returns subdomain_id or None."""
        d_id = await con.fetchval(
            "INSERT INTO yt_domains (user_id, name_enc, name_hash) VALUES ($1, $2, $3) "
            "ON CONFLICT (user_id, name_hash) DO UPDATE SET user_id = EXCLUDED.user_id "
            "RETURNING id",
            user_id, encrypt(key, domain), index_hash(key, domain.lower()),
        )
        if subdomain is None:
            return None
        return await con.fetchval(
            "INSERT INTO yt_subdomains (domain_id, name_enc, name_hash) VALUES ($1, $2, $3) "
            "ON CONFLICT (domain_id, name_hash) DO UPDATE SET domain_id = EXCLUDED.domain_id "
            "RETURNING id",
            d_id, encrypt(key, subdomain), index_hash(key, subdomain.lower()),
        )

    async def assign_category(
        self, user_id: int, channel_id: int, domain: str, subdomain: Optional[str]
    ) -> Result[Dict[str, Any], str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                s_id = await self._get_or_create_category(con, key, user_id, domain, subdomain)
                result = await con.execute(
                    "UPDATE yt_channels SET subdomain_id = $3 WHERE id = $1 AND user_id = $2",
                    channel_id, user_id, s_id,
                )
        if result.endswith("0"):
            return Failure("channel not found")
        return Success({"id": channel_id, "domain": domain, "subdomain": subdomain})

    async def set_category_active(
        self, user_id: int, domain: str, subdomain: Optional[str], active: bool
    ) -> Result[Dict[str, Any], str]:
        """The D22 life-phase switch, category level. Deactivating a domain
        cascades to its subdomains (owner's hierarchical deactivation)."""
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                d_id = await con.fetchval(
                    "SELECT id FROM yt_domains WHERE user_id = $1 AND name_hash = $2",
                    user_id, index_hash(key, domain.lower()),
                )
                if d_id is None:
                    return Failure("domain not found")
                if subdomain is None:
                    await con.execute(
                        "UPDATE yt_domains SET active = $2 WHERE id = $1", d_id, active
                    )
                    await con.execute(
                        "UPDATE yt_subdomains SET active = $2 WHERE domain_id = $1", d_id, active
                    )
                    return Success({"domain": domain, "cascade": True, "active": active})
                s_row = await con.fetchval(
                    "UPDATE yt_subdomains SET active = $3 WHERE domain_id = $1 AND name_hash = $2 "
                    "RETURNING id",
                    d_id, index_hash(key, subdomain.lower()), active,
                )
                if s_row is None:
                    return Failure("subdomain not found")
                return Success({"domain": domain, "subdomain": subdomain, "active": active})

    async def delete_channel(self, user_id: int, channel_id: int) -> Result[Dict[str, Any], str]:
        """Delete channel + everything (FK CASCADE: tracking, videos)."""
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "DELETE FROM yt_channels WHERE id = $1 AND user_id = $2", channel_id, user_id
            )
        if result.endswith("0"):
            return Failure("channel not found")
        return Success({"deleted": channel_id})

    async def add_playlist(
        self, user_id: int, playlist_id: str, channel_name: str, channel_url: str
    ) -> Result[int, str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                channel_id = await self._get_or_create_channel(con, key, user_id, channel_name, channel_url)
                await con.execute(
                    "INSERT INTO yt_playlists (channel_id, playlist_id) VALUES ($1, $2) "
                    "ON CONFLICT (channel_id) DO UPDATE SET playlist_id = EXCLUDED.playlist_id",
                    channel_id, playlist_id,
                )
        return Success(channel_id)

    async def add_random(
        self, user_id: int, channel_name: str, channel_url: str, rank: str = "week"
    ) -> Result[int, str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                channel_id = await self._get_or_create_channel(con, key, user_id, channel_name, channel_url)
                await con.execute(
                    "INSERT INTO yt_randomsubs (channel_id, rank) VALUES ($1, $2) "
                    "ON CONFLICT (channel_id) DO UPDATE SET rank = EXCLUDED.rank",
                    channel_id, rank,
                )
        return Success(channel_id)


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
