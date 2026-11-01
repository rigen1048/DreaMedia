"""Ani manager — same claim/run/release discipline as the Yt manager.

Per D16 every plugin carries manager.py with the same job: drain due
schedule rows, run them through the pipeline concurrently (the gates own
rate limiting), release claims, sweep stale ones, sleep to next due.
"""
from __future__ import annotations

import asyncio
import time

from returns.result import Failure

from Admin.restore import restore_in_progress

from Admin import settings
from Config.Hardcoded.limits import MANAGER_IDLE_SLEEP_SECONDS, WORKING_STALE_SECONDS
from Database.ani_store import AniStore
from Orchestrator.Ani.pipeline import run_subscription
from Utility.logs import log


async def run_once(store: AniStore) -> int:
    if restore_in_progress():
        log.warning("restore in progress — ani manager idling this pass")
        return 0
    due = await store.claim_due()
    if not due:
        return 0

    async def _run(d) -> None:
        try:
            result = await run_subscription(store, d)
            if isinstance(result, Failure):
                log.warning("ani sub entry=%s s%s failed: %s", d.entry_id, d.season_no, result.failure())
        except Exception:
            log.exception("ani sub entry=%s s%s crashed", d.entry_id, d.season_no)
        finally:
            await store.release(d.entry_id, d.season_no, d.claim_token)

    await asyncio.gather(*(_run(d) for d in due))
    return len(due)


async def run_forever(store: AniStore | None = None) -> None:
    store = store or AniStore()
    log.info("ani manager started")
    while True:
        try:
            stale = int(await settings.get_typed("stale_claim_seconds") or WORKING_STALE_SECONDS)
            await store.release_stale(stale)
            processed = await run_once(store)
            if processed:
                continue
            next_ts = await store.next_due_ts()
            if next_ts is None:
                await asyncio.sleep(MANAGER_IDLE_SLEEP_SECONDS)
            else:
                wait = max(5.0, next_ts - time.time())
                await asyncio.sleep(min(wait, MANAGER_IDLE_SLEEP_SECONDS * 10))
        except asyncio.CancelledError:
            log.info("ani manager cancelled")
            raise
        except Exception:
            log.exception("ani manager loop error; backing off")
            await asyncio.sleep(45)


if __name__ == "__main__":
    asyncio.run(run_forever())
