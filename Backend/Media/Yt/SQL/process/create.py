"""Creates every table Media/Yt requires (D58/D62).

Idempotent — replayed on every boot by Database/Init/migrate.py AFTER the
shared schema and BEFORE Database/Init/constraints.sql (the FK repair
block references these tables). Media-specific DDL never lives outside
the media folder.
"""

DDL = """
-- Bulk extension imports are durable jobs. Links, selected source settings,
-- and per-channel errors are encrypted with the owning user's vault key.
CREATE TABLE IF NOT EXISTS yt_import_jobs (
    job_id       TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'completed', 'partial')),
    requested    INTEGER NOT NULL CHECK (requested >= 0),
    processed    INTEGER NOT NULL DEFAULT 0,
    resolved     INTEGER NOT NULL DEFAULT 0,
    added        INTEGER NOT NULL DEFAULT 0,
    skipped      INTEGER NOT NULL DEFAULT 0,
    failed       INTEGER NOT NULL DEFAULT 0,
    options_enc  BYTEA NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yt_import_jobs_user ON yt_import_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yt_import_jobs_queue ON yt_import_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS yt_import_items (
    id           BIGSERIAL PRIMARY KEY,
    job_id       TEXT NOT NULL REFERENCES yt_import_jobs(job_id) ON DELETE CASCADE,
    ordinal      INTEGER NOT NULL,
    link_enc     BYTEA NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'resolving', 'resolved', 'processing', 'running', 'added', 'skipped', 'failed')),
    error_enc    BYTEA,
    resolved_enc BYTEA,
    claimed_at   TIMESTAMPTZ,
    claim_token  TEXT,
    UNIQUE (job_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_yt_import_items_queue
    ON yt_import_items(job_id, status, ordinal);

-- Two-stage bulk YouTube imports. These migrations also upgrade the earlier
-- single-stage queue without losing work: old in-flight rows are re-queued
-- for resolution (writes use skip-existing, so replay is idempotent).
ALTER TABLE yt_import_jobs ADD COLUMN IF NOT EXISTS resolved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE yt_import_items ADD COLUMN IF NOT EXISTS resolved_enc BYTEA;

DO $$
BEGIN
    ALTER TABLE yt_import_items DROP CONSTRAINT IF EXISTS yt_import_items_status_check;
    ALTER TABLE yt_import_items
        ADD CONSTRAINT yt_import_items_status_check
        CHECK (status IN (
            'queued', 'resolving', 'resolved', 'processing', 'running',
            'added', 'skipped', 'failed'
        ));
END $$;

UPDATE yt_import_items
SET status = 'queued', claimed_at = NULL, claim_token = NULL
WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_yt_import_items_stage
    ON yt_import_items(status, claimed_at, job_id, ordinal);

-- Existing item-row claims plus GateRegistry provide durable work and
-- per-user network pacing; legacy global slots/dispatcher are no longer used.
DROP TABLE IF EXISTS yt_import_worker_slots;
DROP TABLE IF EXISTS yt_import_dispatcher;

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

-- Per-scope notify flags (D20/D37): mute a domain, subdomain, or channel.
ALTER TABLE yt_domains    ADD COLUMN IF NOT EXISTS notify BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE yt_subdomains ADD COLUMN IF NOT EXISTS notify BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE yt_channels   ADD COLUMN IF NOT EXISTS notify BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE yt_randomsubs ADD COLUMN IF NOT EXISTS claimed_at BIGINT;

-- D57 trashbin (yt side).
ALTER TABLE yt_videos  ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_yt_videos_trash ON yt_videos(trashed_at) WHERE trashed_at IS NOT NULL;

-- Cleanup #4 (yt side): blocked/reserved channels carry their own
-- domain/subdomain + the text reason.
ALTER TABLE yt_channels  ADD COLUMN IF NOT EXISTS blocked_domain_enc BYTEA;
ALTER TABLE yt_channels  ADD COLUMN IF NOT EXISTS blocked_subdomain_enc BYTEA;
CREATE INDEX IF NOT EXISTS idx_yt_channels_subdomain ON yt_channels(subdomain_id);

-- F1 Withhold: quantity-batched feed releases. Videos from a withhold
-- subscription buffer (withheld=TRUE, hidden from the feed) until the
-- buffered count reaches the threshold, then release as one batch.
ALTER TABLE yt_tracking ADD COLUMN IF NOT EXISTS withhold_threshold INTEGER;
ALTER TABLE yt_videos  ADD COLUMN IF NOT EXISTS withheld BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_yt_videos_withheld ON yt_videos(channel_id) WHERE withheld;
"""
