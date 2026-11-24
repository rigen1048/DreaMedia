"""Encrypted PostgreSQL queue for bulk YouTube source additions.

Channel resolution uses the owner's shared network lane; source writes use the
same Add Source persistence path as individual imports. Item claims are durable.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import re
import uuid
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlsplit

from returns.result import Failure

from Database import vault
from Database.crypto import decrypt, encrypt
from Database.db import get_pool
from Media.Yt.SQL.store import PgStore
from Utility.logs import log
from Utility.media_executor import run_youtube_network

MAX_IMPORT_CHANNELS = 2000
MAX_STATUS_ERRORS = 10
CLAIM_STALE_AFTER_MINUTES = 2
CLAIM_LEASE_REFRESH_SECONDS = 30
DEFAULT_IMPORT_WORKERS = 64
DEFAULT_PROCESS_WORKERS = 16
MAX_IMPORT_WORKERS = 64
MAX_PROCESS_WORKERS = 16
IMPORT_IDLE_POLL_SECONDS = 1.0
IMPORT_ERROR_BACKOFF_BASE_SECONDS = 2.0
IMPORT_ERROR_BACKOFF_MAX_SECONDS = 60.0
_STAGE_POLL_LOOP: asyncio.AbstractEventLoop | None = None
_STAGE_POLL_LOCKS: Dict[str, asyncio.Lock] = {}
_STAGE_POLL_NOT_BEFORE: Dict[str, float] = {}
_STAGE_POLL_FAILURES: Dict[str, int] = {}
_CHANNEL_PATH = re.compile(r"^/(?:@[^/]+|channel/UC[A-Za-z0-9_-]{22})(?:/|$)", re.I)
_CHANNEL_KINDS = {"tracking", "wordscan", "random", "withhold"}


def _bounded_worker_count(env_name: str, default: int, maximum: int) -> int:
    raw = os.getenv(env_name, str(default))
    try:
        requested = int(raw)
    except (TypeError, ValueError):
        log.warning(
            "Invalid %s=%r; using %s",
            env_name,
            raw,
            default,
        )
        return default
    bounded = min(maximum, max(1, requested))
    if bounded != requested:
        log.warning(
            "%s=%s is outside 1..%s; using %s",
            env_name,
            requested,
            maximum,
            bounded,
        )
    return bounded


def import_worker_count() -> int:
    """Claim consumers; GateRegistry enforces per-user YT network pacing."""
    return _bounded_worker_count(
        "DREAMEDIA_YT_IMPORT_WORKERS", DEFAULT_IMPORT_WORKERS, MAX_IMPORT_WORKERS
    )


def process_worker_count() -> int:
    """Independent async source-write consumers; no network cooldown applies."""
    return _bounded_worker_count(
        "DREAMEDIA_YT_IMPORT_PROCESS_WORKERS",
        DEFAULT_PROCESS_WORKERS,
        MAX_PROCESS_WORKERS,
    )


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


async def resolve_youtube_channel(link: str, user_id: int) -> Dict[str, Any]:
    """Resolve through the owner's shared YT lane without holding a DB connection."""
    from Media.Yt.Fetch.convert import resolve_channel

    clean_link = link.strip()
    if not clean_link:
        raise ValueError("source link is required")
    thread_task = asyncio.create_task(
        run_youtube_network(user_id, resolve_channel, clean_link)
    )
    try:
        resolved_result = await asyncio.shield(thread_task)
    except asyncio.CancelledError:
        # Cancelling to_thread does not stop its underlying thread. Wait for
        # yt-dlp's configured socket timeout before releasing the queue claim.
        try:
            await asyncio.shield(thread_task)
        except Exception:
            pass
        raise
    if isinstance(resolved_result, Failure):
        raise ValueError(resolved_result.failure())
    resolved = resolved_result.unwrap()
    return {
        "rss_id": resolved.rss_id,
        "name": resolved.name,
        "url": resolved.url,
        "logo": resolved.logo,
    }


async def _store_resolved_source(
    user_id: int,
    resolved: Dict[str, Any],
    options: Dict[str, Any],
    *,
    skip_existing: bool,
    store: Optional[PgStore],
) -> Dict[str, Any]:
    target_store = store or PgStore()
    saved = await target_store.add_extension_subscription(
        user_id,
        rss_id=resolved["rss_id"],
        channel_name=resolved["name"],
        channel_url=resolved["url"],
        kind=options["kind"],
        words=options["words"],
        rank=options["rank"],
        withhold=options["withhold"],
        domain=options["domain"],
        subdomain=options["subdomain"],
        logo=resolved.get("logo"),
        skip_existing=skip_existing,
    )
    if isinstance(saved, Failure):
        raise ValueError(saved.failure())
    return saved.unwrap()


async def add_resolved_youtube_channel_source(
    user_id: int,
    resolved: Dict[str, Any],
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
    """Persist resolved metadata through the same atomic Add Source path."""
    options = normalize_source_options(
        kind=kind,
        words=words,
        rank=rank,
        withhold=withhold,
        domain=domain,
        subdomain=subdomain,
    )
    return await _store_resolved_source(
        user_id, resolved, options, skip_existing=skip_existing, store=store
    )


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
    """Resolve and store one source using the shared single-channel path."""
    options = normalize_source_options(
        kind=kind,
        words=words,
        rank=rank,
        withhold=withhold,
        domain=domain,
        subdomain=subdomain,
    )
    resolved = await resolve_youtube_channel(link, user_id)
    return await _store_resolved_source(
        user_id, resolved, options, skip_existing=skip_existing, store=store
    )


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
        valid_host = host in {"youtube.com", "www.youtube.com"}
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
                "(job_id, user_id, status, requested, processed, resolved, skipped, failed, options_enc) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                job_id,
                user_id,
                status,
                len(items),
                processed,
                0,
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
        "resolved": 0,
        "added": 0,
        "skipped": skipped,
        "failed": failed,
    }


async def get_youtube_import_status(
    user_id: int,
    job_id: str,
    *,
    include_items: bool = False,
) -> Optional[Dict[str, Any]]:
    pool = await get_pool()
    async with pool.acquire() as con:
        job = await con.fetchrow(
            "SELECT job_id, status, requested, processed, resolved, added, skipped, failed "
            "FROM yt_import_jobs WHERE job_id = $1 AND user_id = $2",
            job_id,
            user_id,
        )
        if job is None:
            return None
        key = await vault.get(user_id)
        errors: List[str] = []
        failures: List[Dict[str, Any]] = []
        items: List[Dict[str, Any]] = []
        if key is not None:
            item_filter = "" if include_items else " AND status = 'failed'"
            rows = await con.fetch(
                "SELECT ordinal, link_enc, error_enc, status FROM yt_import_items "
                "WHERE job_id = $1" + item_filter + " ORDER BY ordinal",
                job_id,
            )
            for row in rows:
                link = decrypt(key, row["link_enc"]) or ""
                error = decrypt(key, row["error_enc"])
                retryable = row["status"] == "failed" and bool(
                    link and _prepare_items([link])[0]["status"] == "queued"
                )
                item = {
                    "ordinal": row["ordinal"],
                    "link": link,
                    "status": row["status"],
                    "error": error or ("Import failed" if row["status"] == "failed" else None),
                    "retryable": retryable,
                }
                if include_items:
                    items.append(item)
                if row["status"] == "failed":
                    failures.append({
                        "link": item["link"],
                        "error": item["error"],
                        "retryable": item["retryable"],
                    })
            errors = [failure["error"] for failure in failures[:MAX_STATUS_ERRORS]]
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "requested": job["requested"],
        "processed": job["processed"],
        "resolved": job["resolved"],
        "added": job["added"],
        "skipped": job["skipped"],
        "failed": job["failed"],
        "errors": errors,
        "failed_items": failures,
        "items": items,
    }


async def retry_youtube_import(user_id: int, job_id: str) -> Dict[str, Any]:
    """Queue only valid failed links again, preserving the original options."""
    key = await vault.get(user_id)
    if key is None:
        raise ValueError("vault locked; sign in again before retrying failed channels")
    pool = await get_pool()
    async with pool.acquire() as con:
        job = await con.fetchrow(
            "SELECT status, options_enc FROM yt_import_jobs "
            "WHERE job_id = $1 AND user_id = $2",
            job_id,
            user_id,
        )
        if job is None:
            raise ValueError("import job was not found for this account")
        if job["status"] not in {"partial", "completed"}:
            raise ValueError("wait for the import to finish before retrying failures")
        rows = await con.fetch(
            "SELECT link_enc FROM yt_import_items "
            "WHERE job_id = $1 AND status = 'failed' ORDER BY ordinal",
            job_id,
        )
    links = [decrypt(key, row["link_enc"]) or "" for row in rows]
    retry_links = [
        link for link in links
        if link and _prepare_items([link])[0]["status"] == "queued"
    ]
    if not retry_links:
        raise ValueError("this import has no retryable failed channel links")
    options = json.loads(decrypt(key, job["options_enc"]) or "{}")
    return await enqueue_youtube_import(user_id, retry_links, **options)


def _stage_poll_lock(stage: str) -> asyncio.Lock:
    """Get the local scan/claim mutex, resetting state on a new event loop."""
    global _STAGE_POLL_LOOP, _STAGE_POLL_LOCKS
    loop = asyncio.get_running_loop()
    if _STAGE_POLL_LOOP is not loop:
        _STAGE_POLL_LOOP = loop
        _STAGE_POLL_LOCKS = {name: asyncio.Lock() for name in ("resolve", "process")}
        _STAGE_POLL_NOT_BEFORE.clear()
        _STAGE_POLL_FAILURES.clear()
    if stage not in _STAGE_POLL_LOCKS:
        raise ValueError(f"unknown import stage: {stage}")
    _STAGE_POLL_NOT_BEFORE.setdefault(stage, 0.0)
    _STAGE_POLL_FAILURES.setdefault(stage, 0)
    return _STAGE_POLL_LOCKS[stage]


def _worker_retry_delay(attempt: int) -> float:
    """Capped exponential backoff with jitter for transient DB/worker faults."""
    exponent = min(max(int(attempt) - 1, 0), 8)
    delay = IMPORT_ERROR_BACKOFF_BASE_SECONDS * (2 ** exponent)
    return min(
        IMPORT_ERROR_BACKOFF_MAX_SECONDS,
        delay * random.uniform(0.8, 1.2),
    )


async def _pending_user_ids(stage: str) -> List[int]:
    if stage == "resolve":
        predicate = (
            "(i.status = 'queued' OR (i.status = 'resolving' AND "
            "i.claimed_at < now() - make_interval(mins => $1)))"
        )
    elif stage == "process":
        predicate = (
            "(i.status = 'resolved' OR (i.status = 'processing' AND "
            "i.claimed_at < now() - make_interval(mins => $1)))"
        )
    else:
        raise ValueError(f"unknown import stage: {stage}")
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT j.user_id FROM yt_import_jobs j "
            "JOIN yt_import_items i ON i.job_id = j.job_id "
            f"WHERE j.status IN ('queued', 'running') AND {predicate} "
            "GROUP BY j.user_id ORDER BY MIN(j.created_at)",
            CLAIM_STALE_AFTER_MINUTES,
        )
    return [row["user_id"] for row in rows]


async def _claim_next_stage_item(stage: str):
    """Serialize local polling; PostgreSQL item claims coordinate concurrent workers."""
    lock = _stage_poll_lock(stage)
    loop = asyncio.get_running_loop()
    async with lock:
        wait_seconds = _STAGE_POLL_NOT_BEFORE[stage] - loop.time()
        if wait_seconds > 0:
            return None, None, wait_seconds
        try:
            for user_id in await _pending_user_ids(stage):
                key = await vault.get(user_id)
                if key is None:
                    continue
                item = await _claim_stage_item(user_id, stage)
                if item is not None:
                    _STAGE_POLL_FAILURES[stage] = 0
                    _STAGE_POLL_NOT_BEFORE[stage] = 0.0
                    return item, key, 0.0
            _STAGE_POLL_FAILURES[stage] = 0
            wait_seconds = IMPORT_IDLE_POLL_SECONDS * random.uniform(0.8, 1.2)
            _STAGE_POLL_NOT_BEFORE[stage] = loop.time() + wait_seconds
            return None, None, wait_seconds
        except Exception:
            _STAGE_POLL_FAILURES[stage] += 1
            _STAGE_POLL_NOT_BEFORE[stage] = (
                loop.time() + _worker_retry_delay(_STAGE_POLL_FAILURES[stage])
            )
            raise


async def _claim_stage_item(user_id: int, stage: str) -> Optional[Dict[str, Any]]:
    """Claim one durable item; PostgreSQL row locking prevents duplicate work."""
    if stage == "resolve":
        predicate = (
            "(i.status = 'queued' OR (i.status = 'resolving' AND "
            "i.claimed_at < now() - make_interval(mins => $2)))"
        )
        item_status = "resolving"
    elif stage == "process":
        predicate = (
            "(i.status = 'resolved' OR (i.status = 'processing' AND "
            "i.claimed_at < now() - make_interval(mins => $2)))"
        )
        item_status = "processing"
    else:
        raise ValueError(f"unknown import stage: {stage}")

    claim_token = uuid.uuid4().hex
    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            row = await con.fetchrow(
                "SELECT i.id, i.job_id, i.link_enc, j.options_enc, i.resolved_enc "
                "FROM yt_import_items i JOIN yt_import_jobs j ON j.job_id = i.job_id "
                f"WHERE j.user_id = $1 AND j.status IN ('queued', 'running') AND {predicate} "
                "ORDER BY j.created_at, i.ordinal LIMIT 1 FOR UPDATE OF i SKIP LOCKED",
                user_id,
                CLAIM_STALE_AFTER_MINUTES,
            )
            if row is None:
                return None

            await con.execute(
                "UPDATE yt_import_items SET status = $2, claimed_at = now(), "
                "claim_token = $3 WHERE id = $1",
                row["id"],
                item_status,
                claim_token,
            )
            await con.execute(
                "UPDATE yt_import_jobs SET status = 'running', updated_at = now() "
                "WHERE job_id = $1 AND status = 'queued'",
                row["job_id"],
            )
            return {
                **dict(row),
                "user_id": user_id,
                "stage": stage,
                "claim_token": claim_token,
            }


async def _requeue_claim_for_retry(
    item: Dict[str, Any],
    next_status: str,
) -> None:
    """Return a canceled claim to its stage queue without counting progress."""
    claimed_status = {"queued": "resolving", "resolved": "processing"}.get(next_status)
    if claimed_status is None:
        raise ValueError(f"invalid retry status: {next_status}")
    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            await con.execute(
                "UPDATE yt_import_items SET status = $2, claimed_at = NULL, claim_token = NULL "
                "WHERE id = $1 AND status = $3 AND claim_token = $4",
                item["id"],
                next_status,
                claimed_status,
                item["claim_token"],
            )


async def _complete_resolution(
    item: Dict[str, Any],
    key: bytes,
    resolved: Optional[Dict[str, Any]],
    error: Optional[str] = None,
) -> None:
    resolved_enc = encrypt(key, json.dumps(resolved, separators=(",", ":"))) if resolved else None
    error_enc = encrypt(key, error[:1200]) if error else None
    final_status = "resolved" if resolved else "failed"
    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            updated = await con.execute(
                "UPDATE yt_import_items SET status = $2, resolved_enc = $3, error_enc = $4, "
                "claimed_at = NULL, claim_token = NULL "
                "WHERE id = $1 AND status = 'resolving' AND claim_token = $5",
                item["id"],
                final_status,
                resolved_enc,
                error_enc,
                item["claim_token"],
            )
            if updated != "UPDATE 0":
                if resolved:
                    await con.execute(
                        "UPDATE yt_import_jobs SET resolved = resolved + 1, "
                        "status = 'running', updated_at = now() WHERE job_id = $1",
                        item["job_id"],
                    )
                else:
                    await con.execute(
                        "UPDATE yt_import_jobs SET processed = processed + 1, "
                        "failed = failed + 1, status = CASE "
                        "WHEN processed + 1 >= requested THEN 'partial' ELSE 'running' END, "
                        "updated_at = now() WHERE job_id = $1",
                        item["job_id"],
                    )


async def _complete_processing(
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
                "UPDATE yt_import_items SET status = $2, error_enc = $3, resolved_enc = NULL, "
                "claimed_at = NULL, claim_token = NULL "
                "WHERE id = $1 AND status = 'processing' AND claim_token = $4",
                item["id"],
                status,
                error_enc,
                item["claim_token"],
            )
            if updated != "UPDATE 0":
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


async def _resolve_claim(item: Dict[str, Any], key: bytes) -> None:
    link = ""
    try:
        link = decrypt(key, item["link_enc"]) or ""
        resolved = await resolve_youtube_channel(link, item["user_id"])
        error = None
    except asyncio.CancelledError:
        try:
            await _requeue_claim_for_retry(item, "queued")
        except Exception:
            log.exception("Could not safely requeue canceled YouTube resolution claim")
        raise
    except Exception as exc:
        resolved = None
        error = f"{link}: {str(exc) or 'channel resolution failed'}"
    await _complete_resolution(item, key, resolved, error)


async def _process_claim(item: Dict[str, Any], key: bytes, store: PgStore) -> None:
    link = ""
    try:
        link = decrypt(key, item["link_enc"]) or ""
        options = json.loads(decrypt(key, item["options_enc"]) or "{}")
        resolved = json.loads(decrypt(key, item["resolved_enc"]) or "{}")
        result = await add_resolved_youtube_channel_source(
            item["user_id"],
            resolved,
            **options,
            skip_existing=True,
            store=store,
        )
        status = "added" if result.get("created", True) else "skipped"
        error = None
    except asyncio.CancelledError:
        try:
            await _requeue_claim_for_retry(item, "resolved")
        except Exception:
            log.exception("Could not safely requeue canceled YouTube processing claim")
        raise
    except Exception as exc:
        status = "failed"
        error = f"{link}: {str(exc) or 'source could not be added'}"
    await _complete_processing(item, key, status, error)


async def _worker_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


async def _refresh_claim_lease(item: Dict[str, Any]) -> bool:
    claimed_status = "resolving" if item["stage"] == "resolve" else "processing"
    pool = await get_pool()
    async with pool.acquire() as con:
        result = await con.execute(
            "UPDATE yt_import_items SET claimed_at = now() "
            "WHERE id = $1 AND status = $2 AND claim_token = $3",
            item["id"],
            claimed_status,
            item["claim_token"],
        )
    return result != "UPDATE 0"


async def _keep_claim_alive(item: Dict[str, Any]) -> None:
    while True:
        await asyncio.sleep(CLAIM_LEASE_REFRESH_SECONDS)
        try:
            if not await _refresh_claim_lease(item):
                return
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Could not refresh YouTube import claim lease for item %s", item["id"])


async def _run_stage_worker(stage: str) -> None:
    store = PgStore()
    consecutive_failures = 0
    while True:
        try:
            item, key, wait_seconds = await _claim_next_stage_item(stage)
            if item is None:
                consecutive_failures = 0
                await _worker_sleep(wait_seconds + random.random() * 0.15)
                continue
            consecutive_failures = 0
            lease_task = asyncio.create_task(_keep_claim_alive(item))
            try:
                if stage == "resolve":
                    await _resolve_claim(item, key)
                else:
                    await _process_claim(item, key, store)
            finally:
                lease_task.cancel()
                await asyncio.gather(lease_task, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            consecutive_failures += 1
            delay = _worker_retry_delay(consecutive_failures)
            log.exception(
                "YouTube subscription import %s worker failed; retrying in %.1fs: %s",
                stage,
                delay,
                exc,
            )
            await _worker_sleep(delay)


async def run_youtube_import_resolver_worker() -> None:
    """Resolve channel metadata through per-user GateRegistry network lanes."""
    await _run_stage_worker("resolve")


async def run_youtube_import_processor_worker() -> None:
    """Apply the shared Add Source path without any network rest delay."""
    await _run_stage_worker("process")
