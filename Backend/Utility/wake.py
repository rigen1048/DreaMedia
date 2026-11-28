"""Shared wake-event mechanism for background manager loops.

Both the Yt pipeline manager and the YouTube import worker manager use the
same pattern: an asyncio.Event that wakes a sleeping loop when new work is
enqueued. This module provides a single implementation so each manager
doesn't re-implement the same sleep/wake/clear logic.
"""

from __future__ import annotations

import asyncio


class WakeEvent:
    """A named asyncio.Event with a sleep-until-woken-or-timeout helper."""

    def __init__(self) -> None:
        self._event = asyncio.Event()

    def set(self) -> None:
        """Ask the waiting loop to check for work right away."""
        self._event.set()

    def clear(self) -> None:
        """Reset so the next sleep waits for a fresh set()."""
        self._event.clear()

    async def nap(self, seconds: float) -> None:
        """Sleep for `seconds`, returning early when set() is called.

        Clears the event on wake so the next nap waits for a fresh signal.
        """
        if self._event.is_set():
            self._event.clear()
            return
        try:
            await asyncio.wait_for(self._event.wait(), timeout=max(0.0, seconds))
        except asyncio.TimeoutError:
            pass
        finally:
            self._event.clear()
