# DreaMedia Features

This document explains what DreaMedia does from a user and product perspective. For system design, see [ARCHITECTURE.md](ARCHITECTURE.md). For installation, see [INSTALL.md](INSTALL.md).

Start with [INSTALL.md][install] when setting up an instance, then return to [FEATURES.md][features] to configure source modes, queues, and extension workflows.

## Personal attention freedom

DreaMedia does not ask one platform-wide algorithm to decide what deserves your attention. You define how each source should behave.

### YouTube source modes

- **Track:** every upload from a source.
- **WordScan:** only titles matching configured terms.
- **Playlist:** new items from a selected playlist.
- **Random:** occasional selections on a user-controlled frequency.

A source can be paused without being deleted. A source can also be blocked when the user wants a stronger, permanent exclusion.

### Hierarchical notification scopes

Categories form a flexible attention tree:

```text
Technology
├── AI
│   ├── Local models
│   └── Research
└── Hardware

Anime
├── Watching
├── Seasonal
└── Maybe later
```

Notification state can exist at the domain, subdomain, and individual source level. Muting a parent silences descendants without rewriting their local preferences.

## Chronological, source-driven feed

The feed is designed to answer:

> What did the sources I deliberately chose publish?

It is not designed to maximize session length or replace the user’s choices with recommendations.

The feed supports:

- YouTube and anime source tabs.
- Track, WordScan, Playlist, and Random type filters.
- Anime Release and Change groups.
- Today, Sequel, and New date buckets.
- Search by title, channel, domain, and subdomain.
- Delivery-map filtering.
- Seen/unseen state.
- Mark-visible-read actions.
- Source links that open the canonical destination.
- A 24-hour trash-and-restore lane for opened items.

## Anime release and progress system

DreaMedia turns anime following into a stateful workflow rather than a static list.

### Tracking modes

- **Watching:** actively follow a current cursor.
- **UpToDate:** follow the current AniList state and future releases.
- **Watchlist:** save a title with certainty such as Not yet, Confirmed, Completed, or Blocked.

### Season intelligence

Each entry can expose:

- anime type;
- season count;
- episode totals;
- aired episode count;
- release dates;
- next airing date and episode;
- per-season posters;
- per-season watched state;
- sequel state;
- notification state;
- domain and subdomain placement.

### Cursor-based watch memory

The main cursor is:

```text
Season · Episode · Position in seconds
```

The cursor supports +1 episode, direct S/E/time correction, and season transitions. The Next season action determines whether to start an available sequel, wait for an announced sequel, or complete the chain.

The system intentionally keeps progress primarily linear. It does not attempt to model every possible rewatch or per-episode history yet.

## Todo and personal playlists

### Custom video playlists

- Create named cards.
- Paste multiple video links.
- Store links immediately.
- Enrich title and thumbnail metadata in the background.
- Display compact tiles with progress and thumbnails.
- Open long lists in a drawer.
- Check off items.
- Delete items.
- Open every row at its source URL.

Metadata failure should not erase the user’s link or intention.

### Anime queue

The anime queue is driven by the same state as Management. It can show:

- Watching entries;
- UpToDate entries;
- Next sequel entries;
- new anime;
- watchlist entries;
- current cursor;
- aired and total episodes;
- next airing date;
- season actions;
- finish action;
- direct S/E/time correction.

Release events can deep-link into the relevant queue entry.

## Browser extension

The extension is available as Chrome MV3 and Firefox MV2 variants.

It supports:

- subscribe from a YouTube channel, playlist, or video page;
- add the current video to a DreaMedia playlist;
- bind a tab to a tracked anime;
- detect the playing video element;
- send playback heartbeats;
- merge progress on pause or ended;
- recover live progress after an unclean shutdown;
- use an allowlist of enabled sites;
- cache blocked sources locally;
- show a blocked-content disclaimer;
- learn which sites are used for an anime;
- open a learned watch site from a release notification.

The extension talks to a separate token-authenticated GraphQL lane. It does not use the user’s web session cookie.

## Privacy and account independence

- No Google account is required for DreaMedia subscriptions.
- The user can run a hardened browser that clears cookies aggressively.
- The user can use a VPN without losing the DreaMedia media graph.
- Personal categories, rules, progress, queues, and notification memory remain in the user-controlled instance.
- User content is encrypted at rest with per-user keys.
- Extension credentials are separate, hashed, revocable tokens.
- The bell reads encrypted notifications and seen state from PostgreSQL through the authenticated backend session.
- Portable exports and database backups are available.

DreaMedia still depends on external public sources and metadata providers. The important distinction is that a hosted third-party intermediary is not required to own the user’s personal media relationship.

## Migration and portability

### Portable export

Export and import personal data in a schema-resilient text format. Import re-resolves channels and anime from their links while restoring supported progress and watched state.

### CSV

Export or import YouTube and anime data as CSV. YouTube migration is designed to support common FreeTube and HydraWatch workflows.

### Database backups

Administrators can create PostgreSQL dumps, download them, upload validated dumps, and restore with a pre-restore snapshot and tracked status.

## Administration

Admin users can:

- inspect backup state;
- run backups;
- configure retention within hardcoded safety floors;
- download dumps;
- upload and validate restore archives;
- start tracked restores;
- manage runtime settings;
- promote or demote users;
- reset passwords;
- delete users with last-admin protection.

## Resilience

The product is designed for personal installations that may be offline, restarted, or interrupted during background work. This is a user-facing feature: the media relationship should survive the local device’s normal failure modes.

- source workers keep last-seen state;
- fetching can resume after downtime;
- source work is claimed to avoid duplicate workers;
- stale work can be recovered;
- a killed process does not permanently own a claimed job;
- a dead manager leader can be replaced through database-backed coordination;
- internet loss causes waiting and later retry rather than destructive empty results;
- provider rate limits and outages use backoff instead of tight retry loops;
- restore windows pause competing writers behind a shared gate;
- playlist links are saved before enrichment;
- restore is gated and tracked;
- the browser extension keeps a live-session path for progress recovery.

For a local Docker appliance, this means a restart, temporary outage, or browser crash is an interruption to recover from rather than a reason to rebuild the user’s library or media graph.

## Keyboard-first interface

- `1` — Notifications.
- `2` — Management.
- `3` — Todo.
- `4` — Admin for administrators.
- `5` — Trash.
- `/` — focus search.
- `Esc` — close panels and drawers.

## Product boundaries

DreaMedia currently focuses on personal media organization rather than becoming a full streaming platform. It does not provide:

- video hosting;
- a replacement video player for every provider;
- a global recommendation marketplace;
- complete per-episode rewatch history;
- a hosted cloud account;
- guaranteed metadata availability when external providers are unavailable.


[install]: INSTALL.md "DreaMedia installation guide"
[features]: FEATURES.md "DreaMedia feature guide"
