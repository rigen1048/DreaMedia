"""Ani time-tracking cadences (seconds) — hardcoded BY DESIGN (D2, D19).

Never move these to .env: poll cadences against AniList are policy, not
deployment facts. Consumed by Media/Ani/Filter/states.py.
"""

UNKNOWN_RECHECK = 30 * 24 * 3600          # monthly
CONFIRM_BEFORE_RELEASE = 30 * 24 * 3600   # T−1 month
POSTPONE_CHECK_BEFORE = 12 * 3600         # T−12h
AIRING_GRACE = 48 * 3600                  # release bypassed by 48h
FINISHED_RECHECK = 7 * 24 * 3600          # weekly sequel watch
FALLBACK_RECHECK = 7 * 24 * 3600
