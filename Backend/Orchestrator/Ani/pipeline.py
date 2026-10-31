"""Ani pipeline — time-tracking state machine + event emission.

Per due (entry, season):
    fetch the season chain (through the user's ani gate)
    → refresh the season cache
    → run the state transition (D19 states.py)
    → emit the 7 event kinds with awaited/unwatched tier (D18/D21)
    → schedule the next check (hardcoded cadences, D2)

D15 applies here too: nothing auto-deletes on a failed fetch.
"""
from __future__ import annotations

import time
from typing import Any, Dict, Optional

from returns.result import Failure, Result, Success

from Database.ani_store import AniDue, AniStore
from Gate.gate import registry as gates
from Orchestrator.Ani.Fetch.ani_track import ani_fetch
from Orchestrator.Ani.Filter.states import (
    classify_transition,
    episodes_aired,
    next_check_for,
    parse_release_ts,
)
from Utility.check_internet import wait_for_internet
from Utility.logs import log


def _tier(due: AniDue) -> str:
    return "awaited" if due.watched else "unwatched"


def _find_season(payload, anilist_id: int) -> Optional[tuple[int, Dict[str, Any]]]:
    for season_no, video in payload[0].items():
        if int(video["id"]) == anilist_id:
            return season_no, video
    return None


async def run_subscription(store: AniStore, due: AniDue) -> Result[str, str]:
    await wait_for_internet()

    # 1. Fetch the whole chain for this entry (gate: per user+media+kind, D4).
    result = await gates.submit((due.user_id, "ani", "tracking"), lambda: ani_fetch(due.title))
    if isinstance(result, Failure):
        log.warning("ani fetch failed for %s: %s", due.title, result.failure())
        # Transient failures: retry on a short cadence, no state damage.
        await store.set_next_check(due.entry_id, due.season_no, int(time.time()) + 3600)
        return Failure(result.failure())
    payload = result.unwrap()

    now = int(time.time())

    # 2. Refresh cache, then load the stored row (holds anilist_id mapping).
    await store.refresh_seasons(due.user_id, due.entry_id, payload)
    stored = await store.get_season(due.entry_id, due.season_no)
    if stored is None:
        return Failure(f"season row vanished: entry={due.entry_id} s{due.season_no}")
    fresh = _find_season(payload, stored["anilist_id"])
    if fresh is None:
        # Chain restructured; reschedule quietly (D15 spirit).
        await store.set_next_check(due.entry_id, due.season_no, now + 7 * 24 * 3600)
        return Failure("season no longer in chain")

    _, video = fresh
    release_ts = parse_release_ts(video)
    aired = episodes_aired(video)
    status = video.get("status")

    # 3. Transition + events.
    old_state = stored["state"]
    new_state = classify_transition(old_state, release_ts, aired, status, now)
    tier = _tier(due)

    if old_state == "unknown" and new_state == "announced":
        kind = "new_anime_date" if due.season_no == 1 else "next_sequel_date"
        await store.emit_event(due.user_id, due.entry_id, due.season_no, kind, tier, {
            "release": video.get("published"), "title": video.get("title"),
        })
    elif old_state == "announced":
        old_release = stored.get("release_date")
        new_release = video.get("published") or None
        if old_release and new_release and old_release != new_release:
            await store.emit_event(due.user_id, due.entry_id, due.season_no, "release_changed", tier, {
                "old": old_release, "new": new_release,
            })
        elif (
            old_release and new_release and old_release == new_release
            and release_ts and now >= release_ts - 30 * 24 * 3600
        ):
            await store.emit_event(due.user_id, due.entry_id, due.season_no, "release_confirmed", tier, {
                "release": new_release,
            })

    if new_state == "airing" and old_state != "airing":
        log.info("%s s%s entered airing", due.title, due.season_no)

    # Postponement watch (announced or airing, inside T−12h).
    if new_state in ("announced", "airing") and release_ts and now >= release_ts - 12 * 3600:
        old_release = stored.get("release_date")
        if old_release and video.get("published") and old_release != video["published"]:
            await store.emit_event(due.user_id, due.entry_id, due.season_no, "episode_postponed", tier, {
                "was": old_release, "now": video["published"],
            })

    # Airing: next-episode announcements.
    if new_state == "airing":
        next_airing = video.get("next_airing")
        if next_airing and next_airing.get("airingAt"):
            if stored.get("next_airing_at") != next_airing["airingAt"]:
                await store.emit_event(due.user_id, due.entry_id, due.season_no, "next_episode_date", tier, {
                    "episode": next_airing.get("episode"),
                    "airing_at": next_airing["airingAt"],
                })

    # Season finished → finished; a later season in the chain = next_sequel event.
    if new_state == "airing" and status == "FINISHED":
        new_state = "finished"
    if old_state != "finished" and new_state == "finished":
        sequel = payload[0].get(due.season_no + 1)
        if sequel:
            await store.emit_event(due.user_id, due.entry_id, due.season_no + 1, "next_sequel", tier, {
                "title": sequel.get("title"), "format": sequel.get("format"),
                "release": sequel.get("published"),
            })

    # 4. Persist state + next check.
    await store.update_season_state(
        due.entry_id, due.season_no, state=new_state, release_date=video.get("published") or None
    )
    next_ts = next_check_for(new_state, release_ts, now)
    await store.set_next_check(due.entry_id, due.season_no, next_ts)
    log.info("ani done: %s s%s [%s → %s] next=%s", due.title, due.season_no, old_state, new_state, next_ts)
    return Success("done")
