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
3. **Import YouTube subscriptions** — open `youtube.com/feed/channels`, choose
   **Scan subscriptions**, review the channel count and preview, then explicitly
   choose **Import all**. The scan reads channel links from the active page and
   scrolls to load more; nothing is sent to DreaMedia before the import click.
   Existing DreaMedia sources are skipped without changing their mode or
   category. If the page does not reach a stable end, importing stays disabled.
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
   URL (`http://127.0.0.1:8123` by default) and token, then select **Save & ping**.
   The extension asks for access to only that backend host. **Enable site** asks
   separately for the selected site’s HTTP/HTTPS host access.

## Popup

- **Current site** shows whether the site is enabled, paused, or not enabled.
  Add a new site as Anime or YouTube, then reload its tab. Manage paused
  sites in **Ext → Sites** in DreaMedia.
- **Source** follows a YouTube channel (Track, WordScan, Random, or Withhold)
  or a page with a playlist link (Playlist). Withhold batches uploads until
  the chosen threshold is reached.
- **Categories** are optional. Existing YouTube domains and their own
  subdomains are suggested from DreaMedia; choose both names or neither.
  Entering a new domain/subdomain pair creates it when the source is added.
- **Import subscriptions** is available on YouTube’s channel subscriptions
  page. Choose a notification mode and optional category first; the batch
  applies them only to channels not already in DreaMedia.
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

The background worker/page is the only network lane: content and popup scripts
message it, it calls `http://<backend>/ext/graphql` over HTTP with
`X-DreaMedia-Token`, and sends live progress over the same route using the
`graphql-transport-ws` subprotocol. The 20-second client ping keeps an idle
service worker active; the popup shows green only after the socket's authenticated
`extPing` query succeeds.
