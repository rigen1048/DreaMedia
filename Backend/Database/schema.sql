-- DreaMedia schema (D3: Postgres; D8/D9: per-user encrypted content).
-- Convention: columns ending _enc are bytea ciphertext (XChaCha20-Poly1305)
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
    working       BOOLEAN NOT NULL DEFAULT FALSE
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

CREATE TABLE IF NOT EXISTS ani_entries (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subdomain_id  INTEGER REFERENCES ani_subdomains(id) ON DELETE SET NULL,
    anilist_id    INTEGER NOT NULL,       -- first-season AniList id
    title_enc     BYTEA NOT NULL,
    cover_enc     BYTEA,
    label         TEXT NOT NULL DEFAULT 'none' CHECK (label IN ('none', 'completed', 'blocked')),
    label_reason_enc BYTEA,
    list          TEXT NOT NULL DEFAULT 'watching' CHECK (list IN ('watchlist', 'confirmed', 'watching')),
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

CREATE TABLE IF NOT EXISTS ani_schedule (
    entry_id      INTEGER NOT NULL REFERENCES ani_entries(id) ON DELETE CASCADE,
    season_no     INTEGER NOT NULL,
    next_check_ts BIGINT,
    working       BOOLEAN NOT NULL DEFAULT FALSE,
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
                      'release_changed')),
    tier          TEXT NOT NULL CHECK (tier IN ('awaited', 'unwatched')),  -- D21
    payload_enc   BYTEA NOT NULL,
    seen          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ani_events_entry ON ani_events(entry_id, seen);
