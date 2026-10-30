"""Yt pipeline — happy-path orchestration per subscription.

Flow (100% async):
    fetch (through the per-(user, media, kind) queued gate — D4/D5)
    → last_seen filter (not for random)
    → word filter (wordscan only)
    → ts/rank prediction (not for random — rank is user-controlled)
    → save videos + schedule via the store interface

Fetch-level failures return Failure; the caller (future manager) decides
blacklisting/notifications. Per D15 nothing here ever auto-deletes a
subscription.
"""
from __future__ import annotations

from typing import Awaitable, Callable, Dict

from returns.result import Failure, Result, Success

from Config.Hardcoded.rank import RANK_INTERVALS
from Database.store import DevStore, Subscription
from Gate.gate import registry as gates
from Model.video import FetchPayload
from Orchestrator.Yt.Fetch.yt_playlist import yt_playlist
from Orchestrator.Yt.Fetch.yt_random import yt_random
from Orchestrator.Yt.Fetch.yt_rss import yt_rss
from Orchestrator.Yt.Filter.last_seen import filter_new_videos
from Orchestrator.Yt.Filter.scan import filter_words
from Orchestrator.Yt.Filter.time import ts_proccess
from Utility.check_internet import wait_for_internet
from Utility.logs import log

FETCHERS: Dict[str, Callable[[str], Awaitable[Result[FetchPayload, str]]]] = {
    "tracking": yt_rss,
    "wordscan": yt_rss,
    "playlist": yt_playlist,
    "random": yt_random,
}


async def run_subscription(
    store: DevStore, sub_id: int, sub: Subscription
) -> Result[str, str]:
    """Run one subscription end-to-end. Returns Success('done') | Failure(msg)."""
    await wait_for_internet()

    fetcher = FETCHERS.get(sub.kind)
    if fetcher is None:
        return Failure(f"Unknown kind: {sub.kind}")

    # 1. Fetch through this subscription's own gate.
    result = await gates.submit(
        (sub.user, "yt", sub.kind), lambda: fetcher(sub.link)
    )
    if isinstance(result, Failure):
        log.warning("fetch failed for %s (%s): %s", sub.link, sub.kind, result.failure())
        return Failure(result.failure())

    payload = result.unwrap()

    # 2. Last-seen filter (everything except random).
    if sub.kind != "random":
        filtered = filter_new_videos(payload, sub.last_seen)
        if isinstance(filtered, Failure):
            msg = filtered.failure()
            if msg == "Same":
                counter = await store.bump_counter(sub_id, 1)
                log.info("nothing new for %s (counter=%s)", sub.link, counter)
                return Success("done")
            # "Not Found" — last_seen fell out of the feed; take latest.
            if isinstance(msg, tuple) and msg[0] == "Not Found":
                payload = msg[1]
                latest = payload[0][min(payload[0])]
                await store.save_videos(sub.user, ({1: latest},))
                await store.update_schedule(sub_id, last_seen=latest["id"])
                return Success("done")
            return Failure(str(msg))
        payload = filtered.unwrap()

    # 3. Word filter (wordscan only).
    if sub.kind == "wordscan":
        filtered = filter_words(payload, sub.words)
        if isinstance(filtered, Failure):
            await store.bump_counter(sub_id, 1)
            return Success("done")
        payload = filtered.unwrap()

    # 4. Save new videos.
    inserted = await store.save_videos(sub.user, payload)
    latest_id = payload[0][min(payload[0])]["id"] if payload and payload[0] else None

    # 5. Schedule next check.
    if sub.kind == "random":
        # Rank is user-controlled: next pick = now + rank interval.
        import time

        interval = RANK_INTERVALS.get(sub.rank, RANK_INTERVALS["week"])
        await store.update_schedule(
            sub_id, ts=int(time.time()) + interval, last_seen=latest_id
        )
    else:
        ts_result = ts_proccess(payload)
        if isinstance(ts_result, Success):
            ts, rank = ts_result.unwrap()
            await store.update_schedule(
                sub_id, ts=ts, rank=rank, last_seen=latest_id, counter=0
            )
        else:
            await store.bump_counter(sub_id, 1)
            log.warning("ts prediction failed for %s: %s", sub.link, ts_result.failure())

    log.info(
        "done: %s (%s) — %s new video(s), last_seen=%s",
        sub.link, sub.kind, inserted, latest_id,
    )
    return Success("done")


async def run_due(store: DevStore) -> None:
    """Happy-path manager: drain every due subscription concurrently.

    Concurrency is safe because the gates — not this loop — own rate
    limiting; each (user, media, kind) queue serializes its own fetches.
    """
    import asyncio

    due = await store.get_due()
    if not due:
        log.info("nothing due")
        return
    await asyncio.gather(
        *(run_subscription(store, sub_id, sub) for sub_id, sub in due)
    )


if __name__ == "__main__":
    import asyncio

    async def demo() -> None:
        store = DevStore()
        await store.add_subscription(
            Subscription(
                user="demo",
                media="yt",
                kind="tracking",
                link="UCX6OQ3DkcsbYNE6H8uQQuVA",  # MrBeast
            )
        )
        await run_due(store)
        feed = await store.feed("demo")
        print(f"\nFeed rows: {len(feed)}")
        for row in feed[:5]:
            print(f"- {row['title']}  ({row['published']})")

    asyncio.run(demo())
