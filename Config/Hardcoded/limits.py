"""Policy values — hardcoded BY DESIGN (D2).

Never move these to .env: end users must not be able to crank
aggressiveness against external services. .env is for deployment
facts only (paths, ports, backup policy — D13).
"""

# Cooldown between requests per gate (seconds).
# Gate granularity = (user, media, fetch_type) — D4.
# A user's YT tracking fetch never blocks their YT random, their anime
# fetch, or any other user.
COOLDOWN_SECONDS: dict[tuple[str, str], float] = {
    ("yt", "tracking"): 8.0,
    ("yt", "wordscan"): 8.0,
    ("yt", "playlist"): 8.0,
    ("yt", "random"): 8.0,
    ("ani", "tracking"): 2.0,  # AniList is a friendly GraphQL API
}

DEFAULT_COOLDOWN: float = 8.0

# Retry policy for transient HTTP errors inside a single fetch.
FETCH_RETRIES: int = 3
RETRY_DELAY_SECONDS: float = 5.0

# Backup policy guardrails (D13): .env may configure cadence/retention,
# but never below this floor — a user must not be able to set retention 0.
MIN_BACKUPS_KEPT: int = 2

# Session lifetime (D27): sliding TTL. Dies with the process — same
# lifecycle as the vault (D9). HydraWatch's 18-minute cap is not coming back.
SESSION_TTL_SECONDS: int = 24 * 3600

# pg_dump lookup order for backups (D13).
PG_DUMP_CANDIDATES: tuple[str, ...] = (
    "pg_dump",  # on PATH (docker image)
    "/opt/data/opt/pgsql/usr/lib/postgresql/17/bin/pg_dump",  # this dev host
)
