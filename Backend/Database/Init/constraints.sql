-- Drift repair (found during review, 2026-11-20): databases created before
-- the FK constraints existed never got them — CREATE TABLE IF NOT EXISTS is
-- a no-op for existing tables, so inline REFERENCES clauses were skipped.
-- The live dev DB had FKs only on yt_* tables; every ani_* table (plus
-- the bell table and sessions) had none, and ON DELETE CASCADE silently
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
    DELETE FROM alerts         a WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id);
    DELETE FROM sessions       s WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id);
    DELETE FROM ani_entries    e WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = e.user_id);
    DELETE FROM ani_seasons    s WHERE NOT EXISTS (SELECT 1 FROM ani_entries e WHERE e.id = s.entry_id);
    DELETE FROM ani_schedule   s WHERE NOT EXISTS (SELECT 1 FROM ani_entries e WHERE e.id = s.entry_id);
    DELETE FROM ani_events     s WHERE NOT EXISTS (SELECT 1 FROM ani_entries e WHERE e.id = s.entry_id);
    DELETE FROM ani_todo       s WHERE s.entry_id IS NOT NULL
                              AND NOT EXISTS (SELECT 1 FROM ani_entries e WHERE e.id = s.entry_id);

    FOR fk IN
        SELECT * FROM (VALUES
            ('alerts',         'alerts_user_id_fkey',             'user_id',      'users',          'id', 'CASCADE'),
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
