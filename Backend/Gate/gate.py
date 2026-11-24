"""Per-user network request lanes; downstream processing never uses this gate."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Hashable, Tuple

from Config.Hardcoded.limits import (
    COOLDOWN_SECONDS,
    DEFAULT_COOLDOWN,
    YT_FETCH_REST_SECONDS,
    YT_FETCH_START_STAGGER_SECONDS,
    YT_FETCH_WORKERS_PER_USER,
)

GateKey = Tuple[Hashable, str, str]  # (user_id, media, request_type)


@dataclass
class _Gate:
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    workers: list[asyncio.Task] = field(default_factory=list)
    # last_fetch is the monotonically increasing time at which the last fetch
    # on this lane was (or will be) started. Workers reserve the next slot as
    # max(now, last_fetch + rest) under the lock, so starts are evenly spaced
    # at workers/rest req/s with no burst parity groups — the "don't hammer
    # YouTube" rate limit. Starts at 0 so the very first fetch on a lane goes
    # immediately (nothing to space from yet).
    last_fetch: float = 0.0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class GateRegistry:
    """Per-user network lanes; downstream processing never uses this gate.

    Each worker reserves the next fetch slot as max(now, last_fetch + rest)
    under a per-lane lock, then sleeps outside the lock until that slot. This
    yields a smooth conveyor at workers/rest req/s with at most one fetch
    starting per slot — instead of the old parity bursts where same-parity
    workers (0,2,4,6 and 1,3,5,7) hammered YouTube in groups every rest cycle.
    """

    def __init__(
        self,
        *,
        yt_workers: int = YT_FETCH_WORKERS_PER_USER,
        start_stagger: float = YT_FETCH_START_STAGGER_SECONDS,
        yt_rest: float = YT_FETCH_REST_SECONDS,
    ) -> None:
        self.yt_workers = max(1, yt_workers)
        # start_stagger is retained for API compatibility; spacing is now
        # derived from rest / workers so the lane tiles its rest period.
        self.start_stagger = max(0.0, start_stagger)
        self.yt_rest = max(0.0, yt_rest)
        self._gates: Dict[GateKey, _Gate] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    @staticmethod
    def _scope(key: GateKey) -> GateKey:
        user_id, media, request_type = key
        return (user_id, media, "media") if media == "yt" else (user_id, media, request_type)

    def _worker_count(self, key: GateKey) -> int:
        return self.yt_workers if key[1] == "yt" else 1

    def _rest_seconds(self, key: GateKey) -> float:
        if key[1] == "yt":
            return self.yt_rest
        return COOLDOWN_SECONDS.get((key[1], key[2]), DEFAULT_COOLDOWN)

    def _slot_interval(self, key: GateKey) -> float:
        """Seconds between fetch starts on this lane (rest / workers for yt)."""
        if key[1] == "yt":
            return self.yt_rest / max(1, self.yt_workers)
        return self._rest_seconds(key)

    async def _work(self, key: GateKey, gate: _Gate, worker_id: int) -> None:
        rest = self._rest_seconds(key)
        try:
            while True:
                fn, future = await gate.queue.get()
                try:
                    if not future.cancelled():
                        # Reserve the next fetch slot under the lock, then sleep
                        # outside it so the lock is never held across a sleep.
                        interval = self._slot_interval(key)
                        loop = asyncio.get_running_loop()
                        async with gate.lock:
                            now = loop.time()
                            slot = max(now, gate.last_fetch + interval)
                            gate.last_fetch = slot
                        if slot > now:
                            await asyncio.sleep(slot - now)
                        try:
                            result = await fn()
                        except Exception as exc:
                            if not future.done():
                                future.set_exception(exc)
                        else:
                            if not future.done():
                                future.set_result(result)
                finally:
                    gate.queue.task_done()
        except asyncio.CancelledError:
            while not gate.queue.empty():
                _, future = gate.queue.get_nowait()
                if not future.done():
                    future.cancel()
                gate.queue.task_done()
            raise

    def _get_gate(self, key: GateKey) -> tuple[GateKey, _Gate]:
        loop = asyncio.get_running_loop()
        if loop is not self._loop:
            self._gates.clear()
            self._loop = loop
        scoped_key = self._scope(key)
        gate = self._gates.get(scoped_key)
        if gate is None:
            gate = _Gate()
            self._gates[scoped_key] = gate
        count = self._worker_count(scoped_key)
        for worker_id in range(count):
            if worker_id >= len(gate.workers):
                gate.workers.append(
                    asyncio.create_task(self._work(scoped_key, gate, worker_id))
                )
            elif gate.workers[worker_id].done():
                gate.workers[worker_id] = asyncio.create_task(
                    self._work(scoped_key, gate, worker_id)
                )
        return scoped_key, gate

    async def submit(
        self,
        key: GateKey,
        fn: Callable[[], Awaitable[Any]],
    ) -> Any:
        """Run only `fn` on the network lane; return before its post-fetch rest."""
        _, gate = self._get_gate(key)
        future = asyncio.get_running_loop().create_future()
        await gate.queue.put((fn, future))
        return await future

    def pending(self, key: GateKey) -> int:
        scoped_key = self._scope(key)
        gate = self._gates.get(scoped_key)
        return gate.queue.qsize() if gate else 0


registry = GateRegistry()
