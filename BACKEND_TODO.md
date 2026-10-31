# Backend follow-ups — reviewed against pulled upstream

The user requested a backend TODO for review and explicitly asked that backend implementation remain their team's responsibility. On 2026-10-31 the existing GitHub `main` was pulled through upstream commit `b8f2aeb70ad028fc86b0e6b7877a31a937ba2c98` (“Frontend contract acceptance…”). That upstream commit implements URL resolution, read/write IDs, seen state, mode switching, channel activity, category CRUD, Ani cursor/range/Canon fields, and logout-cookie handling. This task did not author or modify those backend changes.

## Remaining contract questions

| Priority | Follow-up | Current behavior / frontend handling |
|---|---|---|
| P2 | Add a backend producer for rows in the `/notifications` history table, or define whether the bell should only aggregate YouTube/Ani source feeds. | The pulled backend exposes `GET /notifications` and `POST /notifications/seen`, but a repository search found no code inserting into `notifications`. The frontend bell therefore also includes real feed items and shows any history records that do exist. |
| P2 | Decide whether arbitrary per-episode watched history is desired. | The current API deliberately models a forward-only `(season, episode, position_seconds)` cursor, season-level watched flags, ranges, and Complete All. The frontend uses that contract and does not claim out-of-order per-episode checkboxes. |
| P2 | Define category-level notification-type configuration if it is still required. | Current category APIs support active/inactive, create, rename, delete, and assignment. Notification modes belong to channel subscriptions; there is no separate category notification-type field or endpoint. The frontend does not fake one. |

## Pulled endpoints used by the frontend

- YouTube URL intake and server-side resolution: `POST /yt/access/subscribe` with `{kind, link, words?, rank?}`; accepted channel handles/URLs and playlist URLs are resolved by the backend.
- YouTube feed identity/read state: `GET /yt/feed/videos`, `GET /yt/feed/sidebar`, `GET /yt/feed/channels`; `POST /yt/access/videos/seen`.
- YouTube management: `POST /yt/access/channels/{id}/mode`, `/active`, `/label`, `/assign`, and `/delete`; `GET /yt/access/categories`; `POST /yt/access/categories`, `/categories/rename`, `/categories/delete`, and `/category/active`.
- Notification history: `GET /notifications`; `POST /notifications/seen`.
- Ani events and tracking: `GET /ani/feed/events`, `GET /ani/feed/management`; `POST /ani/access/events/seen`, `/track`, `/entries/{id}`, `/entries/{id}/cursor`, `/entries/{id}/range`, `/entries/{id}/watched-all`, `/entries/{id}/seasons/{season_no}/watched`, and `/entries/{id}/delete`.
- Auth: `POST /auth/login`, `/signup`, `/logout`; logout reads and invalidates the `dreamedia` cookie.

The original DreaMedia FastAPI/Postgres service remains authoritative. No duplicate database, mock fallback, or backend schema is added by this frontend.
