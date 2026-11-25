"""Encrypted PostgreSQL queue for WebSocket JSON YouTube source imports.

Eight async workers per user drain non-overlapping queue sections, resolve
sources off the asyncio loop, and persist through the shared Add Source path.
"""
from __future__ import annotations

import asyncio
import json
import random
import re
import uuid
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlsplit

from returns.result import Failure

from Database import vault
from Database.crypto import decrypt, encrypt
from Database.db import get_pool
from Media.Yt.SQL.import_leases import (
    IMPORT_SECTION_LEASE_SECONDS,
    ImportWorkerLeaseLost,
    renew_import_worker_lease,
)
from Media.Yt.SQL.store import PgStore
from Utility.logs import log
from Utility.media_executor import run_youtube_network

MAX_IMPORT_CHANNELS = 2000
MAX_STATUS_ERRORS = 10
FINISHED_IMPORT_STATUSES = ("partial", "completed")
CLAIM_STALE_AFTER_MINUTES = 2
CLAIM_LEASE_REFRESH_SECONDS = 30
IMPORT_WORKERS_PER_USER = 8
IMPORT_IDLE_POLL_SECONDS = 1.0
IMPORT_ITEM_DELAY_SECONDS = 1.0
IMPORT_ERROR_BACKOFF_BASE_SECONDS = 2.0
IMPORT_ERROR_BACKOFF_MAX_SECONDS = 60.0
_USER_IMPORT_WORKERS: Dict[int, List[asyncio.Task]] = {}
_USER_IMPORT_WORKERS_LOOP: asyncio.AbstractEventLoop | None = None
_IMPORT_WORKER_WAKE: asyncio.Event | None = None
_CHANNEL_PATH = re.compile(r"^/(?:@[^/]+|channel/UC[A-Za-z0-9_-]{22})(?:/|$)", re.I)
_CHANNEL_KINDS = {"tracking", "wordscan", "random", "withhold"}


def _worker_retry_delay(attempt: int) -> float:
    """Capped exponential backoff with jitter for transient worker faults."""
    exponent = min(max(int(attempt) - 1, 0), 8)
    delay = IMPORT_ERROR_BACKOFF_BASE_SECONDS * (2 ** exponent)
    return min(
        IMPORT_ERROR_BACKOFF_MAX_SECONDS,
        delay * random.uniform(0.8, 1.2),
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


async def resolve_youtube_channel(user_id: int, link: str) -> Dict[str, Any]:
    """Resolve off-loop through the user's established YouTube network lane."""
    from Media.Yt.Fetch.convert import resolve_channel

    clean_link = link.strip()
    if not clean_link:
        raise ValueError("source link is required")
    network_task = asyncio.create_task(
        run_youtube_network(user_id, resolve_channel, clean_link)
    )
    try:
        resolved_result = await asyncio.shield(network_task)
    except asyncio.CancelledError:
        # The network task may already be running in a thread. Keep the durable
        # claim until it finishes instead of releasing it while work continues.
        try:
            await asyncio.shield(network_task)
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
    worker_section: Optional[int] = None,
    worker_lease_token: Optional[str] = None,
) -> Dict[str, Any]:
    target_store = store or PgStore()
    lease_options: Dict[str, Any] = {}
    if (worker_section is None) != (worker_lease_token is None):
        raise ValueError("worker section and lease token must be supplied together")
    if worker_lease_token is not None:
        lease_options = {
            "worker_section": worker_section,
            "worker_lease_token": worker_lease_token,
        }
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
        **lease_options,
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
    worker_section: Optional[int] = None,
    worker_lease_token: Optional[str] = None,
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
        user_id,
        resolved,
        options,
        skip_existing=skip_existing,
        store=store,
        worker_section=worker_section,
        worker_lease_token=worker_lease_token,
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
    resolved = await resolve_youtube_channel(user_id, link)
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


def normalize_source_payload(payload: Any) -> List[str]:
    """Extract links from the canonical ``{"sources": [...]}`` batch payload."""
    if not isinstance(payload, dict) or not isinstance(payload.get("sources"), list):
        raise ValueError("JSON payload must be an object with a 'sources' array")
    entries = payload["sources"]

    if not entries:
        raise ValueError("no sources found in JSON payload")
    if len(entries) > MAX_IMPORT_CHANNELS:
        raise ValueError(f"a batch can contain at most {MAX_IMPORT_CHANNELS} sources")

    links: List[str] = []
    for ordinal, entry in enumerate(entries):
        if isinstance(entry, dict):
            link = entry.get("link") or entry.get("url")
        else:
            link = None
        if not isinstance(link, str) or not link.strip():
            raise ValueError(f"source {ordinal + 1} must contain a non-empty link or url")
        links.append(link.strip())
    return links


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
                "WHERE status = ANY($1::text[]) "
                "AND created_at < now() - INTERVAL '30 days'",
                list(FINISHED_IMPORT_STATUSES),
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
                "(job_id, user_id, worker_section, ordinal, link_enc, status, error_enc) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7)",
                [
                    (
                        job_id,
                        user_id,
                        item["ordinal"] % IMPORT_WORKERS_PER_USER,
                        item["ordinal"],
                        encrypt(key, item["link"]),
                        item["status"],
                        encrypt(key, item["error"]) if item["error"] else None,
                    )
                    for item in items
                ],
            )
    _wake_import_worker_manager()
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


def _saved_import_options(key: bytes, options_enc: bytes) -> Dict[str, Any]:
    """Decode and normalize the source settings saved with an import batch."""
    try:
        options = json.loads(decrypt(key, options_enc) or "{}")
        if not isinstance(options, dict):
            raise TypeError("saved source settings must be an object")
        return normalize_source_options(**options)
    except (TypeError, ValueError) as error:
        raise ValueError("saved import settings could not be read") from error


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
        if job["status"] not in FINISHED_IMPORT_STATUSES:
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
    options = _saved_import_options(key, job["options_enc"])
    return await enqueue_youtube_import(user_id, retry_links, **options)


async def rerun_youtube_import(user_id: int, job_id: str) -> Dict[str, Any]:
    """Queue every original link again with the batch's saved source options."""
    key = await vault.get(user_id)
    if key is None:
        raise ValueError("vault locked; sign in again before rerunning this import")
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
        if job["status"] not in FINISHED_IMPORT_STATUSES:
            raise ValueError("wait for the import to finish before running it again")
        rows = await con.fetch(
            "SELECT link_enc FROM yt_import_items "
            "WHERE job_id = $1 ORDER BY ordinal",
            job_id,
        )
    links = [decrypt(key, row["link_enc"]) or "" for row in rows]
    if not any(links):
        raise ValueError("this import has no channel links to run again")
    options = _saved_import_options(key, job["options_enc"])
    return await enqueue_youtube_import(user_id, links, **options)


async def delete_youtube_import(user_id: int, job_id: str) -> bool:
    """Delete a finished import's progress rows without changing its sources."""
    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            job = await con.fetchrow(
                "SELECT status FROM yt_import_jobs "
                "WHERE job_id = $1 AND user_id = $2 FOR UPDATE",
                job_id,
                user_id,
            )
            if job is None:
                # Idempotent for a retry after an ambiguous prior response.
                return True
            if job["status"] not in FINISHED_IMPORT_STATUSES:
                raise ValueError("wait for the import to finish before deleting its history")
            result = await con.execute(
                "DELETE FROM yt_import_jobs WHERE job_id = $1 AND user_id = $2 "
                "AND status = ANY($3::text[])",
                job_id,
                user_id,
                list(FINISHED_IMPORT_STATUSES),
            )
    return result != "DELETE 0"


async def _pending_user_ids() -> List[int]:
    """Users with durable work, including claims abandoned by a crashed worker."""
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT j.user_id FROM yt_import_jobs j "
            "JOIN yt_import_items i ON i.job_id = j.job_id "
            "WHERE j.status IN ('queued', 'running') AND (i.status IN ('queued', 'resolved') "
            "OR (i.status IN ('resolving', 'processing') AND "
            "i.claimed_at < now() - make_interval(mins => $1))) "
            "GROUP BY j.user_id ORDER BY MIN(j.created_at)",
            CLAIM_STALE_AFTER_MINUTES,
        )
    return [row["user_id"] for row in rows]


def _wake_import_worker_manager() -> None:
    """Wake the single supervisor after a committed batch enqueue."""
    if _IMPORT_WORKER_WAKE is not None:
        _IMPORT_WORKER_WAKE.set()


async def _acquire_worker_section_lease(
    user_id: int, worker_section: int
) -> Optional[str]:
    """Acquire this section globally; another process may own it already."""
    owner_token = uuid.uuid4().hex
    pool = await get_pool()
    async with pool.acquire() as con:
        row = await con.fetchrow(
            "INSERT INTO yt_import_worker_leases "
            "(user_id, worker_section, owner_token, lease_until) "
            "VALUES ($1, $2, $3, now() + ($4 * interval '1 second')) "
            "ON CONFLICT (user_id, worker_section) DO UPDATE SET "
            "owner_token = EXCLUDED.owner_token, lease_until = EXCLUDED.lease_until "
            "WHERE yt_import_worker_leases.lease_until <= now() "
            "RETURNING owner_token",
            user_id,
            worker_section,
            owner_token,
            IMPORT_SECTION_LEASE_SECONDS,
        )
    return owner_token if row is not None else None


async def _release_worker_section_lease(
    user_id: int, worker_section: int, owner_token: str
) -> None:
    pool = await get_pool()
    async with pool.acquire() as con:
        await con.execute(
            "DELETE FROM yt_import_worker_leases "
            "WHERE user_id = $1 AND worker_section = $2 AND owner_token = $3",
            user_id,
            worker_section,
            owner_token,
        )


async def _claim_user_import_item(
    user_id: int, worker_section: int, worker_lease_token: str
) -> Optional[Dict[str, Any]]:
    """Claim one item from this user's section, preferring resolved writes."""
    claim_token = uuid.uuid4().hex
    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            row = await con.fetchrow(
                "SELECT i.id, i.job_id, i.link_enc, j.options_enc, i.resolved_enc, i.status "
                "FROM yt_import_items i JOIN yt_import_jobs j ON j.job_id = i.job_id "
                "JOIN yt_import_worker_leases l ON l.user_id = j.user_id "
                "AND l.worker_section = i.worker_section AND l.owner_token = $3 "
                "AND l.lease_until > now() "
                "WHERE j.user_id = $1 AND i.worker_section = $2 "
                "AND j.status IN ('queued', 'running') AND (i.status IN ('queued', 'resolved') "
                "OR (i.status IN ('resolving', 'processing') AND "
                "i.claimed_at < now() - make_interval(mins => $4))) "
                "ORDER BY CASE WHEN i.status IN ('resolved', 'processing') THEN 0 ELSE 1 END, "
                "j.created_at, i.ordinal LIMIT 1 FOR UPDATE OF i, l SKIP LOCKED",
                user_id,
                worker_section,
                worker_lease_token,
                CLAIM_STALE_AFTER_MINUTES,
            )
            if row is None:
                return None

            stage = "process" if row["status"] in {"resolved", "processing"} else "resolve"
            item_status = "processing" if stage == "process" else "resolving"
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
                "worker_section": worker_section,
                "worker_lease_token": worker_lease_token,
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


async def _renew_item_worker_lease(con: Any, item: Dict[str, Any]) -> None:
    if not await renew_import_worker_lease(
        con,
        item["user_id"],
        item["worker_section"],
        item["worker_lease_token"],
    ):
        raise ImportWorkerLeaseLost("lost the durable YouTube import section lease")


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
            await _renew_item_worker_lease(con, item)
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
            await _renew_item_worker_lease(con, item)
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


async def _resolve_claim(item: Dict[str, Any], key: bytes) -> bool:
    link = ""
    try:
        link = decrypt(key, item["link_enc"]) or ""
        resolved = await resolve_youtube_channel(item["user_id"], link)
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
    try:
        await _complete_resolution(item, key, resolved, error)
    except ImportWorkerLeaseLost:
        await _requeue_claim_for_retry(item, "queued")
        return False
    return resolved is not None


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
            worker_section=item["worker_section"],
            worker_lease_token=item["worker_lease_token"],
        )
        status = "added" if result.get("created", True) else "skipped"
        error = None
    except ImportWorkerLeaseLost:
        await _requeue_claim_for_retry(item, "resolved")
        return
    except asyncio.CancelledError:
        try:
            await _requeue_claim_for_retry(item, "resolved")
        except Exception:
            log.exception("Could not safely requeue canceled YouTube processing claim")
        raise
    except Exception as exc:
        status = "failed"
        error = f"{link}: {str(exc) or 'source could not be added'}"
    try:
        await _complete_processing(item, key, status, error)
    except ImportWorkerLeaseLost:
        await _requeue_claim_for_retry(item, "resolved")


async def _worker_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


async def _refresh_claim_lease(item: Dict[str, Any]) -> bool:
    claimed_status = "resolving" if item["stage"] == "resolve" else "processing"
    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            try:
                await _renew_item_worker_lease(con, item)
            except ImportWorkerLeaseLost:
                return False
            await con.execute(
                "UPDATE yt_import_items SET claimed_at = now() "
                "WHERE id = $1 AND status = $2 AND claim_token = $3",
                item["id"],
                claimed_status,
                item["claim_token"],
            )
    # Completion may clear the item claim just before this heartbeat; only
    # loss of the durable section token means the worker must stop.
    return True


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
            return


async def _run_claim_with_lease(
    item: Dict[str, Any], key: bytes, store: PgStore
) -> Optional[bool]:
    """Run one source while its durable user-section lease stays current."""
    lease_task = asyncio.create_task(_keep_claim_alive(item))
    if item["stage"] == "resolve":
        work_task = asyncio.create_task(_resolve_claim(item, key))
    else:
        work_task = asyncio.create_task(_process_claim(item, key, store))
    try:
        done, _ = await asyncio.wait(
            {work_task, lease_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if work_task in done:
            return await work_task
        work_task.cancel()
        await asyncio.gather(work_task, return_exceptions=True)
        raise RuntimeError("lost the durable YouTube import section lease")
    finally:
        if not work_task.done():
            work_task.cancel()
            await asyncio.gather(work_task, return_exceptions=True)
        lease_task.cancel()
        await asyncio.gather(lease_task, return_exceptions=True)


async def _run_user_import_worker(user_id: int, worker_section: int) -> None:
    """Drain one globally leased section of a user's durable queue."""
    store = PgStore()
    idle_cycles = 0
    consecutive_failures = 0
    while True:
        worker_lease_token: Optional[str] = None
        try:
            key = await vault.get(user_id)
            if key is None:
                consecutive_failures = 0
                idle_cycles += 1
                if idle_cycles >= 30:
                    return
                await _worker_sleep(IMPORT_IDLE_POLL_SECONDS)
                continue

            worker_lease_token = await _acquire_worker_section_lease(
                user_id, worker_section
            )
            if worker_lease_token is None:
                consecutive_failures = 0
                await _worker_sleep(IMPORT_IDLE_POLL_SECONDS)
                continue

            item = await _claim_user_import_item(
                user_id, worker_section, worker_lease_token
            )
            if item is None:
                consecutive_failures = 0
                idle_cycles += 1
                if idle_cycles >= 30:
                    return
                await _release_worker_section_lease(
                    user_id, worker_section, worker_lease_token
                )
                worker_lease_token = None
                await _worker_sleep(IMPORT_IDLE_POLL_SECONDS)
                continue

            idle_cycles = 0
            resolved = await _run_claim_with_lease(item, key, store)
            consecutive_failures = 0
            if item["stage"] != "resolve" or not resolved:
                await _worker_sleep(IMPORT_ITEM_DELAY_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            consecutive_failures += 1
            delay = _worker_retry_delay(consecutive_failures)
            log.exception(
                "YouTube import worker failed for user %s section %s; retrying in %.1fs: %s",
                user_id,
                worker_section,
                delay,
                exc,
            )
            await _worker_sleep(delay)
        finally:
            if worker_lease_token is not None:
                try:
                    await _release_worker_section_lease(
                        user_id, worker_section, worker_lease_token
                    )
                except Exception:
                    log.exception(
                        "Could not release YouTube worker lease for user %s section %s",
                        user_id,
                        worker_section,
                    )


def _ensure_user_import_workers(user_id: int) -> List[asyncio.Task]:
    """Start exactly eight section workers for a user on the current loop."""
    global _USER_IMPORT_WORKERS, _USER_IMPORT_WORKERS_LOOP
    loop = asyncio.get_running_loop()
    if _USER_IMPORT_WORKERS_LOOP is not loop:
        _USER_IMPORT_WORKERS = {}
        _USER_IMPORT_WORKERS_LOOP = loop
    workers = _USER_IMPORT_WORKERS.setdefault(user_id, [])
    while len(workers) < IMPORT_WORKERS_PER_USER:
        section = len(workers)
        workers.append(
            asyncio.create_task(
                _run_user_import_worker(user_id, section),
                name=f"yt-import-user-{user_id}-section-{section}",
            )
        )
    for section, task in enumerate(workers):
        if task.done():
            workers[section] = asyncio.create_task(
                _run_user_import_worker(user_id, section),
                name=f"yt-import-user-{user_id}-section-{section}",
            )
    return workers


async def stop_youtube_import_workers() -> None:
    """Cancel all per-user workers during application shutdown."""
    global _USER_IMPORT_WORKERS
    tasks = [task for workers in _USER_IMPORT_WORKERS.values() for task in workers]
    _USER_IMPORT_WORKERS = {}
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def run_youtube_import_worker_manager() -> None:
    """Start eight async section workers for each authenticated user with work."""
    global _IMPORT_WORKER_WAKE
    _IMPORT_WORKER_WAKE = asyncio.Event()
    consecutive_failures = 0
    try:
        while True:
            try:
                for user_id in await _pending_user_ids():
                    if await vault.get(user_id) is not None:
                        _ensure_user_import_workers(user_id)
                consecutive_failures = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                consecutive_failures += 1
                delay = _worker_retry_delay(consecutive_failures)
                log.exception(
                    "YouTube import worker manager scan failed; retrying in %.1fs: %s",
                    delay,
                    exc,
                )
                await _worker_sleep(delay)

            try:
                await asyncio.wait_for(
                    _IMPORT_WORKER_WAKE.wait(), timeout=IMPORT_IDLE_POLL_SECONDS
                )
            except asyncio.TimeoutError:
                pass
            _IMPORT_WORKER_WAKE.clear()
    finally:
        _IMPORT_WORKER_WAKE = None
        await stop_youtube_import_workers()
