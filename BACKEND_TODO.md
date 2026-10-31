# Backend follow-ups — review after upstream pull

The preserved GitHub `main` was pulled through `b8f2aeb70ad028fc86b0e6b7877a31a937ba2c98` (`Frontend contract acceptance…`). The pull added the URL resolver, stable feed IDs, seen-state writes, subscription mode/active changes, category CRUD, Ani Canon/cursor/range/easy completion, and cookie logout handling. Those implementation changes came from upstream. This frontend task did not edit backend implementation; in the final monorepo, backend paths are relocated under `/Backend` as Git-tracked moves only.

## Open owner decisions

| Priority | Question | Current frontend behavior |
|---|---|---|
| P2 | Should the `/notifications` history table have an event producer, or should the bell be explicitly feed-only? | The pulled API exposes `GET /notifications` and `POST /notifications/seen`, but there is no code writing history rows. The bell displays any history rows and also aggregates real YT/Ani feed items, so it is useful without fabricated events. |
| P2 | Is notification type meant to be configurable per domain/subdomain, in addition to per channel subscription? | The current API supports Track/Wordscan/Playlist/Random per channel and category Active/Inactive, add, rename, delete, and assignment. There is no category-level notification mode field/route; the frontend does not fake one. |
| P3 | Keep the current Ani progress model, or later support out-of-order per-episode history? | The pulled API supports the requested cursor (season/episode/seconds), watched seasons, season ranges, and Complete All. The UI uses these real operations and does not present local-only per-episode checkboxes. Only add a per-episode record model if the product later requires watched history outside that cursor/season model. |

## Existing API consumed by the frontend

- Auth: `POST /auth/login`, `/signup`, `/logout` (logout invalidates the `dreamedia` cookie).
- Notification history: `GET /notifications`; `POST /notifications/seen`.
- YouTube intake/feed: `POST /yt/access/subscribe` with `{kind, link, words?, rank?}`; `GET /yt/feed/videos`, `/yt/feed/sidebar`, `/yt/feed/channels`; `POST /yt/access/videos/seen`.
- YouTube management: `POST /yt/access/channels/{id}/mode`, `/active`, `/label`, `/assign`, `/delete`; `GET /yt/access/categories`; `POST /yt/access/categories`, `/categories/rename`, `/categories/delete`, `/category/active`.
- Ani events/tracking: `GET /ani/feed/events`, `/ani/feed/management`; `POST /ani/access/events/seen`, `/track`, `/entries/{id}`, `/entries/{id}/cursor`, `/entries/{id}/range`, `/entries/{id}/watched-all`, `/entries/{id}/seasons/{season_no}/watched`, and `/entries/{id}/delete`.

Postgres, schema/migrations, media ingestion, auth, and durable state remain exclusively backend-owned. No frontend DB, demo fallback, or new backend implementation was added.
