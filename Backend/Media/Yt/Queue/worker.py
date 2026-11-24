"""Unified queue worker — 8 per-user sections, 1 req/s per worker.

Each worker:
1. Polls for users with pending items in its section
2. Claims one item (user_id + worker_section + status='queued')
3. Resolves the channel via yt-dlp through the shared per-user Gate lane
4. Feeds it to the manager via add_extension_subscription() (+ wake())
5. Sends a `success` or `news` message to the extension over WebSocket
6. Sleeps 1 second, then claims the next item

8 workers × 1 req/s = 8 req/s per user. Workers never overlap on the same
item because each owns its section (worker_section = ordinal % 8).
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Optional

from returns.result import Failure, Result, Success

from Database import vault
from Database.crypto import decrypt, encrypt, index_hash
from Database.db import get_pool
from Gate.gate import registry as gates
from Media.Yt.SQL.store import PgStore
from Media.Yt.Fetch.convert import resolve_channel
from Utility.media_executor import run_youtube_network
from Utility.logs import log
from Media.Yt.manager import wake

WORKER_SLEEP_SECONDS = 1.0
IDLE_POLL_SECONDS = 1.0
MAX_SECTIONS = 8

# Per-user active worker count — ensures at most 8 concurrent workers per user.
_active_workers: dict[int, int] = {}


async def _increment_user_worker(user_id: int) -> bool:
    """Return True if this worker may proceed (under the 8-per-user cap)."""
    count = _active_workers.get(user_id, 0)
    if count >= MAX_SECTIONS:
        return False
    _active_workers[user_id] = count + 1
    return True


async def _decrement_user_worker(user_id: int) -> None:
    count = _active_workers.get(user_id, 0)
    if count > 0:
        _active_workers[user_id] = count - 1


async def _claim_queue_item(
    pool, user_id: int, section: int
) -> Optional[dict]:
    """Claim one queued item for this user's section. Returns None if empty."""
    claim_token = uuid.uuid4().hex
    async with pool.acquire() as con:
        async with con.transaction():
            row = await con.fetchrow(
                """
                SELECT i.id, i.link_enc, i.job_id, i.ordinal
                FROM yt_import_items i
                WHERE i.user_id = $1
                  AND i.worker_section = $2
                  AND i.status = 'queued'
                ORDER BY i.id
                LIMIT 1
                FOR UPDATE OF i SKIP LOCKED
                """,
                user_id,
                section,
            )
            if row is None:
                return None
            await con.execute(
                """
                UPDATE yt_import_items
                SET status = 'resolving', claimed_at = now(), claim_token = $3
                WHERE id = $1
                """,
                row["id"],
                claim_token,
            )
            return {
                "id": row["id"],
                "job_id": row["job_id"],
                "ordinal": row["ordinal"],
                "link_enc": row["link_enc"],
                "claim_token": claim_token,
            }


async def _complete_queue_item(
    pool,
    item_id: int,
    status: str,
    error: Optional[str] = None,
    key: Optional[bytes] = None,
) -> None:
    """Mark a claimed item as resolved/failed and clear its claim."""
    error_enc = encrypt(key, error[:1200]) if (key and error) else None
    async with pool.acquire() as con:
        if error_enc is not None:
            await con.execute(
                """
                UPDATE yt_import_items
                SET status = $2, claimed_at = NULL, claim_token = NULL,
                    error_enc = $3
                WHERE id = $1
                """,
                item_id,
                status,
                error_enc,
            )
        else:
            await con.execute(
                """
                UPDATE yt_import_items
                SET status = $2, claimed_at = NULL, claim_token = NULL
                WHERE id = $1
                """,
                item_id,
                status,
            )


async def _process_item(
    store: PgStore, user_id: int, link_enc: bytes, claim_token: str
) -> Result[dict, str]:
    """Resolve one channel link and add it as a subscription.

    Returns the channel result on success, or a Failure on error.
    """
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9); sign in again before importing")

    link = decrypt(key, link_enc) or ""
    if not link:
        return Failure("empty link in queue item")

    # Resolve through the shared per-user YT network lane (rate-limited by Gate).
    resolved = await gates.submit(
        (user_id, "yt", "resolve"),
        lambda: run_youtube_network(user_id, resolve_channel, link),
    )
    if isinstance(resolved, Failure):
        return Failure(f"{link}: {resolved.failure()}")
    info = resolved.unwrap()

    # Persist via the manager-facing store (creates channel + tracking row, wakes manager).
    result = await store.add_extension_subscription(
        user_id,
        channel_name=info.name,
        channel_url=info.url,
        kind="tracking",
        rss_id=info.rss_id,
        logo=info.logo,
        skip_existing=True,
    )
    if isinstance(result, Failure):
        return Failure(f"{link}: {result.failure()}")

    return Success(
        {
            "channel_id": result.unwrap()["channel_id"],
            "name": info.name,
            "url": info.url,
            "rss_id": info.rss_id,
        }
    )


async def _send_extension_message(user_id: int, msg_type: str, payload: dict) -> None:
    """Publish a `success`/`news` message to the extension's WebSocket lane.

    If the WebSocket isn't available, the message is dropped — the extension
    can poll the REST endpoint for missed items.
    """
    try:
        from Extension.ws_router import broadcast_to_user
        await broadcast_to_user(user_id, {"type": msg_type, **payload})
    except Exception:
        # WebSocket broadcast is best-effort; the extension polls for missed items.
        log.debug("could not broadcast %s to user %s", msg_type, user_id)


async def _run_section_worker(user_id: int, section: int) -> None:
    """One worker loop for one (user, section). Claims, feeds, sleeps 1s."""
    store = PgStore()
    pool = await get_pool()

    while True:
        try:
            item = await _claim_queue_item(pool, user_id, section)
            if item is None:
                await asyncio.sleep(IDLE_POLL_SECONDS)
                continue

            key = await vault.get(user_id)
            result = await _process_item(
                store, user_id, item["link_enc"], item["claim_token"]
            )

            if isinstance(result, Success):
                data = result.unwrap()
                await _complete_queue_item(
                    pool, item["id"], "added", key=key
                )
                await _send_extension_message(
                    user_id,
                    "success",
                    {
                        "jobId": item["job_id"],
                        "ordinal": item["ordinal"],
                        "channelId": data["channel_id"],
                        "name": data["name"],
                        "url": data["url"],
                    },
                )
                log.info(
                    "queue worker user=%s section=%s added channel %s (%s)",
                    user_id, section, data["name"], data["url"],
                )
            else:
                await _complete_queue_item(
                    pool, item["id"], "failed", error=result.failure(), key=key
                )
                await _send_extension_message(
                    user_id,
                    "news",
                    {
                        "jobId": item["job_id"],
                        "ordinal": item["ordinal"],
                        "error": result.failure(),
                    },
                )
                log.warning(
                    "queue worker user=%s section=%s failed item %s: %s",
                    user_id, section, item["id"], result.failure(),
                )

        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("queue worker user=%s section=%s crashed", user_id, section)
            await asyncio.sleep(WORKER_SLEEP_SECONDS)

        # 1 second sleep between feeds (rate limit: 1 req/s per worker).
        await asyncio.sleep(WORKER_SLEEP_SECONDS)


# ---------------------------------------------------------------------------
# Worker pool management — started from App.main lifespan
# ---------------------------------------------------------------------------

_user_workers: dict[int, list[asyncio.Task]] = {}


async def _ensure_user_workers(user_id: int) -> None:
    """Start up to 8 workers for a user when they have pending queue items."""
    existing = _user_workers.get(user_id)
    if existing and not all(t.done() for t in existing):
        return  # already running

    workers: list[asyncio.Task] = []
    for section in range(MAX_SECTIONS):
        workers.append(asyncio.create_task(_run_section_worker(user_id, section)))
    _user_workers[user_id] = workers


async def stop_user_workers(user_id: int) -> None:
    """Stop all queue workers for a user (shutdown)."""
    workers = _user_workers.pop(user_id, [])
    for w in workers:
        w.cancel()
    if workers:
        await asyncio.gather(*workers, return_exceptions=True)


async def enqueue_sources(
    user_id: int,
    links: list[str],
    *,
    job_id: Optional[str] = None,
) -> str:
    """Enqueue one or more channel links into the unified queue.

    Called by the REST endpoint (JSON file upload), CSV import, and backup
    restore. Returns the job_id.
    """
    import json as _json

    if not job_id:
        job_id = uuid.uuid4().hex

    key = await vault.get(user_id)
    if key is None:
        raise ValueError("vault locked (D9); sign in again before importing")

    pool = await get_pool()
    async with pool.acquire() as con:
        async with con.transaction():
            # Create the job row
            await con.execute(
                """
                INSERT INTO yt_import_jobs (job_id, user_id, status, requested, processed, resolved, added, skipped, failed, options_enc)
                VALUES ($1, $2, 'queued', $3, 0, 0, 0, 0, 0, $4)
                """,
                job_id,
                user_id,
                len(links),
                encrypt(key, _json.dumps({}, separators=(",", ":"))),
            )

            for ordinal, link in enumerate(links):
                section = ordinal % MAX_SECTIONS
                await con.execute(
                    """
                    INSERT INTO yt_import_items (job_id, user_id, ordinal, link_enc, worker_section, status)
                    VALUES ($1, $2, $3, $4, $5, 'queued')
                    """,
                    job_id,
                    user_id,
                    ordinal,
                    encrypt(key, link),
                    section,
                )

    # Start workers for this user if not already running
    await _ensure_user_workers(user_id)
    log.info("enqueued %s source(s) for user %s as job %s", len(links), user_id, job_id)
    return job_id
