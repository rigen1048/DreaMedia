"""Yt subscription model — the shape the manager claims and the pipeline runs."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class PgSubscription:
    sub_id: int           # yt_tracking.channel_id
    user_id: int
    media: str            # "yt"
    kind: str             # tracking|wordscan|playlist|random
    link: str             # rss_id (decrypted — needed for fetching)
    last_seen: Optional[str]
    words: List[str] = field(default_factory=list)
    ts: Optional[int] = None
    rank: str = "day"
    counter: int = 0
    claim_token: Optional[int] = None   # claimed_at at claim time — release must match
    withhold_threshold: Optional[int] = None   # F1: buffer N videos, release as one batch
