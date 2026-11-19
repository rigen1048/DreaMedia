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

from Admin.restore import restore_in_progress
from Database.leader import is_leader

from Admin import settings
from Config.Hardcoded.limits import MANAGER_IDLE_SLEEP_SECONDS, WORKING_STALE_SECONDS
from Database.pg_store import PgStore
from Orchestrator.Yt.pipeline import run_subscription
from Utility.logs import log


# "Fetch now" (UI): the store nudges due timestamps, then the mutation rings
# this bell so the pass happens immediately instead of at the next tick.
# Still a single manager — no second worker, no duplicate claims.
_WAKE = asyncio.Event()


def wake() -> None:
    """Ask the manager loop to look for due rows right away."""
    _WAKE.set()


async def _nap(seconds: float) -> None:
    """Sleep for `seconds`, returning early when wake() is called."""
    if _WAKE.is_set():
        _WAKE.clear()
        return
    try:
        await asyncio.wait_for(_WAKE.wait(), timeout=max(0.0, seconds))
    except asyncio.TimeoutError:
        pass
    finally:
        _WAKE.clear()


async def run_once(store: PgStore) -> int:
    if not await is_leader():
        return 0  # Phase 1.3: another process runs the managers
    """One pass: claim everything due, run it, release claims. Returns count."""
    if restore_in_progress():
        log.warning("restore in progress — yt manager idling this pass")
        return 0
    purged = await store.purge_trash()  # D57: 24h trashbin window
    if purged:
        log.info("trashbin: purged %s yt video(s)", purged)
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
            await store.release(sub.sub_id, sub.claim_token)

    await asyncio.gather(*(_run(sub) for sub in subs))
    return len(subs)


async def run_forever(store: PgStore | None = None) -> None:
    """Long-lived loop (docker app / home server, D6)."""
    store = store or PgStore()
    log.info("yt manager started")
    while True:
        try:
            stale = int(await settings.get_typed("stale_claim_seconds") or WORKING_STALE_SECONDS)
            await store.release_stale(stale)
            processed = await run_once(store)
            if processed:
                continue  # burst: check again immediately

            next_ts = await store.next_due_ts()
            if next_ts is None:
                log.debug("nothing scheduled; sleeping %ss", MANAGER_IDLE_SLEEP_SECONDS)
                await _nap(MANAGER_IDLE_SLEEP_SECONDS)
            else:
                wait = max(5.0, next_ts - time.time())
                log.debug("next due in %.0fs", wait)
                await _nap(min(wait, MANAGER_IDLE_SLEEP_SECONDS * 10))
        except asyncio.CancelledError:
            log.info("yt manager cancelled")
            raise
        except Exception:
            log.exception("yt manager loop error; backing off")
            await _nap(45)


if __name__ == "__main__":
    asyncio.run(run_forever())
