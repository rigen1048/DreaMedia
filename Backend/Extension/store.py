"""Extension v2 phase 1: the per-user website allowlist (ext_domains).

The extension registers its content scripts only on these domains (design:
Extension/Docs/extension-design.md) — nothing runs on arbitrary pages, and
the user teaches the extension their sites instead of us prescribing any.
"""
from __future__ import annotations

from typing import Any, Dict, List
from urllib.parse import urlsplit

from returns.result import Failure, Result, Success

from Database import vault
from Database.crypto import decrypt, encrypt, index_hash
from Database.db import get_pool


def _normalize(domain: str) -> str:
    """Normalize a host from either a bare domain or an HTTP(S) page URL."""
    value = (domain or "").strip()
    if not value:
        return ""
    if "://" in value and value.split("://", 1)[0].lower() not in ("http", "https"):
        return ""
    candidate = value if "://" in value else f"https://{value}"
    try:
        parsed = urlsplit(candidate)
        _ = parsed.port  # reject malformed ports instead of silently accepting them
        host = parsed.hostname or ""
        host = host.rstrip(".").encode("idna").decode("ascii").lower()
    except (UnicodeError, ValueError):
        return ""
    return host[4:] if host.startswith("www.") else host


class ExtDomainStore:
    async def list_domains(self, user_id: int, enabled_only: bool = False) -> List[Dict[str, Any]]:
        """Read path: no vault key needed for ids/media/enabled, but the
        domain name itself is ciphertext — locked vault returns rows with
        domain=None rather than failing (the extension refresh path only
        ever runs while the user has a session)."""
        key = await vault.get(user_id)
        pool = await get_pool()
        sql = (
            "SELECT id, domain_enc, media, enabled FROM ext_domains WHERE user_id = $1"
            + (" AND enabled" if enabled_only else "")
            + " ORDER BY added_at"
        )
        async with pool.acquire() as con:
            rows = await con.fetch(sql, user_id)
        return [
            {
                "id": r["id"],
                "domain": decrypt(key, r["domain_enc"]) if key else None,
                "media": r["media"],
                "enabled": r["enabled"],
            }
            for r in rows
        ]

    async def ensure_default_youtube(self, user_id: int) -> Result[bool, str]:
        """Seed youtube.com once, without restoring it after the user removes it."""
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        domain = "youtube.com"
        pool = await get_pool()
        async with pool.acquire() as con:
            async with con.transaction():
                seeded_user = await con.fetchval(
                    "INSERT INTO ext_domain_defaults (user_id) VALUES ($1) "
                    "ON CONFLICT (user_id) DO NOTHING RETURNING user_id",
                    user_id,
                )
                if seeded_user is None:
                    return Success(False)
                await con.execute(
                    "INSERT INTO ext_domains (user_id, domain_enc, domain_hash, media) "
                    "VALUES ($1, $2, $3, 'yt') "
                    "ON CONFLICT (user_id, domain_hash, media) DO NOTHING",
                    user_id, encrypt(key, domain), index_hash(key, domain),
                )
        return Success(True)

    async def add_domain(self, user_id: int, domain: str, media: str) -> Result[Dict[str, Any], str]:
        if media not in ("yt", "ani"):
            return Failure("media must be yt|ani")
        domain = _normalize(domain)
        if not domain or "." not in domain:
            return Failure("not a valid domain")
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            row = await con.fetchrow(
                "INSERT INTO ext_domains (user_id, domain_enc, domain_hash, media) "
                "VALUES ($1, $2, $3, $4) "
                "ON CONFLICT (user_id, domain_hash, media) DO UPDATE SET enabled = TRUE "
                "RETURNING id",
                user_id, encrypt(key, domain), index_hash(key, domain), media,
            )
        return Success({"id": row["id"], "domain": domain, "media": media, "enabled": True})

    async def set_enabled(self, user_id: int, domain_id: int, enabled: bool) -> Result[bool, str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE ext_domains SET enabled = $3 WHERE id = $1 AND user_id = $2",
                domain_id, user_id, enabled,
            )
        if not result.endswith("1"):
            return Failure("domain not found")
        return Success(True)

    async def remove_domain(self, user_id: int, domain_id: int) -> Result[bool, str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "DELETE FROM ext_domains WHERE id = $1 AND user_id = $2",
                domain_id, user_id,
            )
        if not result.endswith("1"):
            return Failure("domain not found")
        return Success(True)


async def list_blocked_yt(user_id: int) -> Result[List[Dict[str, Any]], str]:
    """Blocked YouTube channels for the extension's local disclaimer cache
    (phase 4): url + name, decrypted server-side over the token lane.
    Anime blocking rides anchorMatch instead (per-page candidates already
    flow there for binding)."""
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9)")
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT name_enc, url_enc, label_reason_enc FROM yt_channels "
            "WHERE user_id = $1 AND label = 'blocked'",
            user_id,
        )
    return Success([
        {
            "name": decrypt(key, r["name_enc"]) or "",
            "url": decrypt(key, r["url_enc"]) or "",
            "reason": decrypt(key, r["label_reason_enc"]) if r["label_reason_enc"] else None,
        }
        for r in rows
    ])
