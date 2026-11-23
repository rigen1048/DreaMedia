"""Ani due-work model — one (entry, season) the manager claimed for the pipeline."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class AniDue:
    entry_id: int
    season_no: int
    user_id: int
    title: str            # search title for the chain fetch
    state: str
    watched: bool
    next_check_ts: Optional[int]
    claim_token: Optional[int] = None   # claimed_at at claim time — release must match
