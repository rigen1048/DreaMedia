# Backend notes

The backend is the source of truth for Postgres, ingestion, encryption,
notification production and durable writes. The frontend owns presentation and
one small service: the notification receiver.

## Contract

- **Data:** every read/write goes through one GraphQL endpoint
  (`Backend/Graphql/children.py` + `supergraph.py`). Older REST management
  routes still exist for compatibility and tooling, but the UI no longer uses
  them.
- **Messages:** `Utility.notify.notify()` writes the encrypted history row and
  POSTs the same message to `FRONTEND_NOTIFY_URL` (the frontend bridge). Only
  pushes that arrive through that receiver reach the bell.
- **Scope gates:** `notify_yt_video()` and `notify_ani_release()` call
  `PgStore.notify_enabled` / `AniStore.notify_enabled`, i.e.
  `domain.notify AND subdomain.notify AND channel/entry.notify AND label='none'`
  (plus subscription/entry `active`). Muting a parent silences children without
  mutating their own flags.

## Decisions worth keeping

| Area | Decision |
| --- | --- |
| Sessions | In-memory, httpOnly cookie; restart re-authenticates and re-derives the vault key |
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
