# Backend TODO — frontend contract review

No backend source code or schema has been changed. The frontend consumes the supplied FastAPI API as it exists; the tasks below are proposals for backend-owner review.

| Priority | Requested backend work | Why the frontend needs it |
|---|---|---|
| P1 | Resolve pasted YouTube channel URLs (`/@handle`, `/featured`, `/videos`) and playlist URLs in `POST /yt/access/subscribe`, returning canonical channel ID/name/URL or playlist ID. | The current route requires `kind`, `link`, `channel_name`, and `channel_url`; Track/Wordscan need a channel ID, and Playlist needs a list ID. |
| P1 | Add stable `video_id` and `channel_id` to `GET /yt/feed/videos`; add one/bulk ownership-checked `POST` for `yt_videos.seen`. | The current feed returns `seen` but omits IDs and has no write route, so the YouTube Todo list is read-only. |
| P1 | Extend `GET /yt/feed/channels` to report all four subscription modes plus `active`, rank/frequency, and Wordscan terms. | The current view only joins `yt_tracking`; Playlist/Random rows can return `kind: null`, and active/rule values are absent. |
| P1 | Add a safe ownership-checked subscription mode/rules update and separate channel active/inactive endpoint. Make switching modes transactional so stale rows are not left across `yt_tracking`, `yt_playlists`, and `yt_randomsubs`. | Existing `POST /subscribe` adds/updates mode-specific rows but does not provide a unified, exclusive type-switch or active-state API. |
| P1 | Add domain/subdomain list-all (including unused), create, rename, and delete routes. | Current sidebar only exposes categories associated with channels; assignment can create categories and category activation exists, but no standalone CRUD or quick rename exists. |
| P1 | Add `entry_id` to `GET /ani/feed/events` and an ownership-checked seen-state mutation. | Current Ani events have `seen` but cannot be marked seen through REST and cannot reliably link back to the tracked anime. |
| P1 | Persist an independent Ani `canon_only` preference and expose it in management reads and entry updates. | The current `label` field is lifecycle state (`none/completed/blocked`) and should not be repurposed as a canon preference. |
| P1 | Fix `POST /auth/logout` to read the `dreamedia` session cookie instead of a query parameter. | The frontend can clear its own session view and browser cookie, but the current handler cannot invalidate the server-side token from a normal cookie-authenticated request. |
| P2 | Extend Ani management reads with season title and cover/release metadata. | Current management response has counts, state, and watched flags, but omits display metadata. |
| P2 | Decide whether per-episode watched records belong in the backend model/API. | Current Anime API supports season-level watched and entry-level `last_watched_episode` only. The frontend uses those existing semantics. |

The UI currently supports existing API operations only: auth, notification/feed reads, YouTube subscribe, channel labels/assignment/delete, category activation, Ani tracking, entry updates, season watched state, and entry deletion. Missing writes are not represented as locally persisted changes.
