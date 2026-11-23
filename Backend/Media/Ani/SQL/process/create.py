"""Creates every table Media/Ani requires (D58/D62).

Idempotent — replayed on every boot by Database/Init/migrate.py AFTER the
shared schema and BEFORE Database/Init/constraints.sql. Media-specific
DDL never lives outside the media folder.
"""

DDL = """
-- ============================ Ani plugin ============================
CREATE TABLE IF NOT EXISTS ani_domains (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name_enc      BYTEA NOT NULL,
    name_hash     BYTEA NOT NULL,          -- blind index (crypto.index_hash)
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (user_id, name_hash)
);

CREATE TABLE IF NOT EXISTS ani_subdomains (
    id            SERIAL PRIMARY KEY,
    domain_id     INTEGER NOT NULL REFERENCES ani_domains(id) ON DELETE CASCADE,
    name_enc      BYTEA NOT NULL,
    name_hash     BYTEA NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    notify_override BOOLEAN,              -- D20: category-level activation (NULL = inherit)
    UNIQUE (domain_id, name_hash)
);

-- Global anime catalog cache (cleanup 2026-11-08): public AniList facts,
-- no user linkage. Per-user state/snapshots live in ani_entries/ani_seasons.
CREATE TABLE IF NOT EXISTS ani_metadata (
    anilist_id     INTEGER PRIMARY KEY,
    season_no      INTEGER NOT NULL,        -- chain position (global fact)
    title          TEXT,
    format         TEXT,
    episodes_total INTEGER,
    episodes_aired INTEGER,
    status         TEXT,
    start_date     TEXT,
    release_date   TEXT,
    next_airing_at BIGINT,
    next_airing_ep INTEGER,
    cover          TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ani_entries (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subdomain_id  INTEGER REFERENCES ani_subdomains(id) ON DELETE SET NULL,
    anilist_id    INTEGER NOT NULL,       -- first-season AniList id
    title_enc     BYTEA NOT NULL,
    cover_enc     BYTEA,
    label         TEXT NOT NULL DEFAULT 'none' CHECK (label IN ('none', 'completed', 'blocked')),
    label_reason_enc BYTEA,
    list          TEXT NOT NULL DEFAULT 'watching' CHECK (list IN ('watchlist', 'confirmed', 'watching', 'up_to_date')),
    notify_release BOOLEAN NOT NULL DEFAULT FALSE,  -- D20
    active        BOOLEAN NOT NULL DEFAULT TRUE,    -- "watched S1, loved it, not continuing"
    -- D44 linear cursor (fragmented watching unsupported by design):
    cursor_season   INTEGER,
    cursor_episode  INTEGER,
    cursor_position_seconds INTEGER,      -- in-episode timestamp xx:xx:xx
    canon_only      BOOLEAN NOT NULL DEFAULT FALSE,  -- D43 label flag (display only)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, anilist_id)
);

CREATE TABLE IF NOT EXISTS ani_seasons (
    entry_id      INTEGER NOT NULL REFERENCES ani_entries(id) ON DELETE CASCADE,
    season_no     INTEGER NOT NULL,
    anilist_id    INTEGER NOT NULL,
    title_enc     BYTEA,
    poster_enc    BYTEA,                       -- P14: per-season poster (AniList coverImage)
    status        TEXT,
    episodes_total INTEGER,
    episodes_aired INTEGER,
    start_date    TEXT,
    release_date  TEXT,                   -- announced start
    next_airing_at BIGINT,
    next_airing_ep INTEGER,
    state         TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (state IN ('unknown', 'announced', 'airing', 'finished')),
    watched       BOOLEAN NOT NULL DEFAULT FALSE,  -- D21 awaited-tier
    PRIMARY KEY (entry_id, season_no)
);

-- P14: existing installs get the poster column too.
ALTER TABLE ani_seasons ADD COLUMN IF NOT EXISTS poster_enc BYTEA;

CREATE TABLE IF NOT EXISTS ani_schedule (
    entry_id      INTEGER NOT NULL REFERENCES ani_entries(id) ON DELETE CASCADE,
    season_no     INTEGER NOT NULL,
    next_check_ts BIGINT,
    working       BOOLEAN NOT NULL DEFAULT FALSE,
    claimed_at    BIGINT,
    PRIMARY KEY (entry_id, season_no)
);
CREATE INDEX IF NOT EXISTS idx_ani_schedule_due ON ani_schedule(next_check_ts) WHERE NOT working;

-- Anime feed events (the 7 kinds, D18) — the pull-based feed; the
-- frontend reads these via the supergraph (D24: no push on happy path).
CREATE TABLE IF NOT EXISTS ani_events (
    id            BIGSERIAL PRIMARY KEY,
    entry_id      INTEGER NOT NULL REFERENCES ani_entries(id) ON DELETE CASCADE,
    season_no     INTEGER,
    kind          TEXT NOT NULL CHECK (kind IN (
                      'next_episode_date', 'next_sequel_date', 'new_anime_date',
                      'episode_postponed', 'next_sequel', 'release_confirmed',
                      'release_changed', 'episode_released')),
    tier          TEXT NOT NULL CHECK (tier IN ('awaited', 'unwatched')),  -- D21
    event_hash    BYTEA UNIQUE,          -- deterministic identity (random nonces
                                         -- make ciphertext dedupe impossible)
    payload_enc   BYTEA NOT NULL,
    seen          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ani_events_entry ON ani_events(entry_id, seen);

-- Anime halfway-watch todo (cleanup #2): "AoT S3 E5 at 7:27".
-- Separate table from yt_cards (cleanup #3) — different domain, different data.
CREATE TABLE IF NOT EXISTS ani_todo (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_id      INTEGER REFERENCES ani_entries(id) ON DELETE CASCADE,  -- NULL if untracked
    title_enc     BYTEA,                    -- required when entry_id IS NULL
    season_no     INTEGER NOT NULL,
    episode       INTEGER NOT NULL,
    position_seconds INTEGER NOT NULL DEFAULT 0,
    done          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ani_todo_user ON ani_todo(user_id, done);

-- Per-scope notify flags (ani side).
ALTER TABLE ani_domains    ADD COLUMN IF NOT EXISTS notify BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ani_subdomains ADD COLUMN IF NOT EXISTS notify BOOLEAN NOT NULL DEFAULT TRUE;

-- Anime card metadata: Type / Release / Time / season + episode counts.
ALTER TABLE ani_entries ADD COLUMN IF NOT EXISTS anime_type TEXT;
ALTER TABLE ani_entries ADD COLUMN IF NOT EXISTS airing_time TEXT;
-- Watchlist split: watchlist rows carry confirmed | maybe.
ALTER TABLE ani_entries ADD COLUMN IF NOT EXISTS watch_state TEXT;

-- List buckets: watching | up_to_date | next_sequel | new_anime | watchlist.
DO $$
BEGIN
    ALTER TABLE ani_entries DROP CONSTRAINT IF EXISTS ani_entries_list_check;
    ALTER TABLE ani_entries DROP CONSTRAINT IF EXISTS ani_entries_watch_state_check;
    ALTER TABLE ani_entries
        ADD CONSTRAINT ani_entries_list_check
        CHECK (list IN ('watching', 'up_to_date', 'next_sequel', 'new_anime', 'watchlist', 'confirmed', 'maybe'));
    ALTER TABLE ani_entries
        ADD CONSTRAINT ani_entries_watch_state_check
        CHECK (watch_state IS NULL OR watch_state IN ('confirmed', 'maybe'));
END $$;

-- D57 trashbin (ani side).
ALTER TABLE ani_events ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_ani_events_trash ON ani_events(trashed_at) WHERE trashed_at IS NOT NULL;

-- Cleanup #4 (ani side): blocked entries carry their own domain/subdomain.
ALTER TABLE ani_entries  ADD COLUMN IF NOT EXISTS blocked_domain_enc BYTEA;
ALTER TABLE ani_entries  ADD COLUMN IF NOT EXISTS blocked_subdomain_enc BYTEA;
CREATE INDEX IF NOT EXISTS idx_ani_entries_subdomain ON ani_entries(subdomain_id);

-- Episode actually aired (aired-count increase while already releasing).
-- Replayed on every start, so drop+re-add keeps the constraint in sync.
ALTER TABLE ani_events DROP CONSTRAINT IF EXISTS ani_events_kind_check;
ALTER TABLE ani_events ADD CONSTRAINT ani_events_kind_check CHECK (kind IN (
    'next_episode_date', 'next_sequel_date', 'new_anime_date',
    'episode_postponed', 'next_sequel', 'release_confirmed',
    'release_changed', 'episode_released'));
"""
