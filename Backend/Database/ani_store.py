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
    ) -> Result[int, str]:
        """Insert an entry + its season cache + schedule rows."""
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked for user (login required, D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                entry_id = await con.fetchval(
                    "INSERT INTO ani_entries (user_id, anilist_id, title_enc, cover_enc, list) "
                    "VALUES ($1, $2, $3, $4, $5) RETURNING id",
                    user_id, first_season_anilist_id,
                    encrypt(key, title), encrypt(key, cover), list_kind,
                )
                await self._upsert_seasons(con, key, entry_id, payload)
        return Success(entry_id)

    async def _upsert_seasons(self, con, key: bytes, entry_id: int, payload: FetchPayload) -> None:
        for season_no, video in payload[0].items():
            await con.execute(
                """
                INSERT INTO ani_seasons
                    (entry_id, season_no, anilist_id, title_enc, status,
                     episodes_total, episodes_aired, start_date,
                     next_airing_at, next_airing_ep)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                ON CONFLICT (entry_id, season_no) DO UPDATE SET
                    title_enc = EXCLUDED.title_enc, status = EXCLUDED.status,
                    episodes_total = EXCLUDED.episodes_total,
                    episodes_aired = EXCLUDED.episodes_aired,
                    start_date = EXCLUDED.start_date,
                    next_airing_at = EXCLUDED.next_airing_at,
                    next_airing_ep = EXCLUDED.next_airing_ep
                """,
                entry_id, season_no, int(video["id"]),
                encrypt(key, video.get("title")),
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

    async def refresh_seasons(self, user_id: int, entry_id: int, payload: FetchPayload) -> None:
        key = await vault.get(user_id)
        if key is None:
            return
        pool = await get_pool()
        async with pool.acquire() as con:
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
        log.info("ani event: %s entry=%s season=%s tier=%s", kind, entry_id, season_no, tier)

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
                    canon_only = COALESCE($8, canon_only)
                WHERE id = $1 AND user_id = $2
                """,
                entry_id, user_id, label,
                encrypt(key, label_reason) if label_reason else None,
                list_kind, notify_release, active,
                canon_only,
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
                          s.next_check_ts,
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
                await self.release(r["entry_id"], r["season_no"])
                continue
            due.append(
                AniDue(
                    entry_id=r["entry_id"], season_no=r["season_no"],
                    user_id=r["user_id"],
                    title=decrypt(key, r["title_enc"]) or "",
                    state=r["state"] or "unknown",
                    watched=bool(r["watched"]),
                    next_check_ts=r["next_check_ts"],
                )
            )
        return due

    async def release(self, entry_id: int, season_no: int) -> None:
        pool = await get_pool()
        async with pool.acquire() as con:
            await con.execute(
                "UPDATE ani_schedule SET working = FALSE WHERE entry_id = $1 AND season_no = $2",
                entry_id, season_no,
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
        key = await vault.get(user_id)
        if key is None:
            return []
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                "SELECT e.id, e.entry_id, e.season_no, e.kind, e.tier, e.payload_enc, e.seen, e.created_at "
                "FROM ani_events e JOIN ani_entries a ON a.id = e.entry_id "
                "WHERE a.user_id = $1 AND ($2 OR NOT e.seen) ORDER BY e.created_at DESC",
                user_id, include_seen,
            )
        return [
            {
                "id": r["id"], "entry_id": r["entry_id"], "season_no": r["season_no"], "kind": r["kind"],
                "tier": r["tier"], "seen": r["seen"], "created_at": r["created_at"].isoformat(),
                "payload": json.loads(decrypt(key, r["payload_enc"]) or "{}"),
            }
            for r in rows
        ]

    async def management_view(self, user_id: int) -> List[Dict[str, Any]]:
        """User Management division (D18): entries + per-season ep counts + totals (D23)."""
        key = await vault.get(user_id)
        if key is None:
            return []
        pool = await get_pool()
        async with pool.acquire() as con:
            rows = await con.fetch(
                """
                SELECT a.id, a.title_enc, a.cover_enc, a.label, a.list, a.active, a.notify_release,
                       a.canon_only, a.cursor_season, a.cursor_episode, a.cursor_position_seconds,
                       s.season_no, s.title_enc AS s_title_enc, s.status, s.episodes_total,
                       s.episodes_aired, s.state, s.watched, s.start_date, s.release_date
                FROM ani_entries a
                LEFT JOIN ani_seasons s ON s.entry_id = a.id
                WHERE a.user_id = $1 AND a.label != 'blocked'
                ORDER BY a.id, s.season_no
                """,
                user_id,
            )
        entries: Dict[int, Dict[str, Any]] = {}
        for r in rows:
            entry = entries.setdefault(
                r["id"],
                {
                    "id": r["id"], "title": decrypt(key, r["title_enc"]),
                    "cover": decrypt(key, r["cover_enc"]),
                    "label": r["label"], "list": r["list"], "active": r["active"],
                    "notify_release": r["notify_release"],
                    "canon_only": r["canon_only"],
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
                        "season_no": r["season_no"], "title": decrypt(key, r["s_title_enc"]),
                        "status": r["status"],
                        "episodes_total": r["episodes_total"], "episodes_aired": r["episodes_aired"],
                        "state": r["state"], "watched": r["watched"],
                        "start_date": r["start_date"], "release_date": r["release_date"],
                    }
                )
        for entry in entries.values():
            entry["total_seasons"] = len(entry["seasons"])
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


def _aired(video: Dict[str, Any]) -> int:
    from Orchestrator.Ani.Filter.states import episodes_aired

    return episodes_aired(video)
