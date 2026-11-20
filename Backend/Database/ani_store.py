"""Ani-facing Postgres store — entries, season cache, schedule claims, events.

Same patterns as PgStore (blind indexes, vault-gated decryption, D9 pause,
crash-safe working claims). Event payloads are encrypted per-user (D8);
tier (awaited/unwatched, D21) travels in plaintext — it's a render hint,
not content.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import asyncpg
from returns.result import Failure, Result, Success

from Database import vault
from Database.crypto import decrypt, encrypt, index_hash
from Database.db import get_pool
from Model.video import FetchPayload
from Utility.logs import log


@dataclass
class AniDue:
    entry_id: int
    season_no: int
    user_id: int
    title: str            # search title for the chain fetch
    state: str
    watched: bool
    next_check_ts: Optional[int]
    claim_token: Optional[int] = None   # claimed_at at claim time — release must match


class AniStore:
    # ---------------- writes ----------------
    async def add_entry(
        self,
        user_id: int,
        first_season_anilist_id: int,
        title: str,
        cover: Optional[str],
        payload: FetchPayload,
        list_kind: str = "watching",
        anime_type: Optional[str] = None,
        subdomain_id: Optional[int] = None,
    ) -> Result[int, str]:
        """Insert an entry + its season cache + schedule rows."""
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked for user (login required, D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                entry_id = await con.fetchval(
                    "INSERT INTO ani_entries (user_id, anilist_id, title_enc, cover_enc, list, "
                    "anime_type, subdomain_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
                    user_id, first_season_anilist_id,
                    encrypt(key, title), encrypt(key, cover), list_kind,
                    anime_type, subdomain_id,
                )
                await self._upsert_seasons(con, key, entry_id, payload)
                if list_kind == "up_to_date":
                    # "Watched everything released" (cleanup #1 example):
                    # every season with aired content starts watched.
                    await con.execute(
                        "UPDATE ani_seasons SET watched = TRUE "
                        "WHERE entry_id = $1 AND episodes_aired > 0",
                        entry_id,
                    )
        return Success(entry_id)

    async def _upsert_seasons(self, con, key: bytes, entry_id: int, payload: FetchPayload) -> None:
        for season_no, video in payload[0].items():
            await con.execute(
                """
                INSERT INTO ani_seasons
                    (entry_id, season_no, anilist_id, title_enc, poster_enc,
                     status, episodes_total, episodes_aired, start_date,
                     next_airing_at, next_airing_ep)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                ON CONFLICT (entry_id, season_no) DO UPDATE SET
                    title_enc = EXCLUDED.title_enc, poster_enc = EXCLUDED.poster_enc,
                    status = EXCLUDED.status,
                    episodes_total = EXCLUDED.episodes_total,
                    episodes_aired = EXCLUDED.episodes_aired,
                    start_date = EXCLUDED.start_date,
                    next_airing_at = EXCLUDED.next_airing_at,
                    next_airing_ep = EXCLUDED.next_airing_ep
                """,
                entry_id, season_no, int(video["id"]),
                encrypt(key, video.get("title")),
                encrypt(key, video.get("thumbnail") or ""),
                video.get("status"),
                video.get("episodes"),
                _aired(video),
                video.get("published") or None,
                (video.get("next_airing") or {}).get("airingAt"),
                (video.get("next_airing") or {}).get("episode"),
            )
            await con.execute(
                "INSERT INTO ani_schedule (entry_id, season_no, next_check_ts) "
                "VALUES ($1, $2, NULL) ON CONFLICT DO NOTHING",
                entry_id, season_no,
            )
            # Global catalog cache (cleanup #1): public AniList facts, one row
            # per anilist_id, shared by all users — per-user snapshots stay in
            # ani_seasons so change detection remains per-user.
            await con.execute(
                """
                INSERT INTO ani_metadata
                    (anilist_id, season_no, title, format, episodes_total,
                     episodes_aired, status, start_date, release_date,
                     next_airing_at, next_airing_ep, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
                ON CONFLICT (anilist_id) DO UPDATE SET
                    season_no = EXCLUDED.season_no, title = EXCLUDED.title,
                    format = EXCLUDED.format,
                    episodes_total = EXCLUDED.episodes_total,
                    episodes_aired = EXCLUDED.episodes_aired,
                    status = EXCLUDED.status, start_date = EXCLUDED.start_date,
                    release_date = EXCLUDED.release_date,
                    next_airing_at = EXCLUDED.next_airing_at,
                    next_airing_ep = EXCLUDED.next_airing_ep,
                    updated_at = now()
                """,
                int(video["id"]), season_no, video.get("title"),
                video.get("format"), video.get("episodes"), _aired(video),
                video.get("status"), video.get("published") or None,
                None,  # release_date: set by pipeline release events
                (video.get("next_airing") or {}).get("airingAt"),
                (video.get("next_airing") or {}).get("episode"),
            )

    async def refresh_seasons(self, user_id: int, entry_id: int, payload: FetchPayload) -> None:
        key = await vault.get(user_id)
        if key is None:
            return
        pool = await get_pool()
        async with pool.acquire() as con:
            # The row can vanish between scheduling and running: the user deleted
            # the entry, or a restore replaced the database under the workers.
            # Writing seasons then trips the foreign key, so skip instead.
            if not await con.fetchval(
                "SELECT 1 FROM ani_entries WHERE id = $1 AND user_id = $2", entry_id, user_id
            ):
                return
            async with con.transaction():
                await self._upsert_seasons(con, key, entry_id, payload)

    async def get_season(self, entry_id: int, season_no: int) -> Optional[Dict[str, Any]]:
        pool = await get_pool()
        async with pool.acquire() as con:
            row = await con.fetchrow(
                "SELECT * FROM ani_seasons WHERE entry_id = $1 AND season_no = $2",
                entry_id, season_no,
            )
        return dict(row) if row else None

    async def update_season_state(
        self, entry_id: int, season_no: int, *, state: Optional[str] = None,
        release_date: Optional[str] = None,
    ) -> None:
        pool = await get_pool()
        async with pool.acquire() as con:
            await con.execute(
                "UPDATE ani_seasons SET state = COALESCE($3, state), "
                "release_date = COALESCE($4, release_date) "
                "WHERE entry_id = $1 AND season_no = $2",
                entry_id, season_no, state, release_date,
            )

    async def set_next_check(self, entry_id: int, season_no: int, ts: Optional[int]) -> None:
        pool = await get_pool()
        async with pool.acquire() as con:
            await con.execute(
                "UPDATE ani_schedule SET next_check_ts = $3 WHERE entry_id = $1 AND season_no = $2",
                entry_id, season_no, ts,
            )

    async def emit_event(
        self,
        user_id: int,
        entry_id: int,
        season_no: Optional[int],
        kind: str,
        tier: str,
        payload: Dict[str, Any],
    ) -> None:
        """Feed event row (D18/D21). Dedupes identical unseen events."""
        key = await vault.get(user_id)
        if key is None:
            return
        blob = encrypt(key, json.dumps(payload, default=str))
        # Deterministic event identity — ciphertext can never dedupe because
        # every encrypt() uses a fresh random nonce (2026 review repro: 2 rows).
        event_hash = index_hash(
            key,
            f"{entry_id}|{season_no}|{kind}|"
            + json.dumps(payload, sort_keys=True, default=str),
        )
        title = None
        pool = await get_pool()
        async with pool.acquire() as con:
            exists = await con.fetchval(
                "SELECT 1 FROM ani_events WHERE event_hash = $1", event_hash,
            )
            if exists:
                return
            try:
                await con.execute(
                    "INSERT INTO ani_events (entry_id, season_no, kind, tier, event_hash, payload_enc) "
                    "VALUES ($1, $2, $3, $4, $5, $6)",
                    entry_id, season_no, kind, tier, event_hash, blob,
                )
            except asyncpg.UniqueViolationError:
                return
            title_enc = await con.fetchval(
                "SELECT title_enc FROM ani_entries WHERE id = $1", entry_id
            )
            if title_enc is not None:
                title = decrypt(key, title_enc)
        log.info("ani event: %s entry=%s season=%s tier=%s", kind, entry_id, season_no, tier)
        # Backend message lane: release/change notifications for the bell.
        from Utility.notify import notify_ani_release

        await notify_ani_release(
            user_id, entry_id, title or "Anime", season_no, kind, payload
        )

    # ---------------- Trashbin (D57) ----------------
    async def trash_events(self, user_id: int, event_ids: List[int]) -> int:
        """Opening an event trashes it (seen + 24h purge window)."""
        if not event_ids:
            return 0
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE ani_events SET seen = TRUE, trashed_at = now() "
                "WHERE id = ANY($1) AND user_id = $2",
                event_ids, user_id,
            )
        return int(result.split()[-1])

    async def restore_events(self, user_id: int, event_ids: List[int]) -> int:
        if not event_ids:
            return 0
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE ani_events SET trashed_at = NULL "
                "WHERE id = ANY($1) AND user_id = $2",
                event_ids, user_id,
            )
        return int(result.split()[-1])

    async def trash_feed(self, user_id: int, limit: int = 200) -> List[Dict[str, Any]]:
        key = await vault.get(user_id)
        if key is None:
            return []
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT ev.id, ev.entry_id, ev.season_no, ev.kind, ev.tier, ev.seen,
                       ev.created_at, ev.trashed_at, ev.payload_enc, e.title_enc, e.cover_enc
                FROM ani_events ev JOIN ani_entries e ON e.id = ev.entry_id
                WHERE ev.user_id = $1 AND ev.trashed_at IS NOT NULL
                ORDER BY ev.trashed_at DESC LIMIT $2
                """,
                user_id, limit,
            )
        return [
            {
                "id": r["id"], "entry_id": r["entry_id"], "season_no": r["season_no"],
                "kind": r["kind"], "tier": r["tier"], "seen": r["seen"],
                "created_at": r["created_at"].isoformat(),
                "trashed_at": int(r["trashed_at"].timestamp()),
                "payload": decrypt(key, r["payload_enc"]) or "{}",
                "title": decrypt(key, r["title_enc"]), "cover": decrypt(key, r["cover_enc"]),
            }
            for r in rows
        ]

    async def purge_trash(self, older_than_seconds: int = 86400) -> int:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "DELETE FROM ani_events WHERE trashed_at < now() - make_interval(secs => $1)",
                older_than_seconds,
            )
        return int(result.split()[-1])

    # ---------------- Access tier (D16 mutations) ----------------
    async def update_entry(
        self,
        user_id: int,
        entry_id: int,
        *,
        label: Optional[str] = None,
        label_reason: Optional[str] = None,
        list_kind: Optional[str] = None,
        notify_release: Optional[bool] = None,
        active: Optional[bool] = None,
        canon_only: Optional[bool] = None,
        watch_state: Optional[str] = None,
        anime_type: Optional[str] = None,
        subdomain_id: Optional[int] = None,
        clear_category: bool = False,
    ) -> Result[Dict[str, Any], str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                """
                UPDATE ani_entries SET
                    label = COALESCE($3, label),
                    label_reason_enc = COALESCE($4, label_reason_enc),
                    list = COALESCE($5, list),
                    notify_release = COALESCE($6, notify_release),
                    active = COALESCE($7, active),
                    canon_only = COALESCE($8, canon_only),
                    watch_state = COALESCE($9, watch_state),
                    anime_type = COALESCE($10, anime_type),
                    subdomain_id = CASE WHEN $11 THEN NULL ELSE COALESCE($12, subdomain_id) END
                WHERE id = $1 AND user_id = $2
                """,
                entry_id, user_id, label,
                encrypt(key, label_reason) if label_reason else None,
                list_kind, notify_release, active,
                canon_only, watch_state, anime_type,
                clear_category, subdomain_id,
            )
        if result.endswith("0"):
            return Failure("entry not found")
        return Success({"id": entry_id})

    async def set_season_watched(
        self, user_id: int, entry_id: int, season_no: int, watched: bool
    ) -> Result[Dict[str, Any], str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE ani_seasons SET watched = $4 WHERE entry_id = $1 AND season_no = $2 "
                "AND EXISTS (SELECT 1 FROM ani_entries WHERE id = $1 AND user_id = $3)",
                entry_id, season_no, user_id, watched,
            )
        if result.endswith("0"):
            return Failure("season not found")
        return Success({"entry_id": entry_id, "season_no": season_no, "watched": watched})

    async def delete_entry(self, user_id: int, entry_id: int) -> Result[Dict[str, Any], str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "DELETE FROM ani_entries WHERE id = $1 AND user_id = $2", entry_id, user_id
            )
        if result.endswith("0"):
            return Failure("entry not found")
        return Success({"deleted": entry_id})

    # ---------------- scheduling ----------------
    async def claim_due(self) -> List[AniDue]:
        now = int(time.time())
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                UPDATE ani_schedule s SET working = TRUE, claimed_at = EXTRACT(EPOCH FROM NOW())::BIGINT
                FROM ani_entries e
                WHERE e.id = s.entry_id
                  AND e.active AND NOT s.working
                  AND (s.next_check_ts IS NULL OR s.next_check_ts <= $1)
                RETURNING s.entry_id, s.season_no, e.user_id, e.title_enc,
                          s.next_check_ts, s.claimed_at,
                          (SELECT st.state FROM ani_seasons st
                            WHERE st.entry_id = s.entry_id AND st.season_no = s.season_no) AS state,
                          (SELECT st.watched FROM ani_seasons st
                            WHERE st.entry_id = s.entry_id AND st.season_no = s.season_no) AS watched
                """,
                now,
            )
        due: List[AniDue] = []
        for r in rows:
            key = await vault.get(r["user_id"])
            if key is None:
                # D9 pause: release the claim so it isn't orphaned.
                await self.release(r["entry_id"], r["season_no"], r["claimed_at"])
                continue
            due.append(
                AniDue(
                    entry_id=r["entry_id"], season_no=r["season_no"],
                    user_id=r["user_id"],
                    title=decrypt(key, r["title_enc"]) or "",
                    state=r["state"] or "unknown",
                    watched=bool(r["watched"]),
                    next_check_ts=r["next_check_ts"],
                    claim_token=r["claimed_at"],
                )
            )
        return due

    async def release(self, entry_id: int, season_no: int,
                      claim_token: Optional[int] = None) -> None:
        """With claim_token, only THAT claim is cleared — a late-finishing old
        worker cannot clear a newer worker's claim (2026 review fix)."""
        pool = await get_pool()
        async with pool.acquire() as con:
            if claim_token is None:
                await con.execute(
                    "UPDATE ani_schedule SET working = FALSE WHERE entry_id = $1 AND season_no = $2",
                    entry_id, season_no,
                )
            else:
                await con.execute(
                    "UPDATE ani_schedule SET working = FALSE "
                    "WHERE entry_id = $1 AND season_no = $2 "
                    "AND claimed_at IS NOT DISTINCT FROM $3",
                    entry_id, season_no, claim_token,
                )

    async def release_stale(self, stale_seconds: int) -> int:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE ani_schedule SET working = FALSE "
                "WHERE working = TRUE AND claimed_at IS NOT NULL AND claimed_at < $1",
                int(time.time()) - stale_seconds,
            )
        freed = int(result.split()[-1])
        if freed:
            log.warning("ani: released %s stale claim(s)", freed)
        return freed

    async def next_due_ts(self) -> Optional[int]:
        pool = await get_pool()
        async with pool.acquire() as con:
            return await con.fetchval(
                "SELECT MIN(s.next_check_ts) FROM ani_schedule s "
                "JOIN ani_entries e ON e.id = s.entry_id "
                "WHERE e.active AND NOT s.working AND s.next_check_ts IS NOT NULL"
            )

    # ---------------- feed reads ----------------
    async def events_feed(self, user_id: int, include_seen: bool = False) -> List[Dict[str, Any]]:
        """Anime events + the owning entry's display metadata, so each event
        is a complete notification row without a second round-trip."""
        key = await vault.get(user_id)
        if key is None:
            return []
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT e.id, e.entry_id, e.season_no, e.kind, e.tier, e.payload_enc, e.seen, e.created_at,
                       a.title_enc, a.cover_enc, a.anime_type, a.notify_release, a.label,
                       COALESCE(sd.notify, TRUE) AND COALESCE(d.notify, TRUE) AS category_notify,
                       sd.name_enc AS sd_enc, d.name_enc AS d_enc
                FROM ani_events e
                JOIN ani_entries a ON a.id = e.entry_id
                LEFT JOIN ani_subdomains sd ON sd.id = a.subdomain_id
                LEFT JOIN ani_domains d ON d.id = sd.domain_id
                WHERE a.user_id = $1 AND ($2 OR NOT e.seen)
                  AND e.trashed_at IS NULL              -- D57 trashbin
                ORDER BY e.created_at DESC
                """,
                user_id, include_seen,
            )
        return [
            {
                "id": r["id"], "entry_id": r["entry_id"], "season_no": r["season_no"],
                "kind": r["kind"], "tier": r["tier"], "seen": r["seen"],
                "created_at": r["created_at"].isoformat(),
                "payload": json.loads(decrypt(key, r["payload_enc"]) or "{}"),
                "title": decrypt(key, r["title_enc"]),
                "cover": decrypt(key, r["cover_enc"]),
                "anime_type": r["anime_type"],
                "domain": decrypt(key, r["d_enc"]) or "uncategorized",
                "subdomain": decrypt(key, r["sd_enc"]) or "uncategorized",
                "notify_enabled": bool(
                    r["notify_release"] and r["category_notify"] and r["label"] == "none"
                ),
            }
            for r in rows
        ]

    async def management_view(
        self, user_id: int, include_blocked: bool = False
    ) -> List[Dict[str, Any]]:
        """Management + Todo read model: entries with card metadata (type,
        release, airing time, season/episode counts, cursor) and categories."""
        key = await vault.get(user_id)
        if key is None:
            return []
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT a.id, a.title_enc, a.cover_enc, a.label, a.label_reason_enc,
                       a.list, a.watch_state, a.active, a.notify_release,
                       a.canon_only, a.cursor_season, a.cursor_episode, a.cursor_position_seconds,
                       a.anime_type, a.airing_time, a.subdomain_id,
                       s.season_no, s.title_enc AS s_title_enc, s.poster_enc AS s_poster_enc, s.status, s.episodes_total,
                       s.episodes_aired, s.state, s.watched, s.start_date, s.release_date,
                       s.next_airing_at, s.next_airing_ep,
                       d.id AS d_id, d.name_enc AS d_enc, d.notify AS d_notify,
                       sd.id AS sd_id, sd.name_enc AS sd_enc, sd.notify AS sd_notify
                FROM ani_entries a
                LEFT JOIN ani_seasons s ON s.entry_id = a.id
                LEFT JOIN ani_subdomains sd ON sd.id = a.subdomain_id
                LEFT JOIN ani_domains d ON d.id = sd.domain_id
                WHERE a.user_id = $1 AND ($2 OR a.label != 'blocked')
                ORDER BY a.id, s.season_no
                """,
                user_id, include_blocked,
            )
        entries: Dict[int, Dict[str, Any]] = {}
        for r in rows:
            entry = entries.setdefault(
                r["id"],
                {
                    "id": r["id"], "title": decrypt(key, r["title_enc"]),
                    "cover": decrypt(key, r["cover_enc"]),
                    "label": r["label"],
                    "label_reason": decrypt(key, r["label_reason_enc"]),
                    "list": r["list"], "watch_state": r["watch_state"],
                    "active": r["active"],
                    "notify_release": r["notify_release"],
                    "canon_only": r["canon_only"],
                    "anime_type": r["anime_type"],
                    "airing_time": r["airing_time"],
                    "domain_id": r["d_id"],
                    "subdomain_id": r["sd_id"],
                    "domain": decrypt(key, r["d_enc"]) or "uncategorized",
                    "subdomain": decrypt(key, r["sd_enc"]) or "uncategorized",
                    "category_notify": bool(
                        r["d_notify"] is not False and r["sd_notify"] is not False
                    ),
                    "cursor": {
                        "season": r["cursor_season"], "episode": r["cursor_episode"],
                        "position_seconds": r["cursor_position_seconds"],
                    },
                    "seasons": [], "total_seasons": 0,
                },
            )
            if r["season_no"] is not None:
                entry["seasons"].append(
                    {
                        "season_no": r["season_no"],
                        "title": decrypt(key, r["s_title_enc"]),
                        "poster": decrypt(key, r["s_poster_enc"]) or None,
                        "status": r["status"],
                        "episodes_total": r["episodes_total"],
                        "episodes_aired": r["episodes_aired"],
                        "state": r["state"], "watched": r["watched"],
                        "start_date": r["start_date"], "release_date": r["release_date"],
                        "next_airing_at": r["next_airing_at"],
                        "next_airing_ep": r["next_airing_ep"],
                    }
                )
        for entry in entries.values():
            entry["total_seasons"] = len(entry["seasons"])
            entry["episode_count"] = sum(s["episodes_total"] or 0 for s in entry["seasons"])
            entry["aired_count"] = sum(s["episodes_aired"] or 0 for s in entry["seasons"])
            entry["watched_seasons"] = sum(1 for s in entry["seasons"] if s["watched"])
            entry["notify_enabled"] = bool(
                entry["notify_release"]
                and entry["category_notify"]
                and entry["label"] == "none"
                and entry["active"]
            )
            entry["release_date"] = next(
                (s["release_date"] for s in entry["seasons"] if s["release_date"]), None
            )
            entry["next_airing_at"] = next(
                (s["next_airing_at"] for s in entry["seasons"] if s["next_airing_at"]), None
            )
            entry["next_airing_ep"] = next(
                (s["next_airing_ep"] for s in entry["seasons"] if s["next_airing_ep"]), None
            )
            entry["current_season"] = entry["cursor"]["season"] or 1
            entry["current_episode"] = entry["cursor"]["episode"]
        return list(entries.values())

    # ---------------- seen events (frontend AI P1) ----------------
    async def mark_events_seen(self, user_id: int, event_ids: List[int], seen: bool = True) -> int:
        """Bulk seen write on the events feed, ownership-checked."""
        if not event_ids:
            return 0
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                """
                UPDATE ani_events e SET seen = $3
                FROM ani_entries a
                WHERE a.id = e.entry_id AND a.user_id = $1 AND e.id = ANY($2)
                """,
                user_id, event_ids, seen,
            )
        return int(result.split()[-1])

    # ---------------- D44 cursor (linear, fragmentation rejected) ----------------
    async def set_cursor(
        self,
        user_id: int,
        entry_id: int,
        season: int,
        episode: Optional[int] = None,
        position_seconds: Optional[int] = None,
    ) -> Result[Dict[str, Any], str]:
        """Move the watch cursor. Linear-forward only: the new cursor must be
        >= the old one in (season, episode) order — fragmented watching is
        rejected by design (D44)."""
        pool = await get_pool()
        async with pool.acquire() as con:
            row = await con.fetchrow(
                "SELECT cursor_season, cursor_episode FROM ani_entries WHERE id = $1 AND user_id = $2",
                entry_id, user_id,
            )
            if row is None:
                return Failure("entry not found")
            season_exists = await con.fetchval(
                "SELECT 1 FROM ani_seasons WHERE entry_id = $1 AND season_no = $2",
                entry_id, season,
            )
            if not season_exists:
                return Failure(f"season {season} not in this entry's chain")
            old = (row["cursor_season"] or 0, row["cursor_episode"] or 0)
            new = (season, episode or 0)
            if new < old:
                return Failure(
                    f"cursor may only move forward (currently s{old[0]}e{old[1]}, rejected s{new[0]}e{new[1]})"
                )
            await con.execute(
                "UPDATE ani_entries SET cursor_season = $3, cursor_episode = $4, "
                "cursor_position_seconds = $5 WHERE id = $1 AND user_id = $2",
                entry_id, user_id, season, episode, position_seconds,
            )
        return Success({"season": season, "episode": episode, "position_seconds": position_seconds})

    async def set_progress(
        self, user_id: int, entry_id: int, season: int, episode: int,
        position_seconds: Optional[int] = None,
    ) -> Result[Dict[str, Any], str]:
        """Explicit progress correction — the one path that may move backwards.

        set_cursor is deliberately forward-only (D44) because a normal "+1"
        must never lose progress. But bumping a season by mistake (or adding an
        anime one season too far) needs a way back, so this entry point trusts
        the user and re-derives the season flags from the new position:
        seasons before the cursor are watched, the cursor season only when its
        episode count is known and reached, everything after is not watched.

        position_seconds carries the halfway-watch bookmark (P15); None clears it.
        """
        if season < 1:
            return Failure("season must be >= 1")
        episode = max(0, int(episode))
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                entry = await con.fetchrow(
                    "SELECT list FROM ani_entries WHERE id = $1 AND user_id = $2",
                    entry_id, user_id,
                )
                if entry is None:
                    return Failure("entry not found")
                season_exists = await con.fetchval(
                    "SELECT 1 FROM ani_seasons WHERE entry_id = $1 AND season_no = $2",
                    entry_id, season,
                )
                if not season_exists:
                    return Failure(f"season {season} not in this entry's chain")
                await con.execute(
                    "UPDATE ani_entries SET cursor_season = $3, cursor_episode = $4, "
                    "cursor_position_seconds = $5 WHERE id = $1 AND user_id = $2",
                    entry_id, user_id, season, episode, position_seconds,
                )
                # A correction is also an answer to "where are you?": an entry
                # waiting for a sequel becomes watchable again.
                if entry["list"] == "next_sequel":
                    await con.execute(
                        "UPDATE ani_entries SET list = 'watching' WHERE id = $1 AND user_id = $2",
                        entry_id, user_id,
                    )
                await con.execute(
                    "UPDATE ani_seasons SET watched = "
                    "(season_no < $2) OR "
                    "(season_no = $2 AND episodes_total IS NOT NULL AND $3 >= episodes_total) "
                    "WHERE entry_id = $1",
                    entry_id, season, episode,
                )
        return Success({"season": season, "episode": episode})

    async def mark_range(
        self, user_id: int, entry_id: int, from_season: int, to_season: int
    ) -> Result[Dict[str, Any], str]:
        """'I watched from season X to season Y' in one action (D44/D43
        Easy Completion): flags every season in the range watched and moves
        the cursor to the end of to_season."""
        if from_season > to_season:
            return Failure("from_season must be <= to_season")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                owner = await con.fetchval(
                    "SELECT 1 FROM ani_entries WHERE id = $1 AND user_id = $2", entry_id, user_id
                )
                if not owner:
                    return Failure("entry not found")
                result = await con.execute(
                    "UPDATE ani_seasons SET watched = TRUE "
                    "WHERE entry_id = $1 AND season_no BETWEEN $2 AND $3",
                    entry_id, from_season, to_season,
                )
                last_ep = await con.fetchval(
                    "SELECT episodes_total FROM ani_seasons WHERE entry_id = $1 AND season_no = $2",
                    entry_id, to_season,
                )
                await con.execute(
                    "UPDATE ani_entries SET cursor_season = $3, cursor_episode = $4, "
                    "cursor_position_seconds = NULL WHERE id = $1 AND user_id = $2",
                    entry_id, user_id, to_season, last_ep,
                )
        return Success({
            "watched_seasons": int(result.split()[-1]),
            "cursor": {"season": to_season, "episode": last_ep},
        })

    async def mark_all_watched(self, user_id: int, entry_id: int) -> Result[Dict[str, Any], str]:
        """Easy Completion: watched them all (D43)."""
        pool = await get_pool()
        async with pool.acquire() as con:
            max_season = await con.fetchval(
                "SELECT MAX(season_no) FROM ani_seasons WHERE entry_id = $1", entry_id
            )
        if max_season is None:
            return Failure("entry has no seasons")
        return await self.mark_range(user_id, entry_id, 1, max_season)

    async def advance_season(
        self, user_id: int, entry_id: int, from_season: Optional[int] = None
    ) -> Result[Dict[str, Any], str]:
        """Finish one season and step into the next one — the decision is made
        from the cached chain, never guessed by the UI:

        watching   the next season already aired → cursor to its episode 1,
                   the entry goes back to the Watching list
        awaiting   the next season has a future date → the entry waits in
                   Next sequel with that release date, and its schedule row is
                   due now so the pipeline confirms the date and notifies
        completed  the chain ends here

        Finishing season N also flags every earlier season watched (you cannot
        finish 3 without finishing 1 and 2).
        """
        key = await vault.get(user_id)
        pool = await get_pool()
        now = int(time.time())
        today = time.strftime("%Y-%m-%d", time.gmtime(now))
        async with pool.acquire() as con:
            async with con.transaction():
                entry = await con.fetchrow(
                    "SELECT cursor_season, cursor_episode FROM ani_entries "
                    "WHERE id = $1 AND user_id = $2",
                    entry_id, user_id,
                )
                if entry is None:
                    return Failure("entry not found")
                season_no = int(from_season or entry["cursor_season"] or 1)
                current = await con.fetchrow(
                    "SELECT season_no, episodes_total, episodes_aired FROM ani_seasons "
                    "WHERE entry_id = $1 AND season_no = $2",
                    entry_id, season_no,
                )
                if current is None:
                    return Failure(f"season {season_no} not in this entry's chain")

                await con.execute(
                    "UPDATE ani_seasons SET watched = TRUE "
                    "WHERE entry_id = $1 AND season_no <= $2",
                    entry_id, season_no,
                )
                done_ep = int(
                    current["episodes_total"]
                    or current["episodes_aired"]
                    or entry["cursor_episode"]
                    or 0
                )

                nxt = await con.fetchrow(
                    "SELECT season_no, title_enc, status, episodes_total, episodes_aired, "
                    "start_date, release_date, next_airing_at, next_airing_ep "
                    "FROM ani_seasons WHERE entry_id = $1 AND season_no = $2",
                    entry_id, season_no + 1,
                )
                if nxt is None:
                    await con.execute(
                        "UPDATE ani_entries SET cursor_season = $3, cursor_episode = $4, "
                        "cursor_position_seconds = NULL WHERE id = $1 AND user_id = $2",
                        entry_id, user_id, season_no, done_ep,
                    )
                    return Success({
                        "action": "completed",
                        "season": season_no,
                        "episode": done_ep,
                        "title": None,
                        "release_date": None,
                        "episodes_total": current["episodes_total"],
                    })

                title = decrypt(key, nxt["title_enc"]) if key else None
                aired = int(nxt["episodes_aired"] or 0)
                status = (nxt["status"] or "").upper()
                start = nxt["start_date"]
                released = (
                    aired >= 1
                    or status == "FINISHED"
                    or (bool(start) and str(start)[:10] <= today)
                )

                if released:
                    await con.execute(
                        "UPDATE ani_entries SET list = 'watching', cursor_season = $3, "
                        "cursor_episode = 1, cursor_position_seconds = NULL "
                        "WHERE id = $1 AND user_id = $2",
                        entry_id, user_id, season_no + 1,
                    )
                    return Success({
                        "action": "watching",
                        "season": season_no + 1,
                        "episode": 1,
                        "title": title,
                        "release_date": nxt["release_date"] or start,
                        "episodes_total": nxt["episodes_total"],
                    })

                release = nxt["release_date"] or start
                await con.execute(
                    "UPDATE ani_entries SET cursor_season = $3, cursor_episode = $4, "
                    "cursor_position_seconds = NULL WHERE id = $1 AND user_id = $2",
                    entry_id, user_id, season_no, done_ep,
                )
                await con.execute(
                    "UPDATE ani_entries SET list = 'next_sequel' WHERE id = $1 AND user_id = $2",
                    entry_id, user_id,
                )
                if start:
                    await con.execute(
                        "UPDATE ani_seasons SET release_date = COALESCE(release_date, $3) "
                        "WHERE entry_id = $1 AND season_no = $2",
                        entry_id, season_no + 1, start,
                    )
                # Due now: the pipeline re-checks this season and raises the
                # next_sequel_date notification with the confirmed date.
                await con.execute(
                    "UPDATE ani_schedule SET next_check_ts = $3 "
                    "WHERE entry_id = $1 AND season_no = $2",
                    entry_id, season_no + 1, now,
                )
                return Success({
                    "action": "awaiting",
                    "season": season_no + 1,
                    "episode": 0,
                    "title": title,
                    "release_date": release,
                    "episodes_total": nxt["episodes_total"],
                })


    async def ensure_category(
        self, user_id: int, domain: str, subdomain: Optional[str]
    ) -> Optional[int]:
        """Get-or-create an anime domain/subdomain; returns subdomain_id."""
        key = await vault.get(user_id)
        if key is None or not domain.strip():
            return None
        pool = await get_pool()
        async with pool.acquire() as con:
            d_id = await con.fetchval(
                "INSERT INTO ani_domains (user_id, name_enc, name_hash) VALUES ($1, $2, $3) "
                "ON CONFLICT (user_id, name_hash) DO UPDATE SET name_enc = EXCLUDED.name_enc "
                "RETURNING id",
                user_id, encrypt(key, domain.strip()), index_hash(key, domain.strip().lower()),
            )
            if not subdomain or not subdomain.strip():
                return None
            return await con.fetchval(
                "INSERT INTO ani_subdomains (domain_id, name_enc, name_hash) VALUES ($1, $2, $3) "
                "ON CONFLICT (domain_id, name_hash) DO UPDATE SET name_enc = EXCLUDED.name_enc "
                "RETURNING id",
                d_id, encrypt(key, subdomain.strip()), index_hash(key, subdomain.strip().lower()),
            )

    # ---------------- categories (Management > Category) ----------------
    async def domains_tree(self, user_id: int) -> Dict[str, Any]:
        key = await vault.get(user_id)
        if key is None:
            return {"domains": [], "unassigned_entries": 0}
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT d.id AS d_id, d.name_enc AS d_enc, d.active AS d_active, d.notify AS d_notify,
                       s.id AS s_id, s.name_enc AS s_enc, s.active AS s_active, s.notify AS s_notify,
                       (SELECT count(*) FROM ani_entries e WHERE e.subdomain_id = s.id) AS entry_count
                FROM ani_domains d
                LEFT JOIN ani_subdomains s ON s.domain_id = d.id
                WHERE d.user_id = $1
                ORDER BY d.id, s.id
                """,
                user_id,
            )
            unassigned = await con.fetchval(
                "SELECT count(*) FROM ani_entries WHERE user_id = $1 AND subdomain_id IS NULL",
                user_id,
            )
        domains: Dict[int, Dict[str, Any]] = {}
        for r in rows:
            entry = domains.setdefault(
                r["d_id"],
                {
                    "id": r["d_id"], "name": decrypt(key, r["d_enc"]),
                    "active": r["d_active"], "notify": r["d_notify"], "subdomains": [],
                },
            )
            if r["s_id"] is not None:
                entry["subdomains"].append(
                    {
                        "id": r["s_id"], "name": decrypt(key, r["s_enc"]),
                        "active": r["s_active"], "notify": r["s_notify"],
                        "channel_count": r["entry_count"], "blocked_count": 0,
                    }
                )
        tree = list(domains.values())
        for d in tree:
            d["channel_count"] = sum(s["channel_count"] for s in d["subdomains"])
        return {"domains": tree, "unassigned_channels": unassigned}

    async def create_domain(self, user_id: int, name: str) -> Result[Dict[str, Any], str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        cleaned = name.strip()
        if not cleaned:
            return Failure("domain name is required")
        pool = await get_pool()
        async with pool.acquire() as con:
            domain_id = await con.fetchval(
                "INSERT INTO ani_domains (user_id, name_enc, name_hash) VALUES ($1, $2, $3) "
                "ON CONFLICT (user_id, name_hash) DO UPDATE SET name_enc = EXCLUDED.name_enc "
                "RETURNING id",
                user_id, encrypt(key, cleaned), index_hash(key, cleaned.lower()),
            )
        return Success({"id": domain_id, "name": cleaned})

    async def rename_domain(self, user_id: int, domain_id: int, new_name: str) -> Result[Dict[str, Any], str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        cleaned = new_name.strip()
        if not cleaned:
            return Failure("domain name is required")
        pool = await get_pool()
        async with pool.acquire() as con:
            try:
                result = await con.execute(
                    "UPDATE ani_domains SET name_enc = $3, name_hash = $4 WHERE id = $1 AND user_id = $2",
                    domain_id, user_id, encrypt(key, cleaned), index_hash(key, cleaned.lower()),
                )
            except Exception:
                return Failure("a domain with that name already exists")
        if result.endswith("0"):
            return Failure("domain not found")
        return Success({"id": domain_id, "name": cleaned})

    async def delete_domain(self, user_id: int, domain_id: int) -> Result[Dict[str, Any], str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "DELETE FROM ani_domains WHERE id = $1 AND user_id = $2", domain_id, user_id
            )
        if result.endswith("0"):
            return Failure("domain not found")
        return Success({"deleted": domain_id})

    async def create_subdomain(self, user_id: int, domain_id: int, name: str) -> Result[Dict[str, Any], str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        cleaned = name.strip()
        if not cleaned:
            return Failure("subdomain name is required")
        pool = await get_pool()
        async with pool.acquire() as con:
            owner = await con.fetchval(
                "SELECT 1 FROM ani_domains WHERE id = $1 AND user_id = $2", domain_id, user_id
            )
            if not owner:
                return Failure("domain not found")
            sub_id = await con.fetchval(
                "INSERT INTO ani_subdomains (domain_id, name_enc, name_hash) VALUES ($1, $2, $3) "
                "ON CONFLICT (domain_id, name_hash) DO UPDATE SET name_enc = EXCLUDED.name_enc "
                "RETURNING id",
                domain_id, encrypt(key, cleaned), index_hash(key, cleaned.lower()),
            )
        return Success({"id": sub_id, "domain_id": domain_id, "name": cleaned})

    async def rename_subdomain(self, user_id: int, subdomain_id: int, new_name: str) -> Result[Dict[str, Any], str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        cleaned = new_name.strip()
        if not cleaned:
            return Failure("subdomain name is required")
        pool = await get_pool()
        async with pool.acquire() as con:
            try:
                result = await con.execute(
                    "UPDATE ani_subdomains s SET name_enc = $3, name_hash = $4 "
                    "FROM ani_domains d WHERE s.domain_id = d.id AND d.user_id = $1 AND s.id = $2",
                    user_id, subdomain_id, encrypt(key, cleaned), index_hash(key, cleaned.lower()),
                )
            except Exception:
                return Failure("a subdomain with that name already exists")
        if result.endswith("0"):
            return Failure("subdomain not found")
        return Success({"id": subdomain_id, "name": cleaned})

    async def delete_subdomain(self, user_id: int, subdomain_id: int) -> Result[Dict[str, Any], str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "DELETE FROM ani_subdomains s USING ani_domains d "
                "WHERE s.domain_id = d.id AND d.user_id = $1 AND s.id = $2",
                user_id, subdomain_id,
            )
        if result.endswith("0"):
            return Failure("subdomain not found")
        return Success({"deleted": subdomain_id})

    async def set_domain_notify(self, user_id: int, domain_id: int, notify: bool) -> Result[Dict[str, Any], str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE ani_domains SET notify = $3 WHERE id = $1 AND user_id = $2",
                domain_id, user_id, notify,
            )
        if result.endswith("0"):
            return Failure("domain not found")
        return Success({"id": domain_id, "notify": notify})

    async def set_subdomain_notify(self, user_id: int, subdomain_id: int, notify: bool) -> Result[Dict[str, Any], str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE ani_subdomains s SET notify = $3 FROM ani_domains d "
                "WHERE d.id = s.domain_id AND d.user_id = $1 AND s.id = $2",
                user_id, subdomain_id, notify,
            )
        if result.endswith("0"):
            return Failure("subdomain not found")
        return Success({"id": subdomain_id, "notify": notify})

    async def assign_entry(self, user_id: int, entry_id: int, subdomain_id: Optional[int]) -> Result[Dict[str, Any], str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            if subdomain_id is not None:
                owner = await con.fetchval(
                    "SELECT 1 FROM ani_subdomains s JOIN ani_domains d ON d.id = s.domain_id "
                    "WHERE s.id = $1 AND d.user_id = $2",
                    subdomain_id, user_id,
                )
                if not owner:
                    return Failure("subdomain not found")
            result = await con.execute(
                "UPDATE ani_entries SET subdomain_id = $3 WHERE id = $1 AND user_id = $2",
                entry_id, user_id, subdomain_id,
            )
        if result.endswith("0"):
            return Failure("entry not found")
        return Success({"id": entry_id, "subdomain_id": subdomain_id})

    async def notify_enabled(self, user_id: int, entry_id: int) -> bool:
        pool = await get_pool()
        async with pool.acquire() as con:
            return bool(
                await con.fetchval(
                    """
                    SELECT COALESCE(e.notify_release, TRUE) AND COALESCE(sd.notify, TRUE)
                       AND COALESCE(d.notify, TRUE) AND e.label = 'none' AND e.active
                    FROM ani_entries e
                    LEFT JOIN ani_subdomains sd ON sd.id = e.subdomain_id
                    LEFT JOIN ani_domains d ON d.id = sd.domain_id
                    WHERE e.id = $1 AND e.user_id = $2
                    """,
                    entry_id, user_id,
                )
            )

    # ---------------- Halfway-watch todo (cleanup #2) ----------------
    async def todo_add(
        self,
        user_id: int,
        *,
        season_no: int,
        episode: int,
        position_seconds: int = 0,
        entry_id: Optional[int] = None,
        title: Optional[str] = None,
    ) -> Result[int, str]:
        """"AoT S3 E5 at 7:27" — manual halfway-watch bookmark."""
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        if entry_id is None and not title:
            return Failure("title required for untracked entries")
        pool = await get_pool()
        async with pool.acquire() as con:
            if entry_id is not None:
                owner = await con.fetchval(
                    "SELECT user_id FROM ani_entries WHERE id = $1", entry_id
                )
                if owner != user_id:
                    return Failure("entry not found")
            todo_id = await con.fetchval(
                "INSERT INTO ani_todo (user_id, entry_id, title_enc, season_no, "
                "episode, position_seconds) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
                user_id, entry_id, encrypt(key, title) if title else None,
                season_no, episode, position_seconds,
            )
        return Success(todo_id)

    async def todo_list(self, user_id: int) -> List[Dict[str, Any]]:
        key = await vault.get(user_id)
        if key is None:
            return []
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                "SELECT t.id, t.entry_id, t.title_enc, e.title_enc AS entry_title_enc, "
                "t.season_no, t.episode, t.position_seconds, t.done, t.created_at "
                "FROM ani_todo t LEFT JOIN ani_entries e ON e.id = t.entry_id "
                "WHERE t.user_id = $1 ORDER BY t.done, t.created_at DESC",
                user_id,
            )
        return [
            {
                "id": r["id"], "entry_id": r["entry_id"],
                "title": decrypt(key, r["entry_title_enc"] or r["title_enc"]),
                "season_no": r["season_no"], "episode": r["episode"],
                "position_seconds": r["position_seconds"], "done": r["done"],
                "created_at": int(r["created_at"].timestamp()),
            }
            for r in rows
        ]

    async def todo_update(
        self, user_id: int, todo_id: int, *, done: Optional[bool] = None,
        episode: Optional[int] = None, position_seconds: Optional[int] = None,
    ) -> Result[str, str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            owner = await con.fetchval("SELECT user_id FROM ani_todo WHERE id = $1", todo_id)
            if owner != user_id:
                return Failure("todo not found")
            await con.execute(
                "UPDATE ani_todo SET done = COALESCE($2, done), "
                "episode = COALESCE($3, episode), "
                "position_seconds = COALESCE($4, position_seconds) WHERE id = $1",
                todo_id, done, episode, position_seconds,
            )
        return Success("ok")

    async def todo_delete(self, user_id: int, todo_id: int) -> Result[str, str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "DELETE FROM ani_todo WHERE id = $1 AND user_id = $2", todo_id, user_id
            )
        return Success("ok") if result.endswith("1") else Failure("todo not found")

    # ---------------- Blocked domain/subdomain (cleanup #4) ----------------
    async def set_blocked_category(
        self, user_id: int, entry_id: int,
        domain: Optional[str], subdomain: Optional[str],
    ) -> Result[str, str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE ani_entries SET blocked_domain_enc = $3, blocked_subdomain_enc = $4 "
                "WHERE id = $1 AND user_id = $2",
                entry_id, user_id, encrypt(key, domain), encrypt(key, subdomain),
            )
        return Success("ok") if result.endswith("1") else Failure("entry not found")


def _aired(video: Dict[str, Any]) -> int:
    from Orchestrator.Ani.Filter.states import episodes_aired

    return episodes_aired(video)
