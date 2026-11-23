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


class GateRegistry:
    """Lazy network lanes, shared by every fetch type for one user/media."""

    def __init__(
        self,
        *,
        yt_workers: int = YT_FETCH_WORKERS_PER_USER,
        start_stagger: float = YT_FETCH_START_STAGGER_SECONDS,
        yt_rest: float = YT_FETCH_REST_SECONDS,
    ) -> None:
        self.yt_workers = max(1, yt_workers)
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

    async def _work(self, key: GateKey, gate: _Gate, worker_id: int) -> None:
        if key[1] == "yt" and worker_id:
            await asyncio.sleep(worker_id * self.start_stagger)
        try:
            while True:
                fn, future = await gate.queue.get()
                try:
                    if not future.cancelled():
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
                rest = self._rest_seconds(key)
                if rest:
                    await asyncio.sleep(rest)
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
        gate = self._gates.setdefault(scoped_key, _Gate())
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
