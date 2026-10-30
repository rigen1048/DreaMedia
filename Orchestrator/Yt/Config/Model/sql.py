Schema={"Youtube_Schema":"""
    -- =============================================================
    -- Core categorization
    -- =============================================================
    CREATE TABLE IF NOT EXISTS Domains (
        id_domain INTEGER PRIMARY KEY AUTOINCREMENT,
        domain_name TEXT NOT NULL DEFAULT 'uncategorized' UNIQUE,
        active INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_domains_name ON Domains(domain_name);

    -- =============================================================
    -- Subdomains with hierarchy
    -- =============================================================
    CREATE TABLE IF NOT EXISTS SubDomains (
        id_subdomain INTEGER PRIMARY KEY AUTOINCREMENT,
        id_domain INTEGER NOT NULL,
        subdomain_name TEXT NOT NULL DEFAULT 'uncategorized',
        active INTEGER DEFAULT 1,
        UNIQUE(id_domain, subdomain_name),
        FOREIGN KEY (id_domain) REFERENCES Domains(id_domain) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subdomains_domain ON SubDomains(id_domain);
    CREATE INDEX IF NOT EXISTS idx_subdomains_name ON SubDomains(subdomain_name);

    -- =============================================================
    -- Mapping table for hierarchical deactivation
    -- =============================================================
    CREATE TABLE IF NOT EXISTS SubDomainTree (
        id_subdomain_tree INTEGER PRIMARY KEY AUTOINCREMENT,
        id_subdomain INTEGER NOT NULL,
        FOREIGN KEY (id_subdomain) REFERENCES SubDomains(id_subdomain) ON DELETE CASCADE
    );

    -- =============================================================
    -- Main entity
    -- =============================================================
    CREATE TABLE IF NOT EXISTS Channel (
        id_channel INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_name TEXT NOT NULL,
        channel_logo TEXT,
        channel_url TEXT NOT NULL UNIQUE,
        id_subdomain INTEGER,
        FOREIGN KEY (id_subdomain) REFERENCES SubDomains(id_subdomain) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_url ON Channel(channel_url);
    CREATE INDEX IF NOT EXISTS idx_channel_name ON Channel(channel_name);
    CREATE INDEX IF NOT EXISTS idx_channel_subdomain ON Channel(id_subdomain);

    -- =============================================================
    -- Tracking / Word-based
    -- =============================================================
    CREATE TABLE IF NOT EXISTS Tracking (
        rss_id TEXT PRIMARY KEY,
        id_channel INTEGER NOT NULL,
        last_video_id TEXT,
        ts INTEGER,
        rank TEXT,
        counter INTEGER DEFAULT 0,
        type INTEGER DEFAULT 0, -- 0: RSS, 1: Word-based, etc.
        word TEXT,
        active INTEGER DEFAULT 1,
        working INTEGER DEFAULT 0,
        FOREIGN KEY (id_channel) REFERENCES Channel(id_channel) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tracking_channel ON Tracking(id_channel);
    CREATE INDEX IF NOT EXISTS idx_tracking_ts ON Tracking(ts);

    -- =============================================================
    -- Playlist Subscription
    -- =============================================================
    CREATE TABLE IF NOT EXISTS Playlist (
        id_playlist TEXT PRIMARY KEY,
        id_channel INTEGER NOT NULL,
        last_video_id TEXT,
        ts INTEGER,
        rank TEXT NOT NULL,
        counter INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        working INTEGER DEFAULT 0,
        FOREIGN KEY (id_channel) REFERENCES Channel(id_channel) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_playlist_channel ON Playlist(id_channel);

    -- =============================================================
    -- Random Subscription
    -- =============================================================
    CREATE TABLE IF NOT EXISTS RandomSub (
        id_randomsub INTEGER PRIMARY KEY AUTOINCREMENT,
        id_channel INTEGER NOT NULL,
        ts INTEGER, -- Calculated with Rank + TS
        rank TEXT NOT NULL, -- Must not be Automated
        active INTEGER DEFAULT 1,
        working INTEGER DEFAULT 0,
        FOREIGN KEY (id_channel) REFERENCES Channel(id_channel) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_randomsub_channel ON RandomSub(id_channel);
    CREATE INDEX IF NOT EXISTS idx_randomsub_active ON RandomSub(active);

    -- =============================================================
    -- Videos (Feed)
    -- =============================================================
    CREATE TABLE IF NOT EXISTS Video (
        id_video INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL,
        video_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        thumbnail TEXT,
        published_at INTEGER,
        seen INTEGER DEFAULT 0,
        FOREIGN KEY (channel_id) REFERENCES Channel(id_channel) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_video_channel ON Video(channel_id);
    CREATE INDEX IF NOT EXISTS idx_video_seen ON Video(seen);

    -- =============================================================
    -- Maintenance
    -- =============================================================
    CREATE TABLE IF NOT EXISTS Sync (
        last_sync INTEGER NOT NULL,
        rank TEXT DEFAULT 'month',
        working INTEGER DEFAULT 0
    );
"""}
