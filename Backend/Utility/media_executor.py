"""Dedicated executor and per-user lane for blocking YouTube/media calls."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any, Callable

from Config.Hardcoded.limits import MEDIA_EXECUTOR_WORKERS


# Keep yt-dlp out of asyncio's default executor, which serves unrelated app work.
# Per-user request timing is enforced by GateRegistry in run_youtube_network.
_MEDIA_EXECUTOR = ThreadPoolExecutor(
    max_workers=MEDIA_EXECUTOR_WORKERS, thread_name_prefix="yt-media"
)


async def run_media(fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    """Run one blocking media call without occupying the default executor."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_MEDIA_EXECUTOR, partial(fn, *args, **kwargs))


async def run_youtube_network(
    user_id: int, fn: Callable[..., Any], /, *args: Any, **kwargs: Any
) -> Any:
    """Run one YT request on the user's shared, staggered lane."""
    from Gate.gate import registry as gates

    return await gates.submit(
        (user_id, "yt", "media"), lambda: run_media(fn, *args, **kwargs)
    )
