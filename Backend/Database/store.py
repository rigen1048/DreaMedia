"""Development store — TEMPORARY.

Purpose: make the happy-path fetch flow runnable and testable end-to-end
before the real persistence lands. The real store is encrypted Postgres
with per-user password-derived keys and an in-memory vault (D3, D8, D9).
This module exists so pipelines are written against an async interface
that the Postgres layer will implement unchanged — swap the class, keep
the call sites.

Everything here is plain in-memory state; nothing survives a restart.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from Model.video import FetchPayload


@dataclass
class Subscription:
    user: str
    media: str            # "yt" | "ani"
    kind: str             # yt: tracking|wordscan|playlist|random ; ani: tracking
    link: str             # rss_id / playlist_id / channel_url / anime title
    last_seen: Optional[str] = None
    words: List[str] = field(default_factory=list)
    ts: Optional[int] = None
    rank: str = "day"
    counter: int = 0
    active: bool = True


class DevStore:
    """Async in-memory store with the shape Postgres will take over."""

    def __init__(self) -> None:
        self._subs: Dict[int, Subscription] = {}
        self._videos: Dict[str, List[Dict[str, Any]]] = {}  # user -> feed rows
        self._next_id = 1

    async def add_subscription(self, sub: Subscription) -> int:
        sub_id = self._next_id
        self._next_id += 1
        self._subs[sub_id] = sub
        return sub_id

    async def get_due(self) -> List[tuple[int, Subscription]]:
        now = int(time.time())
        return [
            (sid, s)
            for sid, s in self._subs.items()
            if s.active and (s.ts is None or s.ts <= now)
        ]

    async def save_videos(self, user: str, payload: FetchPayload) -> int:
        videos = payload[0] if payload else {}
        feed = self._videos.setdefault(user, [])
        existing = {v["url"] for v in feed}
        inserted = 0
        for video in videos.values():
            if video.get("url") not in existing:
                feed.append(video)
                inserted += 1
        return inserted

    async def update_schedule(
        self,
        sub_id: int,
        *,
        ts: Optional[int] = None,
        rank: Optional[str] = None,
        last_seen: Optional[str] = None,
        counter: Optional[int] = None,
    ) -> None:
        sub = self._subs[sub_id]
        if ts is not None:
            sub.ts = ts
        if rank is not None:
            sub.rank = rank
        if last_seen is not None:
            sub.last_seen = last_seen
        if counter is not None:
            sub.counter = counter

    async def bump_counter(self, sub_id: int, increment: int) -> int:
        sub = self._subs[sub_id]
        sub.counter += increment
        return sub.counter

    async def feed(self, user: str) -> List[Dict[str, Any]]:
        return list(self._videos.get(user, []))
