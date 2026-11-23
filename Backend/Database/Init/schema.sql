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

-- Alerts for the header bell (D60/D61): backend-driven, unhappy-path ONLY
-- ("channel got deleted", "no internet"). Feed never lands here — the feed
-- is pull-only from the media tables (yt_videos, ani_events). Encrypted
-- PostgreSQL rows are the single source of truth; the frontend reads and
-- updates them via GraphQL (alerts / markAlertsSeen).
CREATE TABLE IF NOT EXISTS alerts (
    id            BIGSERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media         TEXT NOT NULL,
    kind          TEXT NOT NULL,
    payload_enc   BYTEA NOT NULL,
    seen          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, seen);

-- D61 vocabulary purge: notifications → alerts. Idempotent; preserves any
-- pre-rename history, then drops the old table.
DO $$
BEGIN
    IF to_regclass('notifications') IS NOT NULL THEN
        INSERT INTO alerts (user_id, media, kind, payload_enc, seen, created_at)
            SELECT user_id, media, kind, payload_enc, seen, created_at
            FROM notifications;
        DROP TABLE notifications;
    END IF;
END $$;

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

CREATE INDEX IF NOT EXISTS idx_alerts_user_created ON alerts(user_id, created_at DESC);

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

-- One-time defaults marker: a removed default site must not reappear on sync.
CREATE TABLE IF NOT EXISTS ext_domain_defaults (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    applied_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
