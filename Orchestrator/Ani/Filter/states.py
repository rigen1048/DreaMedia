"""Ani time-tracking state machine — pure transition logic (D19).

States per (entry, season):
    unknown   — no release date; poll monthly
    announced — release date known; confirm at release − 1 month,
                then postponement-watch at release − 12h
    airing    — release bypassed by 48h AND episodes aired > 0; stop
                release queries, track nextAiringEpisode; postponement
                check 12h before each episode
    finished  — season finished; only watch the chain for a SEQUEL

All cadences hardcoded here (D2 — never .env).
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

# ---- cadences (seconds), D2 hardcoded ----
UNKNOWN_RECHECK = 30 * 24 * 3600          # monthly
CONFIRM_BEFORE_RELEASE = 30 * 24 * 3600   # T−1 month
POSTPONE_CHECK_BEFORE = 12 * 3600         # T−12h
AIRING_GRACE = 48 * 3600                  # release bypassed by 48h
FINISHED_RECHECK = 7 * 24 * 3600          # weekly sequel watch
FALLBACK_RECHECK = 7 * 24 * 3600


def parse_release_ts(video: Dict[str, Any]) -> Optional[int]:
    """Release timestamp from a fresh fetch entry (start date or next airing)."""
    from datetime import datetime, timezone

    published = video.get("published")
    if published:
        try:
            dt = datetime.strptime(str(published), "%Y-%m-%d").replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
        except ValueError:
            pass
    next_airing = video.get("next_airing")
    if next_airing and next_airing.get("airingAt"):
        return int(next_airing["airingAt"])
    return None


def episodes_aired(video: Dict[str, Any]) -> int:
    """Aired episode count from fresh data (next_ep − 1, or total when finished)."""
    next_airing = video.get("next_airing")
    if next_airing and next_airing.get("episode"):
        return max(0, int(next_airing["episode"]) - 1)
    if video.get("status") == "FINISHED" and video.get("episodes"):
        return int(video["episodes"])
    return 0


def next_check_for(state: str, release_ts: Optional[int], now: int) -> int:
    """When should this (state, release) be queried next?"""
    if state == "unknown":
        return now + UNKNOWN_RECHECK
    if state == "announced":
        if release_ts is None:
            return now + UNKNOWN_RECHECK
        confirm_at = release_ts - CONFIRM_BEFORE_RELEASE
        if now < confirm_at:
            return confirm_at
        return release_ts - POSTPONE_CHECK_BEFORE if now < release_ts - POSTPONE_CHECK_BEFORE else now
    if state == "airing":
        if release_ts is not None and now < release_ts:
            return max(now, release_ts - POSTPONE_CHECK_BEFORE)
        return now + FALLBACK_RECHECK
    if state == "finished":
        return now + FINISHED_RECHECK
    return now + FALLBACK_RECHECK


def classify_transition(
    state: str, release_ts: Optional[int], aired: int, status: Optional[str], now: int
) -> str:
    """Pure state transition decision given fresh data."""
    if status == "FINISHED" and state == "airing":
        return "finished"
    if state in ("unknown", "announced"):
        if release_ts is not None and now >= release_ts + AIRING_GRACE and aired > 0:
            return "airing"
        if release_ts is not None:
            return "announced"
        return "unknown"
    if state == "airing" and status == "FINISHED":
        return "finished"
    return state
