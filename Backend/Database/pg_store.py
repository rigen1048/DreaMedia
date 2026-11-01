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
    claim_token: Optional[int] = None   # claimed_at at claim time — release must match


class PgStore:
    """Yt-facing Postgres store (Ani store lands with the Ani pipeline)."""

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

    async def add_tracking(
        self,
        user_id: int,
        rss_id: str,
        channel_name: str,
        channel_url: str,
        kind: str = "tracking",
        words: Optional[List[str]] = None,
        logo: Optional[str] = None,
    ) -> Result[int, str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked for user (login required, D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                channel_id = await self._get_or_create_channel(con, key, user_id, channel_name, channel_url, logo)
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
                UPDATE yt_tracking t SET working = TRUE, claimed_at = EXTRACT(EPOCH FROM NOW())::BIGINT
                FROM yt_channels c
                WHERE c.id = t.channel_id
                  AND t.active AND NOT t.working
                  AND c.label != 'reserved'           -- D22 life-phase switch
                  AND (t.ts IS NULL OR t.ts <= $1)
                RETURNING t.channel_id, c.user_id, t.rss_id_enc, t.kind,
                          t.word_enc, t.last_seen_enc, t.ts, t.rank, t.counter, t.claimed_at, t.claimed_at
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
                )
            )
        return (due, skipped) if return_skipped else due

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
                SELECT v.id, v.channel_id, v.title_enc, v.url_enc, v.thumbnail_enc, v.published_at, v.seen,
                       c.name_enc AS channel_enc, c.logo_enc AS channel_logo_enc
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
                "id": r["id"],
                "channel_id": r["channel_id"],
                "title": decrypt(key, r["title_enc"]),
                "url": decrypt(key, r["url_enc"]),
                "thumbnail": decrypt(key, r["thumbnail_enc"]),
                "published_at": r["published_at"],
                "seen": r["seen"],
                "channel": decrypt(key, r["channel_enc"]),
                "channel_logo": decrypt(key, r["channel_logo_enc"]),
            }
            for r in rows
        ]


    async def refresh_random(self, user_id: int, channel_id: int) -> Result[PgSubscription, str]:
        """D53 manual random refresh: clear this channel's random feed and
        reschedule from today. Returns the sub for an immediate pipeline run."""
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            row = await con.fetchrow(
                "SELECT r.rank, c.url_enc FROM yt_randomsubs r "
                "JOIN yt_channels c ON c.id = r.channel_id "
                "WHERE r.channel_id = $1 AND c.user_id = $2",
                channel_id, user_id,
            )
            if row is None:
                return Failure("no random subscription on this channel")
            await con.execute("DELETE FROM yt_videos WHERE channel_id = $1", channel_id)
            await con.execute(
                "UPDATE yt_randomsubs SET ts = $2, working = FALSE, claimed_at = NULL "
                "WHERE channel_id = $1",
                channel_id, int(time.time()),
            )
        return Success(PgSubscription(
            sub_id=channel_id, user_id=user_id, media="yt", kind="random",
            link=decrypt(key, row["url_enc"]) or "", last_seen=None, rank=row["rank"],
        ))

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
        """Management listing across ALL subscription kinds (frontend AI P1):
        kind, active flag, rank/frequency, wordscan terms; blocked on demand (D22)."""
        key = await vault.get(user_id)
        if key is None:
            return []
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT c.id, c.name_enc, c.url_enc, c.logo_enc, c.label, c.label_reason_enc,
                       d.name_enc AS d_enc, s.name_enc AS s_enc,
                       t.rss_id_enc, t.kind AS t_kind, t.word_enc, t.rank AS t_rank, t.active AS t_active,
                       p.rank AS p_rank, p.active AS p_active,
                       r.rank AS r_rank, r.active AS r_active
                FROM yt_channels c
                LEFT JOIN yt_tracking t ON t.channel_id = c.id
                LEFT JOIN yt_playlists p ON p.channel_id = c.id
                LEFT JOIN yt_randomsubs r ON r.channel_id = c.id
                LEFT JOIN yt_subdomains s ON s.id = c.subdomain_id
                LEFT JOIN yt_domains d ON d.id = s.domain_id
                WHERE c.user_id = $1 AND ($2 OR c.label != 'blocked')
                ORDER BY c.id
                """,
                user_id, include_blocked,
            )
        result = []
        for r in rows:
            words_raw = decrypt(key, r["word_enc"]) if r["word_enc"] else None
            if r["t_kind"]:
                kind, rank, active = r["t_kind"], r["t_rank"], r["t_active"]
            elif r["p_rank"] is not None or r["p_active"] is not None:
                kind, rank, active = "playlist", r["p_rank"], r["p_active"]
            elif r["r_rank"] is not None or r["r_active"] is not None:
                kind, rank, active = "random", r["r_rank"], r["r_active"]
            else:
                kind, rank, active = None, None, None
            result.append({
                "id": r["id"],
                "name": decrypt(key, r["name_enc"]),
                "url": decrypt(key, r["url_enc"]),
                "label": r["label"],
                "logo": decrypt(key, r["logo_enc"]),
                "label_reason": decrypt(key, r["label_reason_enc"]),
                "rss_id": decrypt(key, r["rss_id_enc"]),
                "kind": kind,
                "active": active,
                "rank": rank,
                "words": words_raw.split(",") if words_raw else [],
                "domain": decrypt(key, r["d_enc"]) or "uncategorized",
                "subdomain": decrypt(key, r["s_enc"]) or "uncategorized",
            })
        return result

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
        self, user_id: int, playlist_id: str, channel_name: str, channel_url: str,
        logo: Optional[str] = None,
    ) -> Result[int, str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                channel_id = await self._get_or_create_channel(con, key, user_id, channel_name, channel_url, logo)
                await con.execute(
                    "INSERT INTO yt_playlists (channel_id, playlist_id) VALUES ($1, $2) "
                    "ON CONFLICT (channel_id) DO UPDATE SET playlist_id = EXCLUDED.playlist_id",
                    channel_id, playlist_id,
                )
        return Success(channel_id)

    async def add_random(
        self, user_id: int, channel_name: str, channel_url: str, rank: str = "week",
        logo: Optional[str] = None,
    ) -> Result[int, str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                channel_id = await self._get_or_create_channel(con, key, user_id, channel_name, channel_url, logo)
                await con.execute(
                    "INSERT INTO yt_randomsubs (channel_id, rank) VALUES ($1, $2) "
                    "ON CONFLICT (channel_id) DO UPDATE SET rank = EXCLUDED.rank",
                    channel_id, rank,
                )
        return Success(channel_id)



    # ---------------- seen writes + mode switch + active (frontend AI P1) ----------------
    async def mark_videos_seen(
        self, user_id: int, video_ids: List[int], seen: bool = True
    ) -> int:
        """Single/bulk seen write, ownership-checked. Returns rows changed."""
        if not video_ids:
            return 0
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                """
                UPDATE yt_videos v SET seen = $3
                FROM yt_channels c
                WHERE c.id = v.channel_id AND c.user_id = $1 AND v.id = ANY($2)
                """,
                user_id, video_ids, seen,
            )
        return int(result.split()[-1])

    async def switch_mode(
        self,
        user_id: int,
        channel_id: int,
        kind: str,
        words: Optional[List[str]] = None,
        rank: Optional[str] = None,
    ) -> Result[Dict[str, Any], str]:
        """Transactional exclusive mode switch (P1): removes rows from the
        other subscription tables, upserts into the target one. A channel
        lives in exactly ONE mode (D30 spirit)."""
        if kind not in ("tracking", "wordscan", "playlist", "random"):
            return Failure("kind must be tracking|wordscan|playlist|random")
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                owner = await con.fetchval(
                    "SELECT 1 FROM yt_channels WHERE id = $1 AND user_id = $2",
                    channel_id, user_id,
                )
                if not owner:
                    return Failure("channel not found")
                if kind in ("tracking", "wordscan"):
                    rss_id = await con.fetchval(
                        "SELECT rss_id_enc FROM yt_tracking WHERE channel_id = $1", channel_id
                    )
                    if rss_id is None:
                        return Failure("no RSS link on this channel to switch into tracking/wordscan")
                    await con.execute("DELETE FROM yt_playlists WHERE channel_id = $1", channel_id)
                    await con.execute("DELETE FROM yt_randomsubs WHERE channel_id = $1", channel_id)
                    await con.execute(
                        "UPDATE yt_tracking SET kind = $2, word_enc = $3 WHERE channel_id = $1",
                        channel_id, kind, encrypt(key, ",".join(words)) if words else None,
                    )
                elif kind == "playlist":
                    return Failure("switching to playlist requires re-subscribing with the playlist link")
                else:  # random
                    await con.execute("DELETE FROM yt_tracking WHERE channel_id = $1", channel_id)
                    await con.execute("DELETE FROM yt_playlists WHERE channel_id = $1", channel_id)
                    await con.execute(
                        "INSERT INTO yt_randomsubs (channel_id, rank) VALUES ($1, $2) "
                        "ON CONFLICT (channel_id) DO UPDATE SET rank = EXCLUDED.rank",
                        channel_id, rank or "week",
                    )
        return Success({"id": channel_id, "kind": kind})

    async def set_channel_active(
        self, user_id: int, channel_id: int, active: bool
    ) -> Result[Dict[str, Any], str]:
        """Channel active switch = reserved label (D22). Never touches blocked."""
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE yt_channels SET label = $3 WHERE id = $1 AND user_id = $2 "
                "AND label != 'blocked'",
                channel_id, user_id, "none" if active else "reserved",
            )
        if result.endswith("0"):
            return Failure("channel not found (or blocked)")
        return Success({"id": channel_id, "active": active})

    # ---------------- category CRUD (P1) ----------------
    async def list_categories(self, user_id: int) -> Dict[str, Any]:
        """All domains/subdomains, including unused ones (sidebar only shows used)."""
        key = await vault.get(user_id)
        if key is None:
            return {"domains": []}
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT d.id AS d_id, d.name_enc AS d_enc, d.active AS d_active,
                       s.id AS s_id, s.name_enc AS s_enc, s.active AS s_active
                FROM yt_domains d
                LEFT JOIN yt_subdomains s ON s.domain_id = d.id
                WHERE d.user_id = $1
                ORDER BY d.id, s.id
                """,
                user_id,
            )
        domains: Dict[int, Dict[str, Any]] = {}
        for r in rows:
            entry = domains.setdefault(
                r["d_id"],
                {"id": r["d_id"], "name": decrypt(key, r["d_enc"]),
                 "active": r["d_active"], "subdomains": []},
            )
            if r["s_id"] is not None:
                entry["subdomains"].append(
                    {"id": r["s_id"], "name": decrypt(key, r["s_enc"]), "active": r["s_active"]}
                )
        return {"domains": list(domains.values())}

    async def create_category(
        self, user_id: int, domain: str, subdomain: Optional[str] = None
    ) -> Result[Dict[str, Any], str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            s_id = await self._get_or_create_category(con, key, user_id, domain, subdomain)
        return Success({"domain": domain, "subdomain": subdomain, "subdomain_id": s_id})

    async def rename_category(
        self,
        user_id: int,
        domain: str,
        new_name: str,
        subdomain: Optional[str] = None,
    ) -> Result[Dict[str, Any], str]:
        """Quick rename: all channels keep their assignment; only the name changes."""
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            if subdomain is None:
                result = await con.execute(
                    "UPDATE yt_domains SET name_enc = $3, name_hash = $4 "
                    "WHERE user_id = $1 AND name_hash = $2",
                    user_id, index_hash(key, domain.lower()),
                    encrypt(key, new_name), index_hash(key, new_name.lower()),
                )
            else:
                result = await con.execute(
                    "UPDATE yt_subdomains s SET name_enc = $4, name_hash = $5 "
                    "FROM yt_domains d "
                    "WHERE s.domain_id = d.id AND d.user_id = $1 "
                    "AND d.name_hash = $2 AND s.name_hash = $3",
                    user_id, index_hash(key, domain.lower()),
                    index_hash(key, subdomain.lower()),
                    encrypt(key, new_name), index_hash(key, new_name.lower()),
                )
        if result.endswith("0"):
            return Failure("category not found")
        return Success({"renamed": domain if subdomain is None else f"{domain}/{subdomain}", "to": new_name})

    async def delete_category(
        self, user_id: int, domain: str, subdomain: Optional[str] = None
    ) -> Result[Dict[str, Any], str]:
        """Delete a category. Channels under it detach (ON DELETE SET NULL)."""
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            if subdomain is None:
                result = await con.execute(
                    "DELETE FROM yt_domains WHERE user_id = $1 AND name_hash = $2",
                    user_id, index_hash(key, domain.lower()),
                )
            else:
                result = await con.execute(
                    "DELETE FROM yt_subdomains s USING yt_domains d "
                    "WHERE s.domain_id = d.id AND d.user_id = $1 "
                    "AND d.name_hash = $2 AND s.name_hash = $3",
                    user_id, index_hash(key, domain.lower()),
                    index_hash(key, subdomain.lower()),
                )
        if result.endswith("0"):
            return Failure("category not found")
        return Success({"deleted": domain if subdomain is None else f"{domain}/{subdomain}"})


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
