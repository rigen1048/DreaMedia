# DreaMedia Extension (D55)

Site-agnostic watch tracking + subscribe-from-page, for Chrome (MV3) and Firefox (MV2).

## What it does

1. **Watch tracking (SyncNwatch model)** — the content script reads the page
   title for anime matching and infers the episode from explicit URL episode
   fields/segments, then reports the attached `<video>` timestamp every 5s
   (and on pause/ended). The popup shows the matched anime, estimated season/
   episode, and playback time. When a URL has no episode hint, title/cursor
   matching is used and an ended video advances the estimate.
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
   The whole scan is one durable PostgreSQL job. Eight per-user YouTube workers
   pace only network fetches (one-second stagger; two-second rest after a fetch);
   filtering and source writes are outside that lane, and imported sources enter
   the normal media-fetch queue. The popup stores job IDs only for progress and
   can submit another batch while earlier jobs run.
   A background job reports resolved and fully processed counts separately,
   and the popup can be closed and reopened while processing continues. Scan
   again if the page does not reach a stable end.
4. **Add the current video to a playlist card.**

## Setup

1. In DreaMedia (web): open **Ext → Token** and select **Issue new token**. The raw
   token is shown once — copy it.
2. From the repository root, build both browser packages:
   `python3 setup.py --build-extensions-only`.
3. Load the generated extension:
   - **Chrome/Edge/Brave**: `chrome://extensions` → Developer mode →
     "Load unpacked" → pick `Extension/dist/mv3/`.
   - **Firefox**: `about:debugging#/runtime/this-firefox` →
     "Load Temporary Add-on" → pick `Extension/dist/mv2/manifest.json`.
4. Open the popup’s **Connection settings** (gear icon). Enter your backend
   URL (`http://127.0.0.1:8123` by default) and token, then select **Save & connect**.
   The footer reports the authenticated WebSocket connection state.
   The browser asks once for HTTP/HTTPS access to all sites at installation;
   the extension registers tracking scripts only on enabled domains. YouTube.com
   is enabled by default; DreaMedia and the extension share the same site list.

## Popup

- **Current site** shows whether the site is enabled, paused, or not enabled.
  Add a new site as Anime or YouTube; tracking activates automatically on open
  matching tabs and future navigations. Manage paused
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
  channel subscriptions page to scan and preview; **Add source** submits the
  complete scan once as a durable backend batch with the selected notification
  type, settings, and category. You can submit another batch while earlier jobs
  run. The extension stores job IDs only to restore progress when the popup
  reopens; fetching and queueing are backend responsibilities.
- **Save video** adds the active YouTube video to a custom playlist in Todo.
- On enabled Anime sites, the extension automatically matches the page title
  to a tracked anime, estimates its episode from the URL, and shows the attached
  video's live time. Matching and progress state are isolated per tab.

This directory replaces `Extension/` in DreaMedia. The browser packages are
generated from one shared source tree; no frontend build is needed. The
surrounding Make project is a preview with sample data and is not needed by
either browser package.
The UI uses the dark zinc theme, `d/m` mark, and terminology from DreaMedia’s
current frontend (upstream revision `a906e3f`). See `LICENSE`
for the original AGPL-3.0 license.

## Files

- `shared/background/` — strict TypeScript classic-script runtime modules;
  numeric prefixes define their concatenation order in `setup.py`.
- `shared/modules/` — strict TypeScript content modules, compiled to JavaScript
  for each target package and dynamically registered only for enabled sites.
- `shared/` and `PopUI/` — TypeScript sources for the shared video core and
  popup, imports, and scan-table pages; Bun builds their browser bundles.
- `targets/mv2/manifest.json` and `targets/mv3/manifest.json` — the only
  browser-specific source files.
- `dist/mv2/` and `dist/mv3/` — generated, ignored loadable packages. Do not
  edit them; rebuild with `python3 setup.py --build-extensions-only`.
- After building, run `bun test Extension/tests/*.test.cjs` to exercise the
  generated content modules and popup/import-table bundles.

The background worker is the only backend network lane: content, popup, and
import manager scripts message it; all GraphQL queries and mutations use one
persistent `graphql-transport-ws` connection to `/ext/graphql`. The extension
sends its token once in `connection_init`; the backend validates it for the
socket and reuses that identity until the connection closes. The worker sends a ping every
20 seconds and requires the server's pong within 10 seconds. The popup shows green
only for an authenticated, responsive socket; it shows yellow while reconnecting
and red only after a 30-second outage. The socket starts only while at least one
open tab matches an enabled site, and closes when no enabled tabs remain. The
popup's explicit **Enable site** action is the only bootstrap exception.
