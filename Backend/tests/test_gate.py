"""Per-user network-lane contracts: shared YT workers and no downstream cooldown."""
import asyncio
import time

import pytest

from Config.Hardcoded.limits import (
    YT_FETCH_REST_SECONDS,
    YT_FETCH_START_STAGGER_SECONDS,
    YT_FETCH_WORKERS_PER_USER,
)
from Gate.gate import GateRegistry


@pytest.mark.asyncio
async def test_youtube_request_types_share_one_per_user_worker_pool():
    registry = GateRegistry(yt_workers=3, start_stagger=0, yt_rest=0)
    active = 0
    peak = 0
    starts = []
    all_started = asyncio.Event()

    async def request(kind):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        starts.append(kind)
        if len(starts) == 3:
            all_started.set()
        await asyncio.wait_for(all_started.wait(), timeout=0.3)
        await asyncio.sleep(0)
        active -= 1
        return kind

    results = await asyncio.gather(
        registry.submit((7, "yt", "tracking"), lambda: request("tracking")),
        registry.submit((7, "yt", "random"), lambda: request("random")),
        registry.submit((7, "yt", "playlist"), lambda: request("playlist")),
    )

    assert sorted(results) == ["playlist", "random", "tracking"]
    assert peak == 3
    assert len(starts) == 3


@pytest.mark.asyncio
async def test_youtube_worker_starts_are_staggered_across_fetch_types():
    registry = GateRegistry(yt_workers=3, start_stagger=0.04, yt_rest=0.15)
    starts = []

    async def request():
        starts.append(time.monotonic())
        return True

    await asyncio.gather(*(
        registry.submit((12, "yt", kind), request)
        for kind in ("tracking", "random", "playlist")
    ))

    ordered = sorted(starts)
    assert len(ordered) == 3
    assert ordered[1] - ordered[0] >= 0.025
    assert ordered[2] - ordered[1] >= 0.025


@pytest.mark.asyncio
async def test_fetch_returns_before_worker_rest_and_next_fetch_waits():
    registry = GateRegistry(yt_workers=1, start_stagger=0, yt_rest=0.07)
    starts = []

    async def fetch():
        starts.append(time.monotonic())
        return "fetched"

    first = await registry.submit((3, "yt", "tracking"), fetch)
    downstream_started = time.monotonic()
    # Filtering/persistence/notifications can run as soon as the network call
    # resolves; the sleeping worker does not hold the caller or this task.
    await asyncio.sleep(0.005)
    downstream_completed = time.monotonic()
    second = await registry.submit((3, "yt", "random"), fetch)

    assert first == second == "fetched"
    assert downstream_completed - downstream_started < 0.05
    assert starts[1] - starts[0] >= 0.055


def test_default_youtube_pacing_matches_requested_per_user_policy():
    assert YT_FETCH_WORKERS_PER_USER == 8
    assert YT_FETCH_START_STAGGER_SECONDS == 1.0
    assert YT_FETCH_REST_SECONDS == 2.0


@pytest.mark.asyncio
async def test_different_users_have_independent_youtube_lanes():
    registry = GateRegistry(yt_workers=1, start_stagger=0, yt_rest=0.15)
    started = []
    both_started = asyncio.Event()

    async def request(user):
        started.append(user)
        if len(started) == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=0.3)
        return user

    results = await asyncio.gather(
        registry.submit((1, "yt", "tracking"), lambda: request(1)),
        registry.submit((2, "yt", "tracking"), lambda: request(2)),
    )
    assert sorted(results) == [1, 2]
