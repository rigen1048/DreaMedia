-- DreaMedia schema (D3: Postgres; D8/D9: per-user encrypted content).
-- Convention: columns ending _enc are bytea ciphertext (XSalsa20-Poly1305)
-- encrypted with the owning user's password-derived key. The server never
-- holds those keys on disk (D9 vault).

-- ============================ Shared ============================
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    argon2_hash   TEXT NOT NULL,          -- needed for login verification
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deployment-level settings (D26): admin-editable at runtime.
-- Not user data → not encrypted. Floors enforced in code (D2/D13).
CREATE TABLE IF NOT EXISTS settings (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unhappy-path notifications (D15/D24): stored AND pushed to the
-- frontend's single notification API. History survives a missed push.
CREATE TABLE IF NOT EXISTS notifications (
    id            BIGSERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media         TEXT NOT NULL,
    kind          TEXT NOT NULL,
    payload_enc   BYTEA NOT NULL,
    pushed        BOOLEAN NOT NULL DEFAULT FALSE,
    seen          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, seen);

-- ============================ Yt plugin ============================
CREATE TABLE IF NOT EXISTS yt_domains (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name_enc      BYTEA NOT NULL,
    name_hash     BYTEA NOT NULL,          -- blind index (crypto.index_hash)
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (user_id, name_hash)
);

CREATE TABLE IF NOT EXISTS yt_subdomains (
    id            SERIAL PRIMARY KEY,
    domain_id     INTEGER NOT NULL REFERENCES yt_domains(id) ON DELETE CASCADE,
    name_enc      BYTEA NOT NULL,
    name_hash     BYTEA NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (domain_id, name_hash)
);

CREATE TABLE IF NOT EXISTS yt_channels (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subdomain_id  INTEGER REFERENCES yt_subdomains(id) ON DELETE SET NULL,
    name_enc      BYTEA NOT NULL,
    url_enc       BYTEA NOT NULL,
    url_hash      BYTEA NOT NULL,
    logo_enc      BYTEA,
    label         TEXT NOT NULL DEFAULT 'none' CHECK (label IN ('none', 'reserved', 'blocked')),
    label_reason_enc BYTEA,               -- D22: e.g. "mr beast fake stunts"
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, url_hash)
);

CREATE TABLE IF NOT EXISTS yt_tracking (
    channel_id    INTEGER PRIMARY KEY REFERENCES yt_channels(id) ON DELETE CASCADE,
    rss_id_enc    BYTEA NOT NULL,
    rss_hash      BYTEA NOT NULL,            -- blind index (unique per kind; rss_id encrypted — reveals channel)
    kind          TEXT NOT NULL DEFAULT 'tracking' CHECK (kind IN ('tracking', 'wordscan')),
    word_enc      BYTEA,                  -- word-scan terms
    last_seen_enc BYTEA,
    ts            BIGINT,
    rank          TEXT NOT NULL DEFAULT 'day',
    counter       INTEGER NOT NULL DEFAULT 0,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    working       BOOLEAN NOT NULL DEFAULT FALSE,
    claimed_at    BIGINT,                -- set on claim; stale sweep keys on this, not ts
    UNIQUE (rss_hash, kind)              -- same channel may have tracking AND wordscan rows
);
CREATE INDEX IF NOT EXISTS idx_yt_tracking_due ON yt_tracking(ts) WHERE active AND NOT working;

CREATE TABLE IF NOT EXISTS yt_playlists (
    channel_id    INTEGER PRIMARY KEY REFERENCES yt_channels(id) ON DELETE CASCADE,
    playlist_id   TEXT NOT NULL,
    last_seen     TEXT,
    ts            BIGINT,
    rank          TEXT NOT NULL DEFAULT 'day',
    counter       INTEGER NOT NULL DEFAULT 0,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    working       BOOLEAN NOT NULL DEFAULT FALSE,
    claimed_at    BIGINT
);

CREATE TABLE IF NOT EXISTS yt_randomsubs (
    channel_id    INTEGER PRIMARY KEY REFERENCES yt_channels(id) ON DELETE CASCADE,
    ts            BIGINT,
    rank          TEXT NOT NULL DEFAULT 'week',   -- user-controlled, never auto (D: schema)
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    working       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS yt_videos (
    id            BIGSERIAL PRIMARY KEY,
    channel_id    INTEGER NOT NULL REFERENCES yt_channels(id) ON DELETE CASCADE,
    url_enc       BYTEA NOT NULL,
    url_hash      BYTEA NOT NULL,
    title_enc     BYTEA NOT NULL,
    thumbnail_enc BYTEA,
    published_at  BIGINT,
    seen          BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (channel_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_yt_videos_channel ON yt_videos(channel_id, seen);

-- ============================ Manual todo cards (D47) ============================
-- Non-automated: the user creates a card, pastes video links into it,
-- checks them off. No polling, no ranks, no feeds.
CREATE TABLE IF NOT EXISTS yt_cards (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name_enc      BYTEA NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS yt_card_items (
    id            BIGSERIAL PRIMARY KEY,
    card_id       INTEGER NOT NULL REFERENCES yt_cards(id) ON DELETE CASCADE,
    video_id      TEXT NOT NULL,               -- YouTube video id (not secret)
    url_enc       BYTEA NOT NULL,
    url_hash      BYTEA NOT NULL,
    title_enc     BYTEA NOT NULL,
    thumbnail_enc BYTEA,
    position      INTEGER NOT NULL DEFAULT 0,
    done          BOOLEAN NOT NULL DEFAULT FALSE,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (card_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_card_items_card ON yt_card_items(card_id, done);

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

-- ==================== Feature-completion migrations ====================
-- Idempotent: this file is replayed on every start, so post-original columns
-- are added here behind IF NOT EXISTS / DO guards.

-- Notification scoping: disable notifications for an entire domain, an
-- entire subdomain, or a single channel. Effective delivery is
-- domain.notify AND subdomain.notify AND channel.notify AND label = 'none'.
ALTER TABLE yt_domains    ADD COLUMN IF NOT EXISTS notify BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE yt_subdomains ADD COLUMN IF NOT EXISTS notify BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE yt_channels   ADD COLUMN IF NOT EXISTS notify BOOLEAN NOT NULL DEFAULT TRUE;

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

ALTER TABLE yt_randomsubs ADD COLUMN IF NOT EXISTS claimed_at BIGINT;

-- Phase 1 (multi-worker): sessions live in the DB, not process memory.
-- Any worker can authenticate any request; a backend restart no longer
-- logs everyone out. (The vault stays in-memory by design — D9.)
CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days'
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- D55: per-user extension token (hash only; the raw token is shown once).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ext_token_hash BYTEA;

-- D57 trashbin: opening a notification trashes it; purge after 24h.
ALTER TABLE yt_videos  ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ;
ALTER TABLE ani_events ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_yt_videos_trash ON yt_videos(trashed_at) WHERE trashed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ani_events_trash ON ani_events(trashed_at) WHERE trashed_at IS NOT NULL;

-- Cleanup #4: blocked/reserved channels + entries carry their OWN
-- domain/subdomain (separate from feed categories) + the text reason.
ALTER TABLE yt_channels  ADD COLUMN IF NOT EXISTS blocked_domain_enc BYTEA;
ALTER TABLE yt_channels  ADD COLUMN IF NOT EXISTS blocked_subdomain_enc BYTEA;
ALTER TABLE ani_entries  ADD COLUMN IF NOT EXISTS blocked_domain_enc BYTEA;
ALTER TABLE ani_entries  ADD COLUMN IF NOT EXISTS blocked_subdomain_enc BYTEA;
CREATE INDEX IF NOT EXISTS idx_yt_channels_subdomain ON yt_channels(subdomain_id);
CREATE INDEX IF NOT EXISTS idx_ani_entries_subdomain ON ani_entries(subdomain_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);

-- Episode actually aired (aired-count increase while already releasing).
-- Replayed on every start, so drop+re-add keeps the constraint in sync.
ALTER TABLE ani_events DROP CONSTRAINT IF EXISTS ani_events_kind_check;
ALTER TABLE ani_events ADD CONSTRAINT ani_events_kind_check CHECK (kind IN (
    'next_episode_date', 'next_sequel_date', 'new_anime_date',
    'episode_postponed', 'next_sequel', 'release_confirmed',
    'release_changed', 'episode_released'));

-- F1 Withhold: quantity-batched notifications. Videos from a withhold
-- subscription buffer (withheld=TRUE, hidden from the feed) until the
-- buffered count reaches the threshold, then release as one batch.
ALTER TABLE yt_tracking ADD COLUMN IF NOT EXISTS withhold_threshold INTEGER;
ALTER TABLE yt_videos  ADD COLUMN IF NOT EXISTS withheld BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_yt_videos_withheld ON yt_videos(channel_id) WHERE withheld;

-- Extension v2 phase 1: per-user website allowlist (design:
-- Extension/Docs/extension-design.md). The extension registers its content
-- scripts ONLY on these domains — nothing runs on arbitrary pages. media
-- picks the module ('yt' | 'ani') that activates on the domain.
CREATE TABLE IF NOT EXISTS ext_domains (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain_enc    BYTEA NOT NULL,
    domain_hash   BYTEA NOT NULL,           -- blind index (crypto.index_hash)
    media         TEXT NOT NULL CHECK (media IN ('yt', 'ani')),
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, domain_hash, media)
);

-- Extension v2 phase 5: which site the user watches which anime on.
-- Learned passively from anchor reports; notification clicks resolve the
-- next episode URL by pattern-matching the stored page URL, falling back
-- to the site home (fresh releases surface there), then AniList.
CREATE TABLE IF NOT EXISTS ani_watch_sites (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_id      INTEGER NOT NULL REFERENCES ani_entries(id) ON DELETE CASCADE,
    domain_enc    BYTEA NOT NULL,
    domain_hash   BYTEA NOT NULL,
    url_enc       BYTEA NOT NULL,           -- last page URL watched there
    season        INTEGER,                  -- what that URL was playing
    episode       INTEGER,
    use_count     INTEGER NOT NULL DEFAULT 1,
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, entry_id, domain_hash)
);

-- Extension v2 phase 2: live watch sessions over the websocket lane.
-- One row per active watch; upserted every few seconds while playing,
-- merged into the real cursor (set_progress, the backward-allowed path)
-- and deleted on pause/ended. On power loss the row survives and the
-- boot sweep merges it — DreaMedia always knows the last position.
CREATE TABLE IF NOT EXISTS ext_live_sessions (
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_id         INTEGER NOT NULL REFERENCES ani_entries(id) ON DELETE CASCADE,
    season           INTEGER NOT NULL,
    episode          INTEGER NOT NULL,
    position_seconds INTEGER NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, entry_id)
);

-- Drift repair (found during review, 2026-11-20): databases created before
-- the FK constraints existed never got them — CREATE TABLE IF NOT EXISTS is
-- a no-op for existing tables, so inline REFERENCES clauses were skipped.
-- The live dev DB had FKs only on yt_* tables; every ani_* table (plus
-- notifications and sessions) had none, and ON DELETE CASCADE silently
-- didn't happen. Clean dangling rows (parent-first order where needed),
-- then add any missing FK idempotently.
DO $$
DECLARE
    fk RECORD;
BEGIN
    -- Orphan cleanup — a row whose parent is gone is unreachable garbage.
    -- Order matters: null dangling links, then delete top-down (users-level
    -- parents), and sweep leaf tables LAST so nothing re-orphans mid-run.
    UPDATE ani_entries e SET subdomain_id = NULL
        WHERE e.subdomain_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM ani_subdomains s
              JOIN ani_domains d ON d.id = s.domain_id
              WHERE s.id = e.subdomain_id
          );
    DELETE FROM ani_subdomains s WHERE NOT EXISTS (SELECT 1 FROM ani_domains d WHERE d.id = s.domain_id);
    DELETE FROM ani_domains    d WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = d.user_id);
    DELETE FROM notifications  n WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = n.user_id);
    DELETE FROM sessions       s WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id);
    DELETE FROM ani_entries    e WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = e.user_id);
    DELETE FROM ani_seasons    s WHERE NOT EXISTS (SELECT 1 FROM ani_entries e WHERE e.id = s.entry_id);
    DELETE FROM ani_schedule   s WHERE NOT EXISTS (SELECT 1 FROM ani_entries e WHERE e.id = s.entry_id);
    DELETE FROM ani_events     s WHERE NOT EXISTS (SELECT 1 FROM ani_entries e WHERE e.id = s.entry_id);
    DELETE FROM ani_todo       s WHERE s.entry_id IS NOT NULL
                              AND NOT EXISTS (SELECT 1 FROM ani_entries e WHERE e.id = s.entry_id);

    FOR fk IN
        SELECT * FROM (VALUES
            ('notifications',  'notifications_user_id_fkey',      'user_id',      'users',          'id', 'CASCADE'),
            ('sessions',       'sessions_user_id_fkey',           'user_id',      'users',          'id', 'CASCADE'),
            ('ani_domains',    'ani_domains_user_id_fkey',        'user_id',      'users',          'id', 'CASCADE'),
            ('ani_subdomains', 'ani_subdomains_domain_id_fkey',   'domain_id',    'ani_domains',    'id', 'CASCADE'),
            ('ani_entries',    'ani_entries_user_id_fkey',        'user_id',      'users',          'id', 'CASCADE'),
            ('ani_entries',    'ani_entries_subdomain_id_fkey',   'subdomain_id', 'ani_subdomains', 'id', 'SET NULL'),
            ('ani_seasons',    'ani_seasons_entry_id_fkey',       'entry_id',     'ani_entries',    'id', 'CASCADE'),
            ('ani_schedule',   'ani_schedule_entry_id_fkey',      'entry_id',     'ani_entries',    'id', 'CASCADE'),
            ('ani_events',     'ani_events_entry_id_fkey',        'entry_id',     'ani_entries',    'id', 'CASCADE'),
            ('ani_todo',       'ani_todo_user_id_fkey',           'user_id',      'users',          'id', 'CASCADE'),
            ('ani_todo',       'ani_todo_entry_id_fkey',          'entry_id',     'ani_entries',    'id', 'CASCADE')
        ) AS t(tbl, con, col, reftbl, refcol, action)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = fk.tbl::regclass AND conname = fk.con
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE %s',
                fk.tbl, fk.con, fk.col, fk.reftbl, fk.refcol, fk.action
            );
        END IF;
    END LOOP;
END $$;
