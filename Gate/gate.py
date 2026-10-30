"""Queued rate gates — the D1/D4/D5 enforcement mechanism.

One gate per (user, media, fetch_type). Each gate owns an asyncio.Queue
and a single worker task that processes requests serially, sleeping the
gate's cooldown between items. Callers enqueue and await their future:
nothing is ever silently dropped (D5), and every other gate — another
fetch type, another media, another user — runs uninterrupted (D1, D4).

Gates are created lazily and cost nothing while idle.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Hashable, Tuple

from Config.Hardcoded.limits import COOLDOWN_SECONDS, DEFAULT_COOLDOWN
from Utility.logs import log

GateKey = Tuple[Hashable, str, str]  # (user_id, media, fetch_type)


@dataclass
class _Gate:
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    worker: asyncio.Task | None = None


class GateRegistry:
    """Process-wide registry of queued rate gates."""

    def __init__(self) -> None:
        self._gates: Dict[GateKey, _Gate] = {}

    def _cooldown_for(self, key: GateKey) -> float:
        _, media, fetch_type = key
        return COOLDOWN_SECONDS.get((media, fetch_type), DEFAULT_COOLDOWN)

    async def _work(self, key: GateKey, gate: _Gate) -> None:
        cooldown = self._cooldown_for(key)
        log.debug("gate %s worker started (cooldown=%ss)", key, cooldown)
        try:
            while True:
                fn, fut = await gate.queue.get()
                if not fut.cancelled():
                    try:
                        result = await fn()
                        fut.set_result(result)
                    except Exception as exc:  # deliver, never drop (D5)
                        fut.set_exception(exc)
                    finally:
                        gate.queue.task_done()
                else:
                    gate.queue.task_done()
                # Cooldown AFTER the request completes: minimum spacing
                # between the *start* of consecutive requests on this gate.
                if cooldown > 0:
                    await asyncio.sleep(cooldown)
        except asyncio.CancelledError:
            # Drain: fail anything still queued rather than strand it.
            while not gate.queue.empty():
                _, fut = gate.queue.get_nowait()
                if not fut.done():
                    fut.cancel()
            raise

    async def submit(
        self,
        key: GateKey,
        fn: Callable[[], Awaitable[Any]],
    ) -> Any:
        """Enqueue an async callable on the gate; await its result."""
        gate = self._gates.setdefault(key, _Gate())
        if gate.worker is None or gate.worker.done():
            gate.worker = asyncio.create_task(self._work(key, gate))
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        await gate.queue.put((fn, fut))
        return await fut

    def pending(self, key: GateKey) -> int:
        gate = self._gates.get(key)
        return gate.queue.qsize() if gate else 0


# Process-wide default registry.
registry = GateRegistry()
