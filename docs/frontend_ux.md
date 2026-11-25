# Frontend UX

Every consumer-facing screen and the implicit behavior behind it. The frontend
is a Vite + React 19 SPA (`Frontend/src`); all data flows through one GraphQL
workspace query (`App/api.ts::WORKSPACE_QUERY`) refreshed every 45 s, and every
mutation goes through `App/state.tsx::act()`, which **refetches the workspace
before returning** so controlled inputs always render the server's new state,
never the pre-mutation snapshot.

## Shell (chrome)

- **Left rail**: Feed, Manage, Todo, Trash (+ Admin for admins). Keyboard
  shortcuts `1`–`5` navigate; `/` focuses the search box on the current page.
- **Header**: page title + live counters (videos/events, sources/categories,
  playlists/anime), a `graphql live` pulse, the bell, settings gear, avatar.
- **Exit**: signs out and navigates to `/` immediately (P8) — the workspace
  cache is cleared in the same tick, so the login screen replaces the shell
  with no "Connecting…" interlude.
- **Toasts**: max 3, bottom-right, auto-dismiss after ~4 s. `act()` shows the
  success message you pass it, or the backend error on failure.

## Login

- Sign in / Sign up toggle. **The first registered user becomes admin**;
  everyone after is a normal user.
- Passwords are Argon2id-hashed server-side; the encryption key is derived
  from (password, username) at login and lives only in the in-memory vault —
  nothing readable is stored.
- Logout clears the cookie and the vault key; the vault is also locked by a
  backend restart (D9), which simply pauses a user's fetching until they log
  back in — it never crashes their rows.

## Notifications (Feed, `/` and `/notifications`)

The pull-based feed: YouTube videos and anime events, seen-state synced
through GraphQL.

- **Source tabs** (YouTube / Anime) with counts; YouTube rows carry a type
  chip filter (All types / Track / WordScan / Playlist / Random), anime rows
  carry group (Release / Change) and bucket (Today / Sequel / New) chips.
- **Search** filters title, channel, domain, subdomain client-side.
- **Delivery map** (right rail): domain → subdomain tree with per-node counts;
  clicking a node filters the feed. Muted nodes render struck-through.
- **Scopes card**: the effective delivery gate, spelled out:
  `domain ∧ subdomain ∧ channel`, and `label = 'none'`, and the subscription
  itself active. Muting a parent silences children without touching their flags.
- **Feed order (P5)**: serialized by domain → subdomain → channel so every
  item from one channel stays adjacent, newest-first within the channel —
  never `Fireship, Beyond the blue, Fireship` interleaving.
- **Clicking a row (D57/P9)** opens the source link in a new tab *and* moves
  the item to the trashbin — read means gone, with a 24 h restore window.
  Anime events additionally navigate to the matching Todo card.
- Per-row hover actions: mark read/unread; a dot marks unseen rows.
- **Mark visible read** marks every currently-visible unseen item read in bulk.

## Management (`/sources`)

Tabs in owner-chosen order (P1): **Anime · Channels · Categories · Blocked**.
Header counters track sources / categories / anime / muted.

### Channels

- **Fetch now** nudges every active subscription due immediately (the worker's
  claim discipline is untouched — it's a wake-up, not a second worker).
- **Channel batch actions** appear as soon as one or more rows are selected:
  change type/category, mute or unmute, enable or pause, set a label, or delete.
  The select-all checkbox applies to visible rows; bulk deletion requires a
  confirmation. Partial non-delete mutations keep the selection for retry;
  partial deletion reports the changed count and clears the selection so any
  remaining sources can be reselected without stale IDs.
  Changing selected channels to WordScan requires at least one comma-separated
  term, which is applied to every selected source; Playlist is not a valid
  channel batch target because a playlist subscription must be added from its
  playlist link.
- **Add source** dialog: channel/playlist/video link + notification type.
  Missing categories are created automatically. Types:
  - **Track** — every upload
  - **WordScan** — only titles matching your comma-separated terms
  - **Playlist** — new items of a playlist (requires the playlist link)
  - **Random** — an occasional pick on a frequency (daily → monthly)
- **Row**: click the channel name/logo to open its editor (P10); type select
  inline; status badge (`Live` / `Paused` / `Blocked`, or `muted` when a
  parent scope silences it).
- **Editor**: notification type (+ WordScan terms / Random frequency when
  relevant), attach-to-domain, and **one Channel-state toggle** (P3):
  `Receiving` ⇄ `Paused — still subscribed, receiving nothing`. Paused is the
  single stop concept; there is no separate per-channel mute, reserved, or
  disable. **Block** (red) is the distinct "never want this channel" action.
  The `effective on/off` badge explains whether the whole scope chain delivers.
- Switching modes is exclusive: a channel lives in exactly one mode; switching
  moves its row between the tracking/playlist/random tables atomically (P2
  made random → Track/WordScan possible by falling back to the channel URL as
  the RSS source).

### Categories

- YouTube and Anime sections side by side. Domains group channels/entries;
  subdomains attach to them.
- Per-domain mute bell, inline rename (Enter/blur commits, Esc cancels),
  confirm-delete; subdomains get a notify switch + rename + delete.
- New domain/subdomain inputs commit on Enter or the `+` button.

### Anime

- **List filter chips** with counts: All / Watching / UpToDate / Next sequel /
  New anime / Watchlist / Completed / Blocked.
- **Track anime** dialog: title (AniList resolves metadata/seasons), track-as
  (Watching with S/E/time start, UpToDate, Watchlist with certainty), optional
  domain/subdomain.
- **Card**: poster, type/seasons/eps/year, domain/subdomain badge (P11 — no
  dangling `—`, no duplicate "uncategorized"), position line (P13 — the real
  cursor, derived from seasons only for cursor-less up-to-date entries),
  progress bar, list select, watchlist certainty, state select, Block, release
  notify switch.
- **Expanded card** (chevron): per-season rows with **posters** (P14 — every
  season's cover, not just season 1), state, aired/total eps, date, watched
  switch; then the control row:
  - **S/E/Time editor** (P12/P15): clearable numeric fields (no snapping back
    to 0), Update commits. This is the *backward-allowed* correction path —
    the `+1` cursor is deliberately forward-only (D44), so an overshot bump is
    fixed here. Seconds persist the halfway-watch bookmark.
  - **+1 episode** (forward-only cursor), **Next season** (backend decides:
    next season already out → watch it; dated → wait in Next sequel and
    schedule an immediate check; none → completed), **Finish** (completed).
  - Category attach, Type select, Remove entry.

### Blocked

- Blocked sources and anime with their domain/subdomain and an **Unblock**
  button. Blocked items never notify and stay out of feed filters.

## Todo (`/todo`)

Two sections (P18):

- **Custom playlist** — hand-built video lists. Create by name, then paste
  YouTube links in the drawer; the backend resolves titles/thumbnails in the
  background (a YouTube bot-wall can never lose a link). Tiles show done/total
  and a thumbnail preview; items check off, delete, and reorder by insertion.
- **Halfway** — the anime watch queue: every tracked, non-blocked, active
  entry, sorted watching → up_to_date → next_sequel → new_anime → watchlist,
  then by next-airing date. Cards show cursor (S · E / season total), aired
  count, next airing, the same S/E/Time editor (halfway seconds included),
  +1/Next season/Finish, or **Start watching** for non-watching lists.
  A `?entry=` deep-link (from an anime notification) scrolls and pulses the card.

## Trashbin (`/trash`)

Everything opened from the feed lands here with a 24 h purge window. Restore
puts items back unseen; the purge worker deletes them permanently after a day.

## Admin (`/admin`, admin role only)

Non-admins hitting the URL get redirected to Notifications client-side; the
backend re-checks the role on every admin field regardless.

- **Overview**: backup count/latest, keep-last, frequency, user/admin counts,
  restore state.
- **Backups**: run now, download any dump. Changing *keep latest* prunes the
  oldest dumps **immediately** (P6), not at the next scheduled run.
- **Restore**: upload a `.dump` (validated with `pg_restore -l` before it's
  accepted) or restore an existing backup file. While a restore runs, the API
  middleware answers every non-GET with 503 (the restore gate — DB-backed so
  every worker agrees), and the UI polls the GET status endpoint. After a
  successful restore **every session is dropped**, including the admin's —
  the restored users table is authoritative.
- **Settings**: admin-editable values with hardcoded floors shown inline
  (floors can never be overridden from the UI or .env).
- **Users**: role promote/demote and delete are last-admin protected (atomic
  under concurrency), and demoting/deleting drops that user's sessions.

## Settings (`/settings`)

- **Extension token**: issue (shown once — copy immediately) or revoke; a new
  token replaces the old instantly. The extension talks to `/ext/*` with it,
  never with your session.
- **Portable backup**: download your data as decrypted plain text (survives
  schema changes; import re-encrypts and re-resolves channels/anime from their
  links, restoring cursors and watched seasons).

## Cross-cutting implicit behavior

- **One GraphQL endpoint** for everything except three deliberate REST calls:
  the multipart restore upload, the backup download, and the restore status
  poll (which must answer while mutations are 503'd).
- **Read models are decrypted server-side per-user**; the DB only ever holds
  ciphertext. A locked vault (logged out / restarted) means empty views, never
  errors — and fetching for that user pauses by design.
- **`act()` invalidates + refetches synchronously** — switches and selects
  never show stale state after a mutation.
- **Trash = the read model**: feed items you open are trashed, not marked read
  in place; the trashbin is the undo window.
- **Cursors are linear**: anime progress is one (season, episode, seconds)
  cursor that may only move forward, plus per-season watched flags. No
  per-episode history exists anywhere.
- **Keyboard-first**: rail shortcuts 1–5, `/` focuses search, Enter commits
  most inline editors, Esc cancels them.
