# DreaMedia Extension — Target Design (v2)

Recorded 2026-11-20. This is the agreed design for the extension rework.
It supersedes the v1 shape (`<all_urls>` content script, REST `/ext` router,
manual popup binding) as each phase lands. Build order is at the bottom.

## Problems with v1 this design solves

- The content script is registered on `<all_urls>`: it wakes up (observer,
  URL poll, video search) on google.com, github.com, everywhere. Wasted
  compute on every page the user ever opens.
- We must not dictate which sites the user watches anime (or future media)
  on. So the fix cannot be a hardcoded domain list — it must be a minimal,
  user-controlled allowlist.
- Binding a tab to an anime is manual (popup pick). The extension should
  recognize what is being watched on its own.
- Progress reporting is REST-only; we want one lane with logs, tracing,
  debuggability.
- Power loss can cost up to the 15s report interval of watch progress.

## 1) Domain allowlist (`ext_domains`)

- New table `ext_domains`: `id, user_id, domain_enc, domain_hash,
  media ('yt'|'ani'), enabled, added_at`. Domains are encrypted like
  everything else (index_hash for lookup).
- The extension ships **no static content script**. The background worker
  fetches the allowlist, caches it, and calls
  `chrome.scripting.registerContentScripts()` (MV3) /
  `browser.contentScripts.register()` (Firefox MV2) with match patterns
  built from it. Code never loads on non-registered domains — zero compute.
- Minimal way to add a domain: on a non-registered site the popup shows a
  single "Enable DreaMedia on this site" button + media type. A DreaMedia
  page (Management/Settings section) lists domains with toggle/remove.
  Both write the same table.
- We never prescribe which sites to use — the user teaches the extension
  their sites once, per site.

## 2) Modular extension source (Youtube / Anime)

- `shared/` splits into `modules/youtube.js`, `modules/anime.js`, and a
  small shared core (video finding, messaging, storage).
- The `media` column of `ext_domains` decides which module is registered
  for a domain: youtube.com gets only the youtube module; an anime site
  gets only the anime module.
- `setup.py build_extensions()` copies shared/ (including modules/) into
  mv2/ and mv3/ as today; manifests stay variant-only.

## 3) Anchor detection (auto-binding)

- The anime module extracts candidate titles from the page —
  `document.title`, `og:title` meta, main `h1` — and sends them to
  DreaMedia. **Matching is server-side**: DreaMedia compares against the
  user's tracked entries' title variants (AniList romaji/english/native)
  and returns `entry_id` or null.
- On a match the extension auto-binds and reports progress. The popup
  binding remains as a manual override.
- Season/episode parsing from titles is best-effort ("One Piece 1230",
  "S3E4", "Ep. 4" all occur). When numbers can't be parsed we still know
  which anime it is and track position against the current cursor episode.
- Default: anchor detection tracks **existing entries only**; it does not
  auto-add unknown anime to the library (revisit if wanted).

## 4) Video finding — unchanged (SyncNwatch model)

- First ready `<video>`, robust selector cached per host, MutationObserver
  re-attach, URL-poll for SPA navigation. Moves into the shared core
  module as-is.

## 5) Local blocked list with disclaimer

- DreaMedia hands the extension the blocked list (channels for youtube,
  entries for anime); the extension caches it in `storage.local`.
- Matching happens **locally** — no per-page URL is sent to the server.
  When the user lands on blocked content the extension shows a disclaimer
  popup.
- Vault constraint: the list can only be refreshed while the user has a
  live web session (D9 — the token identifies, it is not key material).
  When the vault is locked the extension keeps the last cached copy —
  blocking keeps working, possibly stale. Accepted trade.
- Anime blocking reuses anchor detection: if the anchor matches a blocked
  entry, the disclaimer fires.

## 6) Extension GraphQL API (`/ext/graphql`)

- A **second Strawberry schema** mounted at `/ext/graphql`: extension-only
  queries/mutations, token auth, small stable contract. Keeps the v1
  guarantee ("the extension is released software that can't ride our
  internal refactors") while giving one lane for logging, tracing, and
  debuggability.
- The REST `/ext` router stays until the new extension ships, then is
  deleted. Token system (`Extension/tokens.py`, `dm_` + sha256) is
  unchanged.

## 7) Websocket + live-session table (crash-safe progress)

- The websocket **is the GraphQL transport** (graphql-ws protocol,
  supported by Strawberry): one token-authed connection carries all
  extension traffic including position updates.
- New table `ext_live_sessions`: `user_id, entry_id, season, episode,
  position_seconds, updated_at` — one row per active watch.
  - While watching: the extension upserts every few seconds.
  - On pause/ended: merge into the real cursor via the backward-allowed
    `set_progress` path (never the forward-only D44 cursor), delete the
    live row.
  - On power loss: the row survives. A boot-time sweep merges stale live
    rows into cursors and deletes them. DreaMedia always knows the last
    watched position.

## 8) Per-anime watch sites (notification deep-links)

- New table `ani_watch_sites`: `user_id, entry_id, domain, series_url,
  last_page_url, use_count, last_used_at`. Learned **passively**: every
  anchor report carries the domain + page URL, so the map builds itself.
- Notification click ("One Piece ep 1230 released") opens the user's
  site for that anime, resolved in this order:
  1. **Endpoint pattern**: most sites use a URL pattern with the episode
     number in it. Pattern-match the stored `last_page_url` (episode
     number, season) and construct the new episode URL.
  2. If the URL doesn't match a known pattern → the site's **home page**
     (a fresh release shows up there).
  3. No recorded site → fall back to the AniList link.

## Merged architecture

```
ext_domains (DB) ──► popup "enable this site" / DreaMedia domains page
        │ (fetched by background, cached locally)
        ▼
background: registerContentScripts per domain, per media type
        │
        ├── youtube module: subscribe-from-page, playlist add, block disclaimer
        └── anime module: anchor detect → server match → auto-bind
                          video attach (shared core) → position stream
        │
        ▼  single lane: graphql-ws (token-authed) → /ext/graphql schema
        ▼
Backend: mutations → stores → Postgres
         live positions → ext_live_sessions → boot sweep merge → ani cursor
         anchor reports → ani_watch_sites (learned passively)
         blocked list → extension cache (refreshed while vault unlocked)
```

## Build order (one commit per phase, verified then pushed)

1. `ext_domains` table + store + GraphQL + DreaMedia domains page;
   extension dynamic content-script registration + modular split
   (kills the `<all_urls>` waste).
2. `/ext/graphql` schema + websocket transport + `ext_live_sessions`
   + boot sweep.
3. Anchor detection + server-side matching + auto-bind.
4. Blocked-list cache + disclaimer.
5. `ani_watch_sites` + pattern-matched notification deep-links.
