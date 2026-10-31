# Backend follow-ups — Feed and msg contract

The frontend/backend contract is now explicit: **Feed** is query-driven through the `/graphql` supergraph; **msg** is an exclusive backend-to-frontend HTTP message lane surfaced by the bell. Feed rows must never be used as bell messages. The backend exposes notification-history reads and seen-state updates; the frontend uses GraphQL for feed reads and feed seen-state changes.

The preserved GitHub `main` was pulled through `b8f2aeb70ad028fc86b0e6b7877a31a937ba2c98` (`Frontend contract acceptance…`). That upstream pull added the URL resolver, stable feed IDs, seen-state writes, subscription mode/active changes, category CRUD, Ani Canon/cursor/range/easy completion, notification history, and cookie logout handling. Those changes came from upstream. The structural refactor moves the original backend under `/Backend` as Git-tracked renames; backend implementation files remain unchanged.

## Backend owner follow-ups

| Priority | Item | Current contract / frontend behavior |
|---|---|---|
| P2 | Wire operational events that should reach the bell (for example, a subscribed channel being deleted or becoming unavailable) to the existing backend `Utility.notify.notify()` helper. | `GET /notifications` reads message history and `POST /notifications/seen` acknowledges IDs. `notify()` can insert a message record, but no operational producer call sites are currently wired. The frontend bell displays only these records and never synthesizes messages from Feed data. |
| P2 | Decide whether notification mode should also be configurable per domain/subdomain. | The API configures Track/Wordscan/Playlist/Random per channel and supports category Active/Inactive, add, rename, delete, and assignment. There is no category-level notification-mode field/route; the frontend does not fake one. |
| P3 | Keep the current Ani progress model, or later support out-of-order per-episode history. | The API supports a forward-only cursor (season/episode/seconds), watched seasons, season ranges, and Complete All. The UI uses those operations rather than local-only per-episode checkboxes. |

## Frontend API split

- **Feed queries:** `POST /graphql` with `ytFeed(limit)`, `ytSidebar`, `ytChannels(includeBlocked)`, and `aniEvents(includeSeen)` on the supergraph.
- **Feed seen-state:** GraphQL mutations `ytMarkSeen(videoIds, seen)` and `aniEventsSeen(eventIds, seen)`.
- **Bell messages only:** `GET /notifications` returns `{id, media, kind, payload, pushed, seen, created_at}`; `POST /notifications/seen` accepts `{ids, seen}`.
- **HTTP REST outside Feed:** auth routes; YouTube subscribe/mode/active/label/category-management routes; Ani management metadata (`GET /ani/feed/management`) and tracking/progress writes. No `/yt/feed/*` or `/ani/feed/events` REST read is used for user-facing Feed content.

Postgres, schema/migrations, media ingestion, auth, message production, and durable state remain backend-owned. The frontend owns no DB or demo fallback.
