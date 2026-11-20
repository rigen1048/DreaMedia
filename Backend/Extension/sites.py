"""Extension v2 phase 5: per-anime watch sites (ani_watch_sites).

Learned passively: every anchor report carries the page URL, so the map
builds itself. Notification clicks resolve the next episode URL by
pattern-matching the stored page URL (endpoint patterns with the episode
number in them), falling back to the site home — a fresh release shows up
there — and the frontend falls back to AniList when we return None.
"""
from __future__ import annotations

import re
from typing import Optional

from returns.result import Failure, Result, Success

from Database import vault
from Database.crypto import decrypt, encrypt, index_hash
from Database.db import get_pool
from Extension.store import _normalize


async def learn_watch_site(
    user_id: int, entry_id: int, page_url: str, season: Optional[int], episode: Optional[int]
) -> None:
    """Upsert the (user, entry, domain) row from an anchor match. Best
    effort: a learning failure must never break anchoring."""
    if not page_url:
        return
    key = await vault.get(user_id)
    if key is None:
        return
    domain = _normalize(page_url)
    if not domain or "." not in domain:
        return
    try:
        pool = await get_pool()
        async with pool.acquire() as con:
            await con.execute(
                "INSERT INTO ani_watch_sites (user_id, entry_id, domain_enc, domain_hash, "
                "url_enc, season, episode) VALUES ($1, $2, $3, $4, $5, $6, $7) "
                "ON CONFLICT (user_id, entry_id, domain_hash) DO UPDATE SET "
                "url_enc = EXCLUDED.url_enc, season = EXCLUDED.season, "
                "episode = EXCLUDED.episode, use_count = ani_watch_sites.use_count + 1, "
                "last_used_at = now()",
                user_id, entry_id, encrypt(key, domain), index_hash(key, domain),
                encrypt(key, page_url), season, episode,
            )
    except Exception:
        return


def _retarget(
    url: str, old_s: Optional[int], old_e: Optional[int], new_s: int, new_e: int
) -> Optional[str]:
    """Rewrite the stored URL from its (season, episode) to the target one.
    Zero-padding is preserved (s02e05 -> s03e01). None when no endpoint
    pattern is recognizable — the caller falls back to the site home."""
    out = url
    if old_s and old_s != new_s:
        # season tokens only where they look like seasons: s2, S02, season-2
        season_pat = re.compile(rf"(?i)(s(?:eason)?[-_]?)(0*){old_s}(?![\d])")
        out, n = season_pat.subn(
            lambda m: m.group(1) + (
                str(new_s).zfill(len(m.group(2)) + len(str(old_s)))
                if m.group(2) else str(new_s)
            ),
            out,
        )
        if n == 0:
            return None
    if old_e and old_e != new_e:
        # the episode number as a non-digit-flanked token: e5, ep-5, /5, =5
        ep_pat = re.compile(rf"(?<![\d])(0*){old_e}(?![\d])")
        occurrences = len(ep_pat.findall(out))
        if occurrences == 0 or occurrences > 2:
            return None  # absent, or too many lookalikes to rewrite safely
        out = ep_pat.sub(
            lambda m: (
                str(new_e).zfill(len(m.group(1)) + len(str(old_e)))
                if m.group(1) else str(new_e)
            ),
            out,
        )
    if out == url:
        return None
    return out


async def resolve_watch_link(
    user_id: int, entry_id: int, season: int, episode: int
) -> Result[Optional[str], str]:
    """The URL a notification click should open for this entry's new
    episode. None means 'no recorded site' — the frontend uses AniList."""
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9)")
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT domain_enc, url_enc, season, episode FROM ani_watch_sites "
            "WHERE user_id = $1 AND entry_id = $2 "
            "ORDER BY use_count DESC, last_used_at DESC",
            user_id, entry_id,
        )
    if not rows:
        return Success(None)
    r = rows[0]
    url = decrypt(key, r["url_enc"]) or ""
    domain = decrypt(key, r["domain_enc"]) or ""
    targeted = _retarget(url, r["season"], r["episode"], season, episode)
    if targeted:
        return Success(targeted)
    return Success(f"https://{domain}" if domain else None)
