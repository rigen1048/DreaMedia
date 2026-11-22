"""Encrypted PostgreSQL queue for bulk YouTube source additions.

The extension's Add Source resolver and background import workers share the
same channel resolution/write path. The request that starts a bulk import only
validates/enqueues work; bounded workers resolve channels off the event loop.
"""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlsplit

from returns.result import Failure

from Database import vault
from Database.crypto import decrypt, encrypt
from Database.db import get_pool
from Database.pg_store import PgStore
from Utility.logs import log

MAX_IMPORT_CHANNELS = 2000
MAX_STATUS_ERRORS = 10
CLAIM_STALE_AFTER_MINUTES = 5
_CHANNEL_PATH = re.compile(r"^/(?:@[^/]+|channel/UC[A-Za-z0-9_-]{22})(?:/|$)", re.I)
_CHANNEL_KINDS = {"tracking", "wordscan", "random", "withhold"}


def normalize_source_options(
    *,
    kind: str,
    words: Optional[List[str]] = None,
    rank: Optional[str] = None,
    withhold: Optional[int] = None,
    domain: Optional[str] = None,
    subdomain: Optional[str] = None,
) -> Dict[str, Any]:
    """Validate and normalize the mode/settings shared by Add Source and import."""
    if kind not in _CHANNEL_KINDS:
        raise ValueError("channel sources support tracking, wordscan, random, or withhold")
    if kind == "withhold" and (withhold is None or withhold < 1):
        raise ValueError("withhold threshold must be >= 1")
    clean_domain = domain.strip() if domain and domain.strip() else None
    clean_subdomain = subdomain.strip() if subdomain and subdomain.strip() else None
    if bool(clean_domain) != bool(clean_subdomain):
        raise ValueError("choose both a domain and subdomain, or leave both empty")
    clean_words = [word.strip() for word in (words or []) if word and word.strip()]
    return {
        "kind": kind,
        "words": clean_words if kind == "wordscan" else None,
        "rank": (rank or "week") if kind == "random" else None,
        "withhold": withhold if kind == "withhold" else None,
        "domain": clean_domain,
        "subdomain": clean_subdomain,
    }


async def add_youtube_channel_source(
    user_id: int,
    link: str,
    *,
    kind: str,
    words: Optional[List[str]] = None,
    rank: Optional[str] = None,
    withhold: Optional[int] = None,
    domain: Optional[str] = None,
    subdomain: Optional[str] = None,
    skip_existing: bool = False,
    store: Optional[PgStore] = None,
) -> Dict[str, Any]:
    """Resolve and store one source using the same path for single and bulk adds."""
    from Orchestrator.Yt.Fetch.convert import resolve_channel

    options = normalize_source_options(
        kind=kind,
        words=words,
        rank=rank,
        withhold=withhold,
        domain=domain,
        subdomain=subdomain,
    )
    clean_link = link.strip()
    if not clean_link:
        raise ValueError("source link is required")
    resolved_result = await asyncio.to_thread(resolve_channel, clean_link)
    if isinstance(resolved_result, Failure):
        raise ValueError(resolved_result.failure())
    resolved = resolved_result.unwrap()
    target_store = store or PgStore()
    saved = await target_store.add_extension_subscription(
        user_id,
        rss_id=resolved.rss_id,
        channel_name=resolved.name,
        channel_url=resolved.url,
        kind=options["kind"],
        words=options["words"],
        rank=options["rank"],
        withhold=options["withhold"],
        domain=options["domain"],
        subdomain=options["subdomain"],
        logo=resolved.logo,
        skip_existing=skip_existing,
    )
    if isinstance(saved, Failure):
        raise ValueError(saved.failure())
    return saved.unwrap()


def _prepare_items(links: Sequence[str]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    seen = set()
    for ordinal, raw_link in enumerate(links):
        link = str(raw_link).strip()
        if len(link) > 2048:
            items.append({
                "ordinal": ordinal,
                "link": link[:2048],
                "status": "failed",
                "error": f"{link[:180]}: channel link is too long",
            })
            continue
        try:
            parsed = urlsplit(link)
            host = (parsed.hostname or "").lower().rstrip(".")
            port = parsed.port
        except ValueError:
            parsed = None
            host = ""
            port = None
        valid_host = host == "youtube.com" or host.endswith(".youtube.com")
        valid_port = port is None or (
            (parsed.scheme == "http" and port == 80)
            or (parsed.scheme == "https" and port == 443)
        )
        valid_path = bool(parsed and _CHANNEL_PATH.match(parsed.path))
        safe_authority = bool(parsed and not parsed.username and not parsed.password)
        if (
            not parsed
            or parsed.scheme not in ("http", "https")
            or not valid_host
            or not valid_port
            or not valid_path
            or not safe_authority
        ):
            items.append(
                {
                    "ordinal": ordinal,
                    "link": link[:2048],
                    "status": "failed",
                    "error": f"{link[:180]}: not a supported YouTube channel link",
                }
            )
            continue
        canonical_host = "youtube.com" if host.endswith(".youtube.com") else host
        canonical_path = parsed.path.rstrip("/")
        if canonical_path.startswith("/@"):
            canonical_path = canonical_path.casefold()
        canonical = f"{canonical_host}{canonical_path}"
        if canonical in seen:
            items.append(
                {"ordinal": ordinal, "link": link, "status": "skipped", "error": None}
            )
            continue
        seen.add(canonical)
        items.append({"ordinal": ordinal, "link": link, "status": "queued", "error": None})
    return items


async def enqueue_youtube_import(
    user_id: int,
    links: Sequence[str],
    *,
    kind: str,
    words: Optional[List[str]] = None,
    rank: Optional[str] = None,
    withhold: Optional[int] = None,
    domain: Optional[str] = None,
    subdomain: Optional[str] = None,
) -> Dict[str, Any]:
    if not links:
        raise ValueError("scan at least one channel before adding sources")
    if len(links) > MAX_IMPORT_CHANNELS:
        raise ValueError(f"a scan can add at most {MAX_IMPORT_CHANNELS} channels at once")
    key = await vault.get(user_id)
    if key is None:
        raise ValueError("vault locked (D9); sign in again before adding sources")

    options = normalize_source_options(
        kind=kind,
        words=words,
        rank=rank,
        withhold=withhold,
        domain=domain,
        subdomain=subdomain,
    )
    items = _prepare_items(links)
    skipped = sum(item["status"] == "skipped" for item in items)
    failed = sum(item["status"] == "failed" for item in items)
    processed = skipped + failed
    has_queue = processed < len(items)
    status = "queued" if has_queue else ("partial" if failed else "completed")
    job_id = uuid.uuid4().hex
    options_enc = encrypt(key, json.dumps(options, separators=(",", ":")))
    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            await con.execute(
                "DELETE FROM yt_import_jobs "
                "WHERE status IN ('completed', 'partial') "
                "AND created_at < now() - INTERVAL '30 days'"
            )
            await con.execute(
                "INSERT INTO yt_import_jobs "
                "(job_id, user_id, status, requested, processed, skipped, failed, options_enc) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                job_id,
                user_id,
                status,
                len(items),
                processed,
                skipped,
                failed,
                options_enc,
            )
            await con.executemany(
                "INSERT INTO yt_import_items "
                "(job_id, ordinal, link_enc, status, error_enc) VALUES ($1, $2, $3, $4, $5)",
                [
                    (
                        job_id,
                        item["ordinal"],
                        encrypt(key, item["link"]),
                        item["status"],
                        encrypt(key, item["error"]) if item["error"] else None,
                    )
                    for item in items
                ],
            )
    return {
        "job_id": job_id,
        "status": status,
        "requested": len(items),
        "processed": processed,
        "added": 0,
        "skipped": skipped,
        "failed": failed,
    }


async def get_youtube_import_status(user_id: int, job_id: str) -> Optional[Dict[str, Any]]:
    pool = await get_pool()
    async with pool.acquire() as con:
        job = await con.fetchrow(
            "SELECT job_id, status, requested, processed, added, skipped, failed "
            "FROM yt_import_jobs WHERE job_id = $1 AND user_id = $2",
            job_id,
            user_id,
        )
        if job is None:
            return None
        key = await vault.get(user_id)
        errors: List[str] = []
        if key is not None:
            rows = await con.fetch(
                "SELECT error_enc FROM yt_import_items "
                "WHERE job_id = $1 AND status = 'failed' AND error_enc IS NOT NULL "
                "ORDER BY ordinal LIMIT $2",
                job_id,
                MAX_STATUS_ERRORS,
            )
            errors = [decrypt(key, row["error_enc"]) or "" for row in rows]
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "requested": job["requested"],
        "processed": job["processed"],
        "added": job["added"],
        "skipped": job["skipped"],
        "failed": job["failed"],
        "errors": errors,
    }


async def _pending_user_ids() -> List[int]:
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT j.user_id FROM yt_import_jobs j "
            "JOIN yt_import_items i ON i.job_id = j.job_id "
            "WHERE j.status IN ('queued', 'running') AND (i.status = 'queued' OR "
            "(i.status = 'running' AND i.claimed_at < now() - "
            "make_interval(mins => $1))) "
            "GROUP BY j.user_id ORDER BY MIN(j.created_at)",
            CLAIM_STALE_AFTER_MINUTES,
        )
    return [row["user_id"] for row in rows]


async def _claim_one(user_id: int) -> Optional[Dict[str, Any]]:
    claim_token = uuid.uuid4().hex
    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            row = await con.fetchrow(
                "SELECT i.id, i.job_id, i.link_enc, j.options_enc "
                "FROM yt_import_items i JOIN yt_import_jobs j ON j.job_id = i.job_id "
                "WHERE j.user_id = $1 AND j.status IN ('queued', 'running') AND "
                "(i.status = 'queued' OR (i.status = 'running' AND i.claimed_at < "
                "now() - make_interval(mins => $2))) "
                "ORDER BY j.created_at, i.ordinal LIMIT 1 FOR UPDATE OF i SKIP LOCKED",
                user_id,
                CLAIM_STALE_AFTER_MINUTES,
            )
            if row is None:
                return None
            await con.execute(
                "UPDATE yt_import_items SET status = 'running', claimed_at = now(), "
                "claim_token = $2 WHERE id = $1",
                row["id"],
                claim_token,
            )
            await con.execute(
                "UPDATE yt_import_jobs SET status = 'running', updated_at = now() "
                "WHERE job_id = $1 AND status = 'queued'",
                row["job_id"],
            )
            return {**dict(row), "claim_token": claim_token}


async def _complete_item(
    item: Dict[str, Any],
    key: bytes,
    status: str,
    error: Optional[str] = None,
) -> None:
    error_enc = encrypt(key, error[:1200]) if error else None
    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            updated = await con.execute(
                "UPDATE yt_import_items SET status = $2, error_enc = $3, "
                "claimed_at = NULL, claim_token = NULL "
                "WHERE id = $1 AND status = 'running' AND claim_token = $4",
                item["id"],
                status,
                error_enc,
                item["claim_token"],
            )
            if updated == "UPDATE 0":
                return
            await con.execute(
                "UPDATE yt_import_jobs SET processed = processed + 1, "
                "added = added + $2, skipped = skipped + $3, failed = failed + $4, "
                "status = CASE WHEN processed + 1 >= requested THEN "
                "CASE WHEN failed + $4 > 0 THEN 'partial' ELSE 'completed' END "
                "ELSE 'running' END, updated_at = now() WHERE job_id = $1",
                item["job_id"],
                1 if status == "added" else 0,
                1 if status == "skipped" else 0,
                1 if status == "failed" else 0,
            )


async def _process_claim(item: Dict[str, Any], key: bytes, store: PgStore) -> None:
    link = decrypt(key, item["link_enc"]) or ""
    try:
        options = json.loads(decrypt(key, item["options_enc"]) or "{}")
        result = await add_youtube_channel_source(
            item.get("user_id") or 0,
            link,
            **options,
            skip_existing=True,
            store=store,
        )
        status = "added" if result.get("created", True) else "skipped"
        error = None
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        status = "failed"
        error = f"{link}: {str(exc) or 'source resolution failed'}"
    await _complete_item(item, key, status, error)


async def run_youtube_import_worker() -> None:
    """Claim durable items; network resolution is bounded by app worker count."""
    store = PgStore()
    while True:
        try:
            did_work = False
            for user_id in await _pending_user_ids():
                key = await vault.get(user_id)
                if key is None:
                    continue
                item = await _claim_one(user_id)
                if item is None:
                    continue
                item["user_id"] = user_id
                await _process_claim(item, key, store)
                did_work = True
                break
            if not did_work:
                await asyncio.sleep(0.75)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("YouTube subscription import worker failed")
            await asyncio.sleep(2)
