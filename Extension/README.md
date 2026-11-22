# DreaMedia Extension (D55)

Site-agnostic watch tracking + subscribe-from-page, for Chrome (MV3) and Firefox (MV2).

## What it does

1. **Watch tracking (SyncNwatch model)** — the content script finds the playing
   `<video>` on enabled sites, and reports the timestamp to DreaMedia every 5s
   (and on pause/ended). Bind the tab to a tracked anime from the popup; an
   ended video advances the episode.
2. **Subscribe from the page (HydraTracker model)** — add a YouTube channel or
   playlist to your feed without opening DreaMedia. The backend resolves the
   active tab’s URL.
3. **Add scanned YouTube subscriptions** — open `youtube.com/feed/channels`,
   choose **Scan subscriptions**, review the channel count and preview, then use
   the same **Add source** action as a single channel. The selected source type,
   options, and category apply to every channel. The scan reads links from the
   active page and scrolls to load more; nothing is sent to DreaMedia before the
   Add sources click. Existing DreaMedia sources are skipped without changing
   their mode or category. The backend first resolves channel metadata, then
   separately writes each resolved source through the same Add Source path.
   PostgreSQL globally caps resolution at eight concurrent requests (250ms
   start spacing; each request slot cools down for two seconds before reuse)
   and source processing at 16 concurrent operations across backend containers.
   A background job reports resolved and fully processed counts separately,
   and the popup can be closed and reopened while processing continues. Scan
   again if the page does not reach a stable end.
4. **Add the current video to a playlist card.**

## Setup

1. In DreaMedia (web): open **Ext → Token** and select **Issue new token**. The raw
   token is shown once — copy it.
2. Load the extension:
   - **Chrome/Edge/Brave**: `chrome://extensions` → Developer mode →
     "Load unpacked" → pick `mv3/`.
   - **Firefox**: `about:debugging#/runtime/this-firefox` →
     "Load Temporary Add-on" → pick `mv2/manifest.json`.
3. Open the popup’s **Connection settings** (gear icon). Enter your backend
   URL (`http://127.0.0.1:8123` by default) and token, then select **Save & connect**.
   The footer reports the authenticated WebSocket connection state.
   The browser asks once for HTTP/HTTPS access to all sites at installation;
   the extension registers tracking scripts only on enabled domains. YouTube.com
   is enabled by default; DreaMedia and the extension share the same site list.

## Popup

- **Current site** shows whether the site is enabled, paused, or not enabled.
  Add a new site as Anime or YouTube, then reload its tab. Manage paused
  sites in **Ext → Sites** in DreaMedia. Changes sync on connection and every
  five minutes while an enabled site is open; open an enabled site (YouTube by
  default) to sync when no allowed tab is currently open.
- **Source** follows a YouTube channel (Track, WordScan, Random, or Withhold)
  or a page with a playlist link (Playlist). Withhold batches uploads until
  the chosen threshold is reached.
- **Categories** are optional. Existing YouTube domains and their own
  subdomains are suggested from DreaMedia; choose both names or neither.
  Entering a new domain/subdomain pair creates it when the source is added.
- **Scan subscriptions** is available in the **Source** tab. Open YouTube’s
  channel subscriptions page to scan and preview; the **Add source** button
  then queues those channels using the selected notification type, settings,
  and category. Processing continues in the backend and progress is restored
  the next time the popup is opened.
- **Save video** adds the active YouTube video to a custom playlist in Todo.
- **Bind anime** lets you manually link the tab to a tracked anime and set the
  season and episode. It does not replace automatic matching on enabled sites.

This directory replaces `Extension/` in DreaMedia. `mv2/` and `mv3/` are
ready to load without a frontend build. The surrounding Make project is a
preview with sample data and is not needed by either browser package.
The UI uses the dark zinc theme, `d/m` mark, and terminology from DreaMedia’s
current frontend (upstream revision `a906e3f`). See `LICENSE`
for the original AGPL-3.0 license.

## Files

- `shared/` — the single source of truth (content/popup/background).
- `mv3/`, `mv2/` — loadable packages (variant manifests/icons + synchronized
  copies of the shared source).
- After editing `shared/`, run `python3 setup.py --build-extensions-only` to
  synchronize both packages without starting or resetting the DreaMedia stack.

The background worker is the only backend network lane: content and popup
scripts message it, and all GraphQL queries and mutations use one persistent
`graphql-transport-ws` connection to `/ext/graphql`. The extension sends its
token once in `connection_init`; the backend validates it for the socket and
reuses that identity until the connection closes. The worker sends a ping every
20 seconds and requires the server's pong within 10 seconds. The popup shows green
only for an authenticated, responsive socket; it shows yellow while reconnecting
and red only after a 30-second outage. The socket starts only while at least one
open tab matches an enabled site, and closes when no enabled tabs remain. The
popup's explicit **Enable site** action is the only bootstrap exception.
