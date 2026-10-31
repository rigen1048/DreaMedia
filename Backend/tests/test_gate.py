"""Gate tests — queued, per-(user, media, kind), never dropped (D4/D5)."""
import asyncio
import time

import pytest

from Gate.gate import GateRegistry


async def _job(results, name, delay=0.01):
    results.append(name)
    return name


@pytest.mark.asyncio
async def test_same_gate_serializes_with_cooldown():
    registry = GateRegistry()
    # Shrink the gate's cooldown for the test by monkeypatching lookup.
    registry._cooldown_for = lambda key: 0.05
    results = []
    start = time.monotonic()
    await asyncio.gather(
        registry.submit(("u1", "yt", "tracking"), lambda: _job(results, "a")),
        registry.submit(("u1", "yt", "tracking"), lambda: _job(results, "b")),
    )
    elapsed = time.monotonic() - start
    assert results == ["a", "b"]  # FIFO order preserved
    assert elapsed >= 0.05  # cooldown enforced between items


@pytest.mark.asyncio
async def test_different_gates_run_concurrently():
    registry = GateRegistry()
    registry._cooldown_for = lambda key: 0.2
    results = []
    start = time.monotonic()
    await asyncio.gather(
        # Same user, different media → no blocking (D4 media level).
        registry.submit(("u1", "yt", "tracking"), lambda: _job(results, "yt")),
        registry.submit(("u1", "ani", "tracking"), lambda: _job(results, "ani")),
        # Different user, same media → no blocking (D4 user level).
        registry.submit(("u2", "yt", "tracking"), lambda: _job(results, "u2-yt")),
        # Same user+media, different fetch type → no blocking (D4 type level).
        registry.submit(("u1", "yt", "random"), lambda: _job(results, "random")),
    )
    elapsed = time.monotonic() - start
    assert sorted(results) == ["ani", "random", "u2-yt", "yt"]
    assert elapsed < 0.2  # none waited on another gate's cooldown


@pytest.mark.asyncio
async def test_nothing_dropped_on_error():
    registry = GateRegistry()
    registry._cooldown_for = lambda key: 0.0
    results = []

    async def boom():
        raise RuntimeError("fetch exploded")

    with pytest.raises(RuntimeError):
        await registry.submit(("u1", "yt", "tracking"), boom)
    # Next job on the same gate still runs — error didn't kill the worker.
    out = await registry.submit(("u1", "yt", "tracking"), lambda: _job(results, "ok"))
    assert out == "ok"
