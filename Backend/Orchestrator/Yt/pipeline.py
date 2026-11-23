"""Yt pipeline — happy-path orchestration per subscription (Postgres-backed).

Flow (100% async):
    bounded internet wait (outage → 'We cannot access the internet' alert)
    → fetch (through the shared per-user YT network lane)
    → last_seen filter (not for random)
    → word filter (wordscan only)
    → ts/rank prediction (not for random — rank is user-controlled)
    → save videos + schedule

Unhappy paths (D60): fetch failures check EXISTENCE before crying
'deleted' (channel/playlist/last-seen video), alert the bell once per
outage, and per D15 never auto-delete a subscription — the user deletes
or reports. Feed is pull-only: nothing here ever writes to the bell on
the happy path.
"""
from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable, Dict

from returns.result import Failure, Result, Success

from Config.Hardcoded import limits
from Config.Hardcoded.limits import backoff_seconds

from Config.Hardcoded.rank import RANK_INTERVALS
from Database.pg_store import PgStore, PgSubscription
from Gate.gate import registry as gates
from Model.video import FetchPayload
from Orchestrator.Yt.Fetch.yt_playlist import yt_playlist
from Orchestrator.Yt.Fetch.yt_random import yt_random
from Orchestrator.Yt.Fetch.yt_rss import yt_rss
from Orchestrator.Yt.Filter.last_seen import filter_new_videos
from Orchestrator.Yt.Filter.scan import filter_words
from Orchestrator.Yt.Filter.time import ts_proccess
from Orchestrator.Yt.Utility import yt_valid
from Utility.alert import alert_outage, clear_outage
from Utility.check_internet import wait_for_internet_bounded
from Utility.logs import log

FETCHERS: Dict[str, Callable[[str], Awaitable[Result[FetchPayload, str]]]] = {
    "tracking": yt_rss,
    "wordscan": yt_rss,
    "playlist": yt_playlist,
    "random": yt_random,
}

REPORT = "Issue spotted, please report to the dev"
_YT_OUTAGE_KINDS = (
    "channel_deleted", "playlist_deleted", "last_seen_deleted",
    "fetcher_rss", "fetcher_playlist", "fetcher_random",
)


async def _channel_name(store: PgStore, sub: PgSubscription) -> str:
    try:
        meta = await store.channel_meta(sub.user_id, sub.sub_id)
        return meta.get("name") or sub.link
    except Exception:
        return sub.link


async def _alert_if_not_muted(store: PgStore, sub: PgSubscription, kind: str,
                              payload: dict, **kwargs) -> None:
    """Feed-sourced unhappy paths respect the per-scope notify flags (D60)."""
    try:
        if not await store.notify_enabled(sub.user_id, sub.sub_id):
            return
    except Exception:
        log.exception("notify gate failed for channel %s; alerting anyway", sub.sub_id)
    await alert_outage(sub.user_id, "yt", kind, payload, **kwargs)


async def _backoff(store: PgStore, sub: PgSubscription) -> None:
    """Reschedule a failed row — without this it stays due in a tight loop."""
    counter = await store.bump_counter(sub.sub_id, 1, sub.kind)
    await store.update_schedule(sub, ts=int(time.time()) + backoff_seconds(max(counter or 1, 1)))


async def _handle_fetch_failure(
    store: PgStore, sub: PgSubscription, result: Result[FetchPayload, str]
) -> Result[FetchPayload, str]:
    """Existence checks + unhappy-path alerts (the owner's orchestration).

    Order: is the SOURCE gone? → alert 'deleted'. Source alive but the
    fetcher keeps failing? → alert 'report to the dev'. Ambiguous
    existence (None) never alerts — a flaky network is not a deletion.
    """
    name = await _channel_name(store, sub)

    if sub.kind in ("tracking", "wordscan"):
        exists = await gates.submit(
            (sub.user_id, "yt", sub.kind), lambda: yt_valid.channel_exists(sub.link)
        )
        if exists is False:
            await _alert_if_not_muted(
                store, sub, "channel_deleted",
                {"channel": name, "url": sub.link},
                title="Channel may got deleted",
                message=f"{name} — we can no longer reach this channel; delete it or report it",
                level="warning",
            )
            return Failure("Deleted:Channel")

        # Source alive (or undecidable): retry transient HTTP errors.
        if result.failure() == "HTTP Error":
            for _ in range(limits.FETCH_RETRIES):
                await asyncio.sleep(limits.RETRY_DELAY_SECONDS)
                result = await gates.submit(
                    (sub.user_id, "yt", sub.kind), lambda: FETCHERS[sub.kind](sub.link)
                )
                if isinstance(result, Success) or result.failure() != "HTTP Error":
                    break

        if isinstance(result, Failure):
            await _alert_if_not_muted(
                store, sub, "fetcher_rss",
                {"channel": name, "error": result.failure()},
                title=f"RSS Fetcher — {REPORT}",
                message=f"{name}: {result.failure()}",
                level="error",
            )
            return Failure(f"Fetcher:RSS({result.failure()})")
        return result

    if sub.kind == "playlist":
        exists = await gates.submit(
            (sub.user_id, "yt", sub.kind), lambda: yt_valid.playlist_exists(sub.link)
        )
        if exists is False:
            await _alert_if_not_muted(
                store, sub, "playlist_deleted",
                {"channel": name, "playlist": sub.link},
                title="Playlist may got deleted",
                message=f"{name} — this playlist is gone; delete it or report it",
                level="warning",
            )
            return Failure("Deleted:PlayList")
        await _alert_if_not_muted(
            store, sub, "fetcher_playlist",
            {"channel": name, "playlist": sub.link, "error": result.failure()},
            title=f"Playlist Fetcher — {REPORT}",
            message=f"{name}: {result.failure()}",
            level="error",
        )
        return Failure(f"Fetcher:PlayList({result.failure()})")

    if sub.kind == "random":
        await _alert_if_not_muted(
            store, sub, "fetcher_random",
            {"channel": name, "error": result.failure()},
            title=f"Random Fetcher — {REPORT}",
            message=f"{name}: {result.failure()}",
            level="error",
        )
        return Failure(f"Fetcher:Random({result.failure()})")

    return result


async def run_subscription(store: PgStore, sub: PgSubscription) -> Result[str, str]:
    """Run one subscription end-to-end. Success('done') | Failure(msg)."""
    if not await wait_for_internet_bounded(limits.INTERNET_WAIT_SECONDS):
        # Operational alert — unconditional (not feed-sourced, D60).
        await alert_outage(
            sub.user_id, "process", "no_internet", {},
            title="We cannot access the internet",
            message="Pipelines are paused until connectivity returns",
            level="error",
        )
        await _backoff(store, sub)
        return Failure("no-internet")
    clear_outage(sub.user_id, "no_internet")

    fetcher = FETCHERS.get(sub.kind)
    if fetcher is None:
        return Failure(f"Unknown kind: {sub.kind}")

    # 1. Only the network call enters the shared lane; post-fetch work is free.
    result = await gates.submit((sub.user_id, "yt", sub.kind), lambda: fetcher(sub.link))
    if isinstance(result, Failure):
        log.warning("fetch failed for %s (%s): %s", sub.link, sub.kind, result.failure())
        result = await _handle_fetch_failure(store, sub, result)
        if isinstance(result, Failure):
            await _backoff(store, sub)
            return Failure(result.failure())

    clear_outage(sub.user_id, *_YT_OUTAGE_KINDS)
    payload = result.unwrap()

    # 2. Last-seen filter (everything except random).
    if sub.kind != "random":
        filtered = filter_new_videos(payload, sub.last_seen)
        if isinstance(filtered, Failure):
            msg = filtered.failure()
            if msg == "Same":
                counter = await store.bump_counter(sub.sub_id, 1, sub.kind)
                # Schedule the next check instead of staying immediately due
                # (2026 review: 'Same' returned without advancing ts).
                await store.update_schedule(
                    sub, ts=int(time.time()) + backoff_seconds(max(counter or 1, 1))
                )
                log.info("nothing new for %s (counter=%s)", sub.link, counter)
                return Success("done")
            if isinstance(msg, tuple) and msg[0] == "Not Found":
                # last_seen fell out of the feed window. Is it GONE?
                if sub.last_seen:
                    exists = await gates.submit(
                        (sub.user_id, "yt", sub.kind),
                        lambda: yt_valid.video_exists(sub.last_seen),
                    )
                    if exists is False:
                        name = await _channel_name(store, sub)
                        await _alert_if_not_muted(
                            store, sub, "last_seen_deleted",
                            {"channel": name, "videoId": sub.last_seen},
                            title="Last seen video may got deleted",
                            message=f"{name} — the previous anchor video is gone",
                            level="warning",
                        )
                # Take the feed's latest as the new anchor and move on.
                payload = msg[1]
                latest = payload[0][min(payload[0])]
                await store.save_videos_detailed(sub, ({1: latest},))
                await store.update_schedule(sub, last_seen=latest["id"])
                return Success("done")
            return Failure(str(msg))
        payload = filtered.unwrap()

    # 3. Word filter (wordscan only).
    if sub.kind == "wordscan":
        filtered = filter_words(payload, sub.words)
        if isinstance(filtered, Failure):
            counter = await store.bump_counter(sub.sub_id, 1, sub.kind)
            await store.update_schedule(
                sub, ts=int(time.time()) + backoff_seconds(max(counter or 1, 1))
            )
            return Success("done")
        payload = filtered.unwrap()

    # 4. Save new videos into the media feed table. The feed is pull-only
    #    (D60): the frontend reads yt_videos via GraphQL — nothing is pushed.
    inserted_videos = await store.save_videos_detailed(sub, payload)
    inserted = len(inserted_videos)
    latest_id = payload[0][min(payload[0])]["id"] if payload and payload[0] else None

    # 5. Schedule the next check.
    if sub.kind == "random":
        # Rank is user-controlled: next pick = now + rank interval.
        interval = RANK_INTERVALS.get(sub.rank, RANK_INTERVALS["week"])
        await store.update_schedule(sub, ts=int(time.time()) + interval, last_seen=latest_id)
    else:
        ts_result = ts_proccess(payload)
        if isinstance(ts_result, Success):
            ts, rank = ts_result.unwrap()
            await store.update_schedule(sub, ts=ts, rank=rank, last_seen=latest_id, counter=0)
        else:
            await store.bump_counter(sub.sub_id, 1, sub.kind)
            log.warning("ts prediction failed for %s: %s", sub.link, ts_result.failure())

    log.info("done: %s (%s) — %s new video(s), last_seen=%s", sub.link, sub.kind, inserted, latest_id)
    return Success("done")
