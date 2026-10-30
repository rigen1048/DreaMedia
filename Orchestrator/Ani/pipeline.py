"""Ani pipeline — happy-path orchestration for anime tracking.

Flow mirrors the Yt pipeline, with one scheduling difference: AniList
hands us nextAiringEpisode.airingAt, so we schedule on facts instead of
median-gap prediction. If nothing is airing, fall back to a weekly
recheck (rank intervals are media-agnostic, Config/Hardcoded/rank.py).
"""
from __future__ import annotations

import time
from typing import Optional

from returns.result import Failure, Result, Success

from Config.Hardcoded.rank import RANK_INTERVALS
from Database.store import DevStore, Subscription
from Gate.gate import registry as gates
from Orchestrator.Ani.Fetch.ani_track import ani_fetch
from Orchestrator.Yt.Filter.last_seen import filter_new_videos
from Utility.check_internet import wait_for_internet
from Utility.logs import log

FALLBACK_RECHECK = RANK_INTERVALS["week"]


def _next_airing_ts(payload) -> Optional[int]:
    """Earliest future airing timestamp across the season chain."""
    airing: list[int] = []
    for season in payload[0].values():
        next_ep = season.get("next_airing")
        if next_ep and next_ep.get("airingAt"):
            airing.append(int(next_ep["airingAt"]))
    return min(airing) if airing else None


async def run_subscription(
    store: DevStore, sub_id: int, sub: Subscription
) -> Result[str, str]:
    await wait_for_internet()

    result = await gates.submit((sub.user, "ani", sub.kind), lambda: ani_fetch(sub.link))
    if isinstance(result, Failure):
        log.warning("ani fetch failed for %s: %s", sub.link, result.failure())
        return Failure(result.failure())

    payload = result.unwrap()

    # Same last_seen contract as Yt: track the newest season we know.
    filtered = filter_new_videos(payload, sub.last_seen)
    if isinstance(filtered, Failure):
        msg = filtered.failure()
        if msg == "Same":
            counter = await store.bump_counter(sub_id, 1)
            log.info("no new season for %s (counter=%s)", sub.link, counter)
        elif isinstance(msg, tuple) and msg[0] == "Not Found":
            filtered = Success(payload)  # chain changed shape; resync below
        else:
            return Failure(str(msg))

    if not isinstance(filtered, Failure):
        new_seasons = filtered.unwrap()
        inserted = await store.save_videos(sub.user, new_seasons)
        if inserted:
            log.info("%s: %s new season(s) in feed", sub.link, inserted)

    latest_id = payload[0][max(payload[0])]["id"]
    ts = _next_airing_ts(payload) or (int(time.time()) + FALLBACK_RECHECK)
    await store.update_schedule(
        sub_id, ts=ts, rank="week", last_seen=latest_id, counter=0
    )
    log.info("done: %s — next check at ts=%s", sub.link, ts)
    return Success("done")


async def run_due(store: DevStore) -> None:
    import asyncio

    due = [
        (sid, s) for sid, s in await store.get_due() if s.media == "ani"
    ]
    if not due:
        log.info("no ani subscriptions due")
        return
    await asyncio.gather(*(run_subscription(store, sid, s) for sid, s in due))


if __name__ == "__main__":
    import asyncio

    async def demo() -> None:
        store = DevStore()
        await store.add_subscription(
            Subscription(user="demo", media="ani", kind="tracking", link="Naruto")
        )
        await run_due(store)
        feed = await store.feed("demo")
        print(f"\nFeed rows: {len(feed)}")
        for row in feed:
            print(
                f"- {row['title']} [{row['status']}] "
                f"eps={row['episodes']} next={row.get('next_airing')}"
            )

    asyncio.run(demo())
