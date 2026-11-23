"""Policy values — hardcoded BY DESIGN (D2).

Never move these to .env: end users must not be able to crank
aggressiveness against external services. .env is for deployment
facts only (paths, ports, backup policy — D13).
"""

# Only network fetches use this lane; completed results leave before the rest.
YT_FETCH_WORKERS_PER_USER = 8
YT_FETCH_START_STAGGER_SECONDS = 1.0
YT_FETCH_REST_SECONDS = 2.0
MEDIA_EXECUTOR_WORKERS = 64

COOLDOWN_SECONDS: dict[tuple[str, str], float] = {
    ("ani", "tracking"): 2.0,
}
DEFAULT_COOLDOWN: float = 2.0

# Retry policy for transient HTTP errors inside a single fetch.
FETCH_RETRIES: int = 3
RETRY_DELAY_SECONDS: float = 5.0

# Backup policy guardrails (D13): .env may configure cadence/retention,
# but never below this floor — a user must not be able to set retention 0.
MIN_BACKUPS_KEPT: int = 2

# Restore uploads (admin page): refuse a dump bigger than this before it can
# fill the disk. Generous for a home server, still a guard.
MAX_RESTORE_UPLOAD_BYTES: int = 4 * 1024**3

# Session lifetime (D27): sliding TTL. Dies with the process — same
# lifecycle as the vault (D9). HydraWatch's 18-minute cap is not coming back.
SESSION_TTL_SECONDS: int = 24 * 3600

# Working-claim recovery: if a claimed row stays 'working' longer than
# this (crash mid-fetch), a sweeper releases it for retry. Crash-safe
# claiming was the whole point of the working flag (owner Backend.zip).
WORKING_STALE_SECONDS: int = 3600

# Manager idle cadence when nothing is due.
MANAGER_IDLE_SLEEP_SECONDS: float = 60.0

# pg_dump lookup order for backups (D13).
PG_DUMP_CANDIDATES: tuple[str, ...] = (
    "pg_dump",  # on PATH (docker image)
    "/opt/data/opt/pgsql/usr/lib/postgresql/17/bin/pg_dump",  # this dev host
)


# Retry backoff (2026 review: failed fetches stayed due → tight retry loop).
# After a failure or no-new-content pass, ts = now + backoff(counter):
# 1st miss ~1h, doubling each consecutive miss, capped at ~31 days.
BACKOFF_BASE_SECONDS = 3600
BACKOFF_CAP_SECONDS = 2678400


def backoff_seconds(counter: int) -> int:
    return min(BACKOFF_BASE_SECONDS * (2 ** max(counter - 1, 0)), BACKOFF_CAP_SECONDS)
