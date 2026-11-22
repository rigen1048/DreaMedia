# Backend notes

The backend is the source of truth for PostgreSQL, ingestion, encryption,
notification production and durable writes. The frontend owns presentation
and calls the authenticated backend API for bell history and read state.

## Contract

- **Data:** GraphQL is the frontend's primary application API. The header bell
  uses authenticated `GET /notifications` and `POST /notifications/seen`.
- **Messages:** `Utility.notify.notify()` writes each encrypted message once to
  the PostgreSQL `notifications` table. The bell reads and updates that same
  table; there is no bridge, JSON inbox, or duplicate notification store.
- **Scope gates:** `notify_yt_video()` and `notify_ani_release()` call
  `PgStore.notify_enabled` / `AniStore.notify_enabled`, i.e.
  `domain.notify AND subdomain.notify AND channel/entry.notify AND label='none'`
  (plus subscription/entry `active`). Muting a parent silences children without
  mutating their own flags.

## Decisions worth keeping

| Area | Decision |
| --- | --- |
| Sessions | DB-backed session records in an httpOnly cookie; the encryption vault key remains in memory and is re-derived on login |
| Cursors | Forward-only anime cursor (season/episode/seconds) + watched seasons; no per-episode history |
| Playlists | Links are inserted immediately; title/thumbnail enrichment runs in the background (oEmbed → yt-dlp → id stub) so a YouTube bot-wall can never lose a link |
| Blocked / completed | Single `label` column (`none`/`completed`/`blocked`) shared by both media types; both labels suppress delivery |
| Muting | Separate `notify` flags at domain, subdomain and channel/entry level |

## Remaining follow-ups

- Wire purely operational events (channel deleted upstream, source unreachable)
  through `notify()` so they appear beside release messages.
- Optional per-domain default notification *type* (mode) if the UI ever needs
  it; today modes are per channel by design.
- Watch history beyond the linear cursor remains out of scope.
