"""Yt manager — the scheduling loop.

Claim → run → release, with crash recovery:
- claim_due() atomically marks rows working=true (never processed twice).
- run_once() processes claimed rows concurrently — the gates, not this
  loop, own rate limiting (D4/D5).
- release_stale() frees claims orphaned by a crash (WORKING_STALE_SECONDS).
- Locked vaults pause their user's rows naturally (D9).
- run_forever() sleeps until the next due ts (or idle cadence).
"""
from __future__ import annotations

import asyncio
import time

from returns.result import Failure

from Config.Hardcoded.limits import MANAGER_IDLE_SLEEP_SECONDS, WORKING_STALE_SECONDS
from Database.pg_store import PgStore
from Orchestrator.Yt.pipeline import run_subscription
from Utility.logs import log


async def run_once(store: PgStore) -> int:
    """One pass: claim everything due, run it, release claims. Returns count."""
    subs = await store.claim_due()
    if not subs:
        return 0

    async def _run(sub) -> None:
        try:
            result = await run_subscription(store, sub)
            if isinstance(result, Failure):
                log.warning("sub %s failed: %s", sub.sub_id, result.failure())
        except Exception:
            log.exception("sub %s crashed", sub.sub_id)
        finally:
            await store.release(sub.sub_id)

    await asyncio.gather(*(_run(sub) for sub in subs))
    return len(subs)


async def run_forever(store: PgStore | None = None) -> None:
    """Long-lived loop (docker app / home server, D6)."""
    store = store or PgStore()
    log.info("yt manager started")
    while True:
        try:
            await store.release_stale(WORKING_STALE_SECONDS)
            processed = await run_once(store)
            if processed:
                continue  # burst: check again immediately

            next_ts = await store.next_due_ts()
            if next_ts is None:
                log.debug("nothing scheduled; sleeping %ss", MANAGER_IDLE_SLEEP_SECONDS)
                await asyncio.sleep(MANAGER_IDLE_SLEEP_SECONDS)
            else:
                wait = max(5.0, next_ts - time.time())
                log.debug("next due in %.0fs", wait)
                await asyncio.sleep(min(wait, MANAGER_IDLE_SLEEP_SECONDS * 10))
        except asyncio.CancelledError:
            log.info("yt manager cancelled")
            raise
        except Exception:
            log.exception("yt manager loop error; backing off")
            await asyncio.sleep(45)


if __name__ == "__main__":
    asyncio.run(run_forever())
