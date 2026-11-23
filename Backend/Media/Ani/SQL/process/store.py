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
from Media.Ani.Config.Model.due import AniDue
from Media.Ani.Filter.states import episodes_aired




class AniProcessSQL:
    """Backend-mechanism Ani SQL — the pipeline/manager call this."""

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
                episodes_aired(video),
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
                video.get("format"), video.get("episodes"), episodes_aired(video),
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
        # Pull-only feed (D60): the event lives in ani_events; the frontend
        # reads it via GraphQL. Nothing is pushed to the bell from here.
        log.info("ani event: %s entry=%s season=%s tier=%s", kind, entry_id, season_no, tier)

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

    async def alerts_enabled(self, user_id: int, entry_id: int) -> bool:
        pool = await get_pool()
        async with pool.acquire() as con:
            return bool(
                await con.fetchval(
                    """
                    SELECT COALESCE(e.alerts_release, TRUE) AND COALESCE(sd.alerts, TRUE)
                       AND COALESCE(d.alerts, TRUE) AND e.label = 'none' AND e.active
                    FROM ani_entries e
                    LEFT JOIN ani_subdomains sd ON sd.id = e.subdomain_id
                    LEFT JOIN ani_domains d ON d.id = sd.domain_id
                    WHERE e.id = $1 AND e.user_id = $2
                    """,
                    entry_id, user_id,
                )
            )

    async def purge_trash(self, older_than_seconds: int = 86400) -> int:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "DELETE FROM ani_events WHERE trashed_at < now() - make_interval(secs => $1)",
                older_than_seconds,
            )
        return int(result.split()[-1])

